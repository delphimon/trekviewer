import * as THREE from 'three';
import type { TerrainResult } from './TerrainGenerator.ts';
import { type ElevationGrid, ElevationTileService } from './ElevationTiles.ts';
import { LocalTerrainChunk } from './LocalTerrainChunk.ts';
import type { RouteGeometry } from '../visualization/RouteGeometry.ts';
import { type QualityProfile, QualityProfileManager } from './QualityProfile.ts';
import type { ViewMode } from '../gpx/TrackTypes.ts';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

export interface LocalTerrainStreamerOptions {
  terrainResult: TerrainResult;
  routeGeometry: RouteGeometry;
  demGrid: ElevationGrid;
  qualityProfile?: QualityProfile;
  chunkRadiusM?: number;
  maxChunks?: number;
  evalThresholdM?: number;
  initialViewMode?: ViewMode;
}

/**
 * LocalTerrainStreamer (Stage W6 & X2)
 *
 * Implements rolling multi-chunk streaming of high-resolution local DEM geometry
 * (1000–1500m radius) along the active hiking route without geometry seams.
 *
 * Stage X2:
 * - Asynchronously acquires real high-resolution DEM tiles (prefer Terrarium z15, fallback z14).
 * - Caches and reuses DEM tiles and grids across stations.
 * - Prefetches ahead station DEM in background before hiker arrival.
 *
 * Stage X3:
 * - Enforces single visible chunk ownership: Station 0 is mesh.visible = true,
 *   while prefetched and retained chunks remain memory-warm with mesh.visible = false.
 * - Shares base terrain map texture and tileGrid bounds to eliminate gray placeholder material.
 *
 * Stage X3.1:
 * - ViewMode awareness: in 'diorama' mode all local chunks are hidden; base terrain is 100% authoritative.
 * - Transactional promotion: candidates built offscreen, validated, and promoted atomically.
 */
export class LocalTerrainStreamer {
  public readonly terrainResult: TerrainResult;
  public readonly routeGeometry: RouteGeometry;
  public readonly demGrid: ElevationGrid;
  public qualityProfile: QualityProfile;
  public chunkRadiusM: number;
  public readonly maxChunks: number;
  public readonly evalThresholdM: number;

  private currentViewMode: ViewMode = 'diorama';
  private managedChunks: LocalTerrainChunk[] = [];
  private lastTabletopFocusGeo: { lat: number; lon: number } | null = null;
  private tabletopChunk: LocalTerrainChunk | null = null;
  private lastEvalProgress: number = -1;
  private currentExaggeration: number = 1.0;
  private isDisposed: boolean = false;
  private stationDemCache: Map<string, ElevationGrid> = new Map();
  private pendingFetches: Map<string, Promise<ElevationGrid | null>> = new Map();

  constructor(options: LocalTerrainStreamerOptions) {
    this.terrainResult = options.terrainResult;
    this.routeGeometry = options.routeGeometry;
    this.demGrid = options.demGrid;
    this.qualityProfile =
      options.qualityProfile || QualityProfileManager.getActiveProfile();
    this.chunkRadiusM =
      options.chunkRadiusM ?? this.qualityProfile.localTerrainRadiusM;
    this.maxChunks = options.maxChunks ?? 3;
    this.evalThresholdM = options.evalThresholdM ?? 30; // 30m progress threshold
    this.currentViewMode = options.initialViewMode ?? 'diorama';
  }

  public get activeChunks(): readonly LocalTerrainChunk[] {
    if (this.tabletopChunk) {
      return [...this.managedChunks, this.tabletopChunk];
    }
    return this.managedChunks;
  }

  public getViewMode(): ViewMode {
    return this.currentViewMode;
  }

  public getTabletopFocusGeo(): { lat: number; lon: number } | null {
    return this.lastTabletopFocusGeo;
  }

  public setViewMode(mode: ViewMode): void {
    if (this.isDisposed) return;
    const prevMode = this.currentViewMode;
    if (prevMode === mode) return;
    this.currentViewMode = mode;
    let affectedBounds: TerrainSurfaceBounds | undefined;

    if (mode === 'diorama') {
      // Switching to diorama: hide first-person chunks, reset lastTabletopFocusGeo
      for (const chunk of this.managedChunks) {
        if (chunk.mesh.visible) {
          affectedBounds = chunk.getSurfaceBounds();
        }
        chunk.mesh.visible = false;
      }
      this.lastTabletopFocusGeo = null;
      if (this.tabletopChunk) {
        this.terrainResult.detachLocalChunk?.(this.tabletopChunk);
        this.tabletopChunk = null;
      }
    } else if (mode === 'first-person') {
      // Switching to first-person: hide tabletop chunk, reset lastTabletopFocusGeo
      if (this.tabletopChunk) {
        affectedBounds = this.tabletopChunk.getSurfaceBounds();
        this.tabletopChunk.mesh.visible = false;
        this.terrainResult.detachLocalChunk?.(this.tabletopChunk);
        this.tabletopChunk = null;
      }
      this.lastTabletopFocusGeo = null;
      this.lastEvalProgress = -1;

      // In first-person mode, validate and show the active station 0 chunk
      for (let i = 0; i < this.managedChunks.length; i++) {
        if (i === 0) {
          const val = this.managedChunks[0].validate();
          this.managedChunks[0].mesh.visible = val.isValid;
          if (val.isValid) {
            affectedBounds = this.managedChunks[0].getSurfaceBounds();
          }
        } else {
          this.managedChunks[i].mesh.visible = false;
        }
      }
    }

    if (affectedBounds) {
      this.terrainResult.notifySurfaceChange?.(affectedBounds);
    }
  }

  /**
   * Returns the single currently active visible local chunk (Stage X3 & X7).
   * In diorama mode, returns the active tabletop inspection chunk if visible.
   */
  public get activeVisibleChunk(): LocalTerrainChunk | null {
    if (this.currentViewMode === 'diorama') {
      return this.tabletopChunk && this.tabletopChunk.mesh.visible ? this.tabletopChunk : null;
    }
    return this.managedChunks.find((c) => c.mesh.visible) ?? null;
  }

  public getStationKey(lat: number, lon: number): string {
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
  }

  /**
   * Fetches real high-resolution local DEM for station coordinates (Stage X2).
   */
  public async fetchStationDEM(lat: number, lon: number): Promise<ElevationGrid | null> {
    const key = this.getStationKey(lat, lon);
    const cached = this.stationDemCache.get(key);
    if (cached) return cached;

    let pending = this.pendingFetches.get(key);
    if (!pending) {
      pending = ElevationTileService.fetchLocalElevationGrid(
        lat,
        lon,
        this.chunkRadiusM,
        this.qualityProfile.localDemZoom,
        this.qualityProfile.localDemMaxTiles
      ).then((grid) => {
        if (grid) {
          if (this.stationDemCache.size >= 16) {
            const firstKey = this.stationDemCache.keys().next().value;
            if (firstKey) this.stationDemCache.delete(firstKey);
          }
          this.stationDemCache.set(key, grid);
        }
        this.pendingFetches.delete(key);
        return grid;
      }).catch(() => {
        this.pendingFetches.delete(key);
        return null;
      });
      this.pendingFetches.set(key, pending);
    }
    return pending;
  }

  private fetchAndApplyStationDEM(chunk: LocalTerrainChunk, lat: number, lon: number): void {
    this.fetchStationDEM(lat, lon).then((grid) => {
      if (this.isDisposed || !grid) return;
      const idx = this.managedChunks.indexOf(chunk);
      if (idx === -1) return;

      // Stage X3.1: Transactional promotion.
      // Build candidate offscreen, validate heights and finite values, and swap atomically.
      const mat = this.terrainResult.terrainMesh?.material as THREE.MeshStandardMaterial | undefined;
      const candidate = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: lat,
        centerLon: lon,
        referenceCenterLat:
          this.terrainResult.terrainGeoBounds?.centerLat ?? lat,
        referenceCenterLon:
          this.terrainResult.terrainGeoBounds?.centerLon ?? lon,
        terrainBaseElevation: this.terrainResult.terrainBaseElevation,
        radiusMeters: this.chunkRadiusM,
        segments: this.qualityProfile.localDemSegments,
        baseElevationSampler: (x, z) =>
          this.terrainResult.elevationSampler(x, z),
        initialExaggeration: this.currentExaggeration,
        tileGrid: this.terrainResult.tileGrid,
        mapTexture: mat?.map ?? null,
      });

      const val = candidate.validate();
      if (!val.isValid) {
        console.warn('[LocalTerrainStreamer] Candidate chunk rejected by validation:', val.reason);
        candidate.dispose();
        return;
      }

      // Re-verify chunk still managed after async build
      const currentIdx = this.managedChunks.indexOf(chunk);
      if (currentIdx === -1) {
        candidate.dispose();
        return;
      }

      const isStation0 = (currentIdx === 0);
      candidate.mesh.visible = (this.currentViewMode === 'first-person' && isStation0);
      this.terrainResult.attachLocalChunk?.(candidate);
      this.managedChunks[currentIdx] = candidate;
      this.terrainResult.detachLocalChunk?.(chunk);
    });
  }

  public setQualityProfile(profile: QualityProfile): void {
    if (this.isDisposed) return;
    this.qualityProfile = profile;
    this.chunkRadiusM = profile.localTerrainRadiusM;
  }

  public getQualityProfile(): QualityProfile {
    return this.qualityProfile;
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed) return;
    this.currentExaggeration = factor;
    for (const chunk of this.managedChunks) {
      chunk.setVerticalExaggeration(factor);
    }
    if (this.tabletopChunk) {
      this.tabletopChunk.setVerticalExaggeration(factor);
    }
  }

  /**
   * Updates streaming stations along the route based on hiker progress [0, 1],
   * or updates tabletop inspection focus in diorama mode (Stage X7).
   */
  public update(
    currentProgress: number,
    tabletopFocusGeo?: { lat: number; lon: number } | null
  ): void {
    if (this.isDisposed || !this.demGrid) return;

    if (this.currentViewMode === 'diorama') {
      this.updateTabletopFocus(tabletopFocusGeo);
    }

    const totalDist = this.routeGeometry.totalDistance;
    if (totalDist <= 0) return;

    const progressDistMoved =
      this.lastEvalProgress >= 0
        ? Math.abs(currentProgress - this.lastEvalProgress) * totalDist
        : Infinity;

    if (progressDistMoved < this.evalThresholdM && this.managedChunks.length > 0) {
      return;
    }
    this.lastEvalProgress = currentProgress;

    const hikerTele = this.routeGeometry.getTelemetryAtProgress(currentProgress);
    const hikerDist = currentProgress * totalDist;

    // Station spacing: ~90% of radius to maintain 20-30% continuous overlap between adjacent chunks
    const stationSpacing = this.chunkRadiusM * 0.9;

    const stationDistances: number[] = [hikerDist];
    if (hikerDist + stationSpacing <= totalDist + stationSpacing * 0.5) {
      stationDistances.push(Math.min(totalDist, hikerDist + stationSpacing));
    }
    if (hikerDist - stationSpacing >= -stationSpacing * 0.5) {
      stationDistances.push(Math.max(0, hikerDist - stationSpacing));
    }

    // Ensure stations are ordered: current position first, then ahead, then behind
    const stationCoords = stationDistances.map((dist) => {
      const prog = Math.max(0, Math.min(1, dist / totalDist));
      const tele = this.routeGeometry.getTelemetryAtProgress(prog);
      return {
        lat: tele.currentPoint.lat,
        lon: tele.currentPoint.lon,
        dist,
      };
    });

    const neededChunks: LocalTerrainChunk[] = [];
    const availableChunks = [...this.managedChunks];

    for (const station of stationCoords) {
      // Find existing chunk closest to this station
      let bestIdx = -1;
      let bestDist = Infinity;

      for (let i = 0; i < availableChunks.length; i++) {
        const c = availableChunks[i];
        const latDiff = (c.centerLat - station.lat) * 111320;
        const lonDiff =
          (c.centerLon - station.lon) *
          111320 *
          Math.cos((station.lat * Math.PI) / 180);
        const d = Math.hypot(latDiff, lonDiff);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }

      // If an existing chunk is within 60% of radius, reuse it
      if (bestIdx !== -1 && bestDist <= this.chunkRadiusM * 0.6) {
        neededChunks.push(availableChunks[bestIdx]);
        availableChunks.splice(bestIdx, 1);
      } else {
        // Create new chunk (using cached high-res DEM if available, or fallback to route demGrid)
        const stationKey = this.getStationKey(station.lat, station.lon);
        const cachedGrid = this.stationDemCache.get(stationKey);
        const initialGrid = cachedGrid || this.demGrid;

        const mat = this.terrainResult.terrainMesh?.material as THREE.MeshStandardMaterial | undefined;
        const newChunk = new LocalTerrainChunk({
          localGrid: initialGrid,
          centerLat: station.lat,
          centerLon: station.lon,
          referenceCenterLat:
            this.terrainResult.terrainGeoBounds?.centerLat ?? station.lat,
          referenceCenterLon:
            this.terrainResult.terrainGeoBounds?.centerLon ?? station.lon,
          terrainBaseElevation: this.terrainResult.terrainBaseElevation,
          radiusMeters: this.chunkRadiusM,
          segments: this.qualityProfile.localDemSegments,
          baseElevationSampler: (x, z) =>
            this.terrainResult.elevationSampler(x, z),
          initialExaggeration: this.currentExaggeration,
          tileGrid: this.terrainResult.tileGrid,
          mapTexture: mat?.map ?? null,
        });

        this.terrainResult.attachLocalChunk?.(newChunk);
        neededChunks.push(newChunk);

        // Asynchronously fetch and apply real Terrarium high-res DEM (Stage X2)
        if (!newChunk.isRealHighRes) {
          this.fetchAndApplyStationDEM(newChunk, station.lat, station.lon);
        }
      }
    }

    // Prefetch real DEM for candidate stations along the corridor (including ahead of hiker)
    for (const station of stationCoords) {
      const key = this.getStationKey(station.lat, station.lon);
      if (!this.stationDemCache.has(key) && !this.pendingFetches.has(key)) {
        this.fetchStationDEM(station.lat, station.lon);
      }
    }

    // Available chunks not needed for the current stations are candidates for eviction
    // Enforce maxChunks budget
    while (neededChunks.length + availableChunks.length > this.maxChunks) {
      if (availableChunks.length > 0) {
        const staleChunk = availableChunks.pop()!;
        this.terrainResult.detachLocalChunk?.(staleChunk);
      } else {
        // If neededChunks itself exceeds maxChunks, trim furthest from hiker
        neededChunks.sort((a, b) => {
          const distA = Math.hypot(
            a.localCenter.x - hikerTele.position.x,
            a.localCenter.z - hikerTele.position.z
          );
          const distB = Math.hypot(
            b.localCenter.x - hikerTele.position.x,
            b.localCenter.z - hikerTele.position.z
          );
          return distA - distB;
        });
        const excess = neededChunks.pop()!;
        this.terrainResult.detachLocalChunk?.(excess);
      }
    }

    const prevVisibleChunk = this.managedChunks.find((c) => c.mesh.visible);

    // Ensure only the active hiker station chunk is visible in first-person mode (Stage X3 & X3.1)
    for (let i = 0; i < neededChunks.length; i++) {
      if (this.currentViewMode === 'first-person' && i === 0) {
        const val = neededChunks[0].validate();
        neededChunks[0].mesh.visible = val.isValid;
      } else {
        neededChunks[i].mesh.visible = false;
      }
    }
    for (const chunk of availableChunks) {
      chunk.mesh.visible = false;
    }

    const newVisibleChunk = neededChunks[0]?.mesh.visible ? neededChunks[0] : null;
    if (prevVisibleChunk !== newVisibleChunk && newVisibleChunk) {
      this.terrainResult.notifySurfaceChange?.(newVisibleChunk.getSurfaceBounds());
    }

    this.managedChunks = [...neededChunks, ...availableChunks];
  }

  private updateTabletopFocus(tabletopFocusGeo?: { lat: number; lon: number } | null): void {
    if (!tabletopFocusGeo) return;

    // Hysteresis: check distance from lastTabletopFocusGeo
    if (this.lastTabletopFocusGeo) {
      const latDiff = (tabletopFocusGeo.lat - this.lastTabletopFocusGeo.lat) * 111320;
      const lonDiff =
        (tabletopFocusGeo.lon - this.lastTabletopFocusGeo.lon) *
        111320 *
        Math.cos((tabletopFocusGeo.lat * Math.PI) / 180);
      const dist = Math.hypot(latDiff, lonDiff);
      if (dist < 75 && this.tabletopChunk && this.tabletopChunk.mesh.visible) {
        return; // Within hysteresis threshold (< 75m)
      }
    }

    this.lastTabletopFocusGeo = { ...tabletopFocusGeo };
    const focusLat = tabletopFocusGeo.lat;
    const focusLon = tabletopFocusGeo.lon;

    this.fetchStationDEM(focusLat, focusLon).then((grid) => {
      if (this.isDisposed || this.currentViewMode !== 'diorama') return;

      // Verify this is still the active focus
      if (
        !this.lastTabletopFocusGeo ||
        Math.hypot(
          (this.lastTabletopFocusGeo.lat - focusLat) * 111320,
          (this.lastTabletopFocusGeo.lon - focusLon) * 111320 * Math.cos((focusLat * Math.PI) / 180)
        ) > 75
      ) {
        return;
      }

      const initialGrid = grid || this.demGrid;
      const mat = this.terrainResult.terrainMesh?.material as THREE.MeshStandardMaterial | undefined;
      const candidate = new LocalTerrainChunk({
        localGrid: initialGrid,
        centerLat: focusLat,
        centerLon: focusLon,
        referenceCenterLat:
          this.terrainResult.terrainGeoBounds?.centerLat ?? focusLat,
        referenceCenterLon:
          this.terrainResult.terrainGeoBounds?.centerLon ?? focusLon,
        terrainBaseElevation: this.terrainResult.terrainBaseElevation,
        radiusMeters: this.chunkRadiusM,
        segments: this.qualityProfile.localDemSegments,
        baseElevationSampler: (x, z) =>
          this.terrainResult.elevationSampler(x, z),
        initialExaggeration: this.currentExaggeration,
        blendMarginRatio: 0.15,
        tileGrid: this.terrainResult.tileGrid,
        mapTexture: mat?.map ?? null,
      });

      const val = candidate.validate();
      if (!val.isValid) {
        console.warn('[LocalTerrainStreamer] Tabletop candidate chunk rejected by validation:', val.reason);
        candidate.dispose();
        return;
      }

      if (this.isDisposed || this.currentViewMode !== 'diorama') {
        candidate.dispose();
        return;
      }

      // Atomically promote candidate
      candidate.mesh.visible = true;
      this.terrainResult.attachLocalChunk?.(candidate);

      const oldTabletop = this.tabletopChunk;
      this.tabletopChunk = candidate;

      if (oldTabletop && oldTabletop !== candidate) {
        this.terrainResult.detachLocalChunk?.(oldTabletop);
      }

      this.terrainResult.notifySurfaceChange?.(candidate.getSurfaceBounds());
    });
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.pendingFetches.clear();
    this.stationDemCache.clear();
    if (this.tabletopChunk) {
      this.terrainResult.detachLocalChunk?.(this.tabletopChunk);
      this.tabletopChunk = null;
    }
    for (const chunk of this.managedChunks) {
      this.terrainResult.detachLocalChunk?.(chunk);
    }
    this.managedChunks = [];
  }
}
