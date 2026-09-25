import * as THREE from 'three';
import type { TerrainResult } from './TerrainGenerator.ts';
import { type ElevationGrid, ElevationTileService } from './ElevationTiles.ts';
import { LocalTerrainChunk } from './LocalTerrainChunk.ts';
import type { RouteGeometry } from '../visualization/RouteGeometry.ts';
import { type QualityProfile, QualityProfileManager } from './QualityProfile.ts';

export interface LocalTerrainStreamerOptions {
  terrainResult: TerrainResult;
  routeGeometry: RouteGeometry;
  demGrid: ElevationGrid;
  qualityProfile?: QualityProfile;
  chunkRadiusM?: number;
  maxChunks?: number;
  evalThresholdM?: number;
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
 */
export class LocalTerrainStreamer {
  public readonly terrainResult: TerrainResult;
  public readonly routeGeometry: RouteGeometry;
  public readonly demGrid: ElevationGrid;
  public qualityProfile: QualityProfile;
  public chunkRadiusM: number;
  public readonly maxChunks: number;
  public readonly evalThresholdM: number;

  private managedChunks: LocalTerrainChunk[] = [];
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
  }

  public get activeChunks(): readonly LocalTerrainChunk[] {
    return this.managedChunks;
  }

  /**
   * Returns the single currently active visible local chunk (Stage X3).
   */
  public get activeVisibleChunk(): LocalTerrainChunk | null {
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
      if (this.managedChunks.includes(chunk)) {
        chunk.updateElevationGrid(grid, (x, z) => this.terrainResult.elevationSampler(x, z));
      }
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
  }

  /**
   * Updates streaming stations along the route based on hiker progress [0, 1].
   */
  public update(currentProgress: number): void {
    if (this.isDisposed || !this.demGrid) return;

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

    // Ensure only the active hiker station chunk is visible to prevent z-fighting and elevation ambiguity (Stage X3)
    for (let i = 0; i < neededChunks.length; i++) {
      neededChunks[i].mesh.visible = (i === 0);
    }
    for (const chunk of availableChunks) {
      chunk.mesh.visible = false;
    }

    this.managedChunks = [...neededChunks, ...availableChunks];
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.pendingFetches.clear();
    this.stationDemCache.clear();
    for (const chunk of this.managedChunks) {
      this.terrainResult.detachLocalChunk?.(chunk);
    }
    this.managedChunks = [];
  }
}
