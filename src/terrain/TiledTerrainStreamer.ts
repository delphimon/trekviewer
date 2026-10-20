import * as THREE from 'three';
import { geoToLocalMeters, localMetersToGeo } from '../gpx/Coordinates.ts';
import type { ViewMode } from '../gpx/TrackTypes.ts';
import { ElevationTileService, type ElevationGrid } from './ElevationTiles.ts';
import { LocalTerrainChunk } from './LocalTerrainChunk.ts';
import type { LocalTerrainStreamerOptions } from './LocalTerrainStreamer.ts';
import type { QualityProfile } from './QualityProfile.ts';
import { QualityProfileManager, terrainDetailPolicy } from './QualityProfile.ts';
import { planTerrainTiles, selectTerrainFocus, type TerrainTileLayout } from './TerrainTileLayout.ts';

interface ElevationAcquisition {
  controller: AbortController;
  result: Promise<{ grid: ElevationGrid | null; error?: unknown }>;
  settled: boolean;
}

/** Stable terrain partitions, independent of gaze direction, with parent coverage until publication. */
export class TiledTerrainStreamer {
  private readonly chunks = new Map<string, LocalTerrainChunk>();
  private wanted = new Map<string, TerrainTileLayout>();
  private ready: { id: string; chunk: LocalTerrainChunk; generation: number; publish?: () => boolean } | null = null;
  private readyRemoval: { entries: [string, LocalTerrainChunk][]; generation: number; publish?: () => boolean } | null = null;
  private retireAll = false;
  private readonly lifetime = new AbortController();
  private busy = false;
  private disposed = false;
  private generation = 0;
  private mode: ViewMode;
  private exaggeration = 1;
  private profile: QualityProfile;
  private focus: { lat: number; lon: number } | null = null;
  private focusChanges = 0;
  private planKey = '';
  private plannedAt: { x: number; z: number } | null = null;
  private nextWorkAt = 0;
  private readonly failed = new Map<string, { attempts: number; retryAt: number }>();
  private routeProgress = NaN;
  private routeGeo: { lat: number; lon: number } | null = null;
  private focusLat = NaN;
  private focusLon = NaN;
  private localFocus: { x: number; z: number } | null = null;
  private detailFocusInput?: readonly { lat: number; lon: number }[];
  private detailFocusKey = '';
  private detailFocus: { x: number; z: number }[] = [];
  private readonly acquisitions = new Map<string, ElevationAcquisition>();
  private acquiringTile: string | null = null;
  private focusTileId: string | null = null;

  constructor(private readonly options: LocalTerrainStreamerOptions) {
    this.mode = options.initialViewMode ?? 'diorama';
    this.profile = options.qualityProfile ?? QualityProfileManager.getActiveProfile();
  }

  public get activeChunks(): readonly LocalTerrainChunk[] { return [...this.chunks.values()]; }
  public get chunkRadiusM(): number { return this.profile.localTerrainRadiusM; }
  public get activeVisibleChunk(): LocalTerrainChunk | null { return this.chunks.values().next().value ?? null; }
  public getViewMode(): ViewMode { return this.mode; }
  public getTabletopFocusGeo(): { lat: number; lon: number } | null { return this.focus; }
  public getTabletopFocusChangesTotal(): number { return this.focusChanges; }
  public getQualityProfile(): QualityProfile { return this.profile; }

  public setViewMode(mode: ViewMode): void {
    if (mode !== this.mode) this.generation++;
    this.mode = mode;
    this.planKey = '';
    this.plannedAt = null;
    this.nextWorkAt = 0;
  }

  public setQualityProfile(profile: QualityProfile): void {
    if (this.profile.name === profile.name) return;
    this.profile = profile;
    this.generation++;
    this.cancelAcquisitions();
    this.ready?.chunk.dispose();
    this.ready = null;
    this.readyRemoval = null;
    this.retireAll = this.chunks.size > 0;
    this.failed.clear();
    this.detailFocusInput = undefined; this.detailFocusKey = ''; this.detailFocus = [];
    this.planKey = '';
    this.plannedAt = null;
    this.nextWorkAt = 0;
  }

  public setVerticalExaggeration(factor: number): void {
    if (factor !== this.exaggeration) { this.generation++; this.nextWorkAt = 0; }
    this.exaggeration = factor;
    for (const chunk of this.chunks.values()) chunk.setVerticalExaggeration(factor);
    this.ready?.chunk.setVerticalExaggeration(factor);
  }

  public update(progress: number, tabletopFocus?: { lat: number; lon: number } | null, detailFocus?: readonly { lat: number; lon: number }[]): void {
    if (this.disposed || !this.options.terrainResult.baseMeshGrid) return;
    const terrain = this.options.terrainResult;
    if (!(this.mode === 'diorama' && tabletopFocus) && (!this.routeGeo || progress !== this.routeProgress)) {
      const point = this.options.routeGeometry.getTelemetryAtProgress(progress).currentPoint;
      this.routeGeo = { lat: point.lat, lon: point.lon };
      this.routeProgress = progress;
    }
    const geo = this.mode === 'diorama' && tabletopFocus ? tabletopFocus : this.routeGeo!;
    const center = terrain.terrainGeoBounds;
    if (!this.localFocus || geo.lat !== this.focusLat || geo.lon !== this.focusLon) {
      this.localFocus = geoToLocalMeters(geo.lat, geo.lon, 0, center.centerLat, center.centerLon, 0);
      this.focusLat = geo.lat; this.focusLon = geo.lon;
    }
    const local = this.localFocus;
    let detailChanged = false;
    if (detailFocus !== this.detailFocusInput) {
      this.detailFocusInput = detailFocus;
      const candidates = this.profile.name === 'quest-balanced' ? [] : (detailFocus ?? []).slice(0, 64).map(p => geoToLocalMeters(p.lat, p.lon, 0, center.centerLat, center.centerLon, 0));
      // Spread the bounded anchors across the whole view, rather than filling
      // every slot with several adjacent samples near the central ray.
      this.detailFocus = selectTerrainFocus(candidates, local);
      const grid = terrain.baseMeshGrid!;
      const key = [...new Set(this.detailFocus.map(p => `${Math.floor((p.x + grid.width / 2) / (grid.width / grid.segmentsX * 8))}:${Math.floor((p.z + grid.depth / 2) / (grid.depth / grid.segmentsZ * 8))}`))].sort().join('|');
      detailChanged = key !== this.detailFocusKey; this.detailFocusKey = key;
    }
    if (!this.plannedAt || detailChanged || Math.hypot(local.x - this.plannedAt.x, local.z - this.plannedAt.z) >= 60) {
      this.plannedAt = { x: local.x, z: local.z };
      const policy = terrainDetailPolicy(this.profile);
      const plan = planTerrainTiles({
        parent: terrain.baseMeshGrid!, focusX: local.x, focusZ: local.z,
        additionalFocus: this.detailFocus, ...policy, parentCellsPerTile: 8,
      });
      const key = plan.tiles.map(tile => tile.id).sort().join('|');
      // Membership can stay identical while the hiker crosses the footprint.
      // Always refresh acquisition order, without retiring retained terrain.
      this.wanted = new Map(plan.tiles.map(tile => [tile.id, tile]));
      this.focus = { lat: geo.lat, lon: geo.lon };
      this.focusTileId = plan.tiles.find(tile => local.x >= tile.bounds.minX && local.x <= tile.bounds.maxX
        && local.z >= tile.bounds.minZ && local.z <= tile.bounds.maxZ)?.id ?? null;
      this.nextWorkAt = 0;
      if (key !== this.planKey) {
        this.planKey = key;
        this.focusChanges++;
        for (const [id, entry] of this.acquisitions) if (!this.wanted.has(id)) {
          entry.controller.abort(); this.acquisitions.delete(id);
        }
        for (const id of this.failed.keys()) if (!this.wanted.has(id)) this.failed.delete(id);
        this.nextWorkAt = 0;
      }
    }
    if (this.readyRemoval) {
      const { entries, generation, publish } = this.readyRemoval;
      this.readyRemoval = null;
      this.nextWorkAt = 0;
      if (generation === this.generation && entries.every(([id, chunk]) => this.chunks.get(id) === chunk
        && (this.retireAll || !this.wanted.has(id))) && publish?.() !== false) {
        const bounds = entries.map(([, chunk]) => chunk.getSurfaceBounds());
        for (const [id, chunk] of entries) {
          chunk.mesh.visible = false;
          terrain.detachLocalChunk?.(chunk);
          this.chunks.delete(id);
        }
        this.retireAll = false;
        terrain.notifySurfaceChange?.({
          minX: Math.min(...bounds.map(b => b.minX)), maxX: Math.max(...bounds.map(b => b.maxX)),
          minZ: Math.min(...bounds.map(b => b.minZ)), maxZ: Math.max(...bounds.map(b => b.maxZ)),
        });
      }
    }
    // Publish at most one prepared child per frame. The parent fills every other cell.
    if (this.ready) {
      const { id, chunk, generation, publish } = this.ready;
      this.ready = null;
      this.nextWorkAt = 0;
      if (generation !== this.generation || !this.wanted.has(id)) chunk.dispose();
      else if (publish?.() === false) {
        // Imagery may arrive while its replacement geometry is being prepared.
        // Keep the validated DEM geometry and refresh only that preparation.
        this.busy = true; this.acquiringTile = id;
        void this.retrySurfacePromotion(id, chunk, generation);
      }
      else {
        const previous = this.chunks.get(id);
        chunk.setVerticalExaggeration(this.exaggeration);
        chunk.setMapTexture((terrain.terrainMesh.material as THREE.MeshStandardMaterial).map, terrain.tileGrid);
        chunk.mesh.visible = false;
        terrain.attachLocalChunk?.(chunk);
        if (previous) { previous.mesh.visible = false; terrain.detachLocalChunk?.(previous); }
        this.chunks.set(id, chunk);
        if (chunk.currentGrid?.preferredSourceRetry) this.recordFailure(id);
        else this.failed.delete(id);
        chunk.mesh.visible = true;
        terrain.notifySurfaceChange?.(chunk.getSurfaceBounds());
      }
    }
    this.prefetchElevation();
    if (!this.busy && !this.ready && !this.readyRemoval && performance.now() >= this.nextWorkAt) void this.prepareNext();
  }

  private prefetchElevation(): void {
    const terrain = this.options.terrainResult;
    const now = performance.now();
    // Keep network acquisition ahead of the single geometry/publication lane.
    // Resolved grids count toward the bound too; a slow promotion cannot grow it.
    const capacity = this.profile.name === 'quest-balanced' ? 1 : 3;
    const needsAcquisition = (id: string) => this.acquiringTile !== id && this.ready?.id !== id
      && (!this.chunks.has(id) || this.chunks.get(id)?.currentGrid?.preferredSourceRetry)
      && (this.failed.get(id)?.retryAt ?? 0) <= now;
    // Reserve admission for the current ground footprint. Keep completed grids
    // and the active geometry/publication job; replace at most one less urgent
    // unfinished download when every network slot was filled by an older view.
    const urgent = this.focusTileId;
    if (urgent && !this.acquisitions.has(urgent) && needsAcquisition(urgent) && this.acquisitions.size >= capacity) {
      const victim = [...this.wanted.keys()].reverse().find(id => {
        const entry = this.acquisitions.get(id);
        return entry && !entry.settled && id !== this.acquiringTile;
      });
      if (victim) { this.acquisitions.get(victim)!.controller.abort(); this.acquisitions.delete(victim); }
    }
    for (const tile of this.wanted.values()) {
      if (this.acquisitions.size >= capacity) break;
      if (this.acquisitions.has(tile.id) || !needsAcquisition(tile.id)) continue;
      const controller = new AbortController();
      const geo = localMetersToGeo((tile.bounds.minX + tile.bounds.maxX) / 2,
        (tile.bounds.minZ + tile.bounds.maxZ) / 2, terrain.terrainGeoBounds.centerLat, terrain.terrainGeoBounds.centerLon);
      const result = ElevationTileService.fetchLocalElevationGrid(geo.lat, geo.lon,
        Math.max(tile.width, tile.depth) / 2 + 100, 15, this.profile.localDemMaxTiles, controller.signal)
        .then(grid => ({ grid }), error => ({ grid: null, error }));
      const entry = { controller, result, settled: false };
      this.acquisitions.set(tile.id, entry);
      void result.then(() => { entry.settled = true; });
    }
  }

  private cancelAcquisitions(): void {
    for (const entry of this.acquisitions.values()) entry.controller.abort();
    this.acquisitions.clear();
  }

  private async retrySurfacePromotion(id: string, chunk: LocalTerrainChunk, generation: number): Promise<void> {
    try {
      const publish = await this.options.prepareSurfacePromotion?.(chunk, this.chunks.get(id));
      if (this.disposed || generation !== this.generation || !this.wanted.has(id)) chunk.dispose();
      else this.ready = { id, chunk, generation, publish };
    } catch (error) {
      chunk.dispose();
      if (!this.disposed && generation === this.generation) {
        this.recordFailure(id);
        console.warn('Terrain imagery preparation unavailable; retaining current coverage:', error);
      }
    } finally {
      this.acquiringTile = null;
      this.busy = false; this.nextWorkAt = 0;
    }
  }

  private async prepareNext(): Promise<void> {
    this.nextWorkAt = Infinity;
    const policy = terrainDetailPolicy(this.profile);
    if (this.retireAll && this.chunks.size) {
      this.busy = true;
      try {
        await this.prepareRetirement([...this.chunks.entries()], this.generation);
      } finally { this.busy = false; this.nextWorkAt = 0; }
      return;
    }
    const now = performance.now();
    const eligible: TerrainTileLayout[] = [];
    for (const wanted of this.wanted.values()) {
      const existing = this.chunks.get(wanted.id);
      if (existing && !existing.currentGrid?.preferredSourceRetry) continue;
      const retryAt = this.failed.get(wanted.id)?.retryAt ?? 0;
      if (retryAt <= now && this.acquisitions.has(wanted.id)) eligible.push(wanted);
      if (retryAt <= now) continue;
      this.nextWorkAt = Math.min(this.nextWorkAt, retryAt);
    }
    if (!eligible.length) return;
    this.busy = true;
    const generation = this.generation;
    let tile: TerrainTileLayout | undefined;
    let acquisition: ElevationAcquisition | undefined;
    let consumedAcquisition = false;
    try {
      if (!eligible.some(item => this.acquisitions.get(item.id)?.settled)) {
        // Wait for any bounded acquisition, not the first requested footprint.
        // A slow server response must not hold back already available terrain.
        await Promise.race(eligible.map(item => this.acquisitions.get(item.id)!.result));
      }
      if (this.disposed || generation !== this.generation) return;
      tile = [...this.wanted.values()].find(item => this.acquisitions.get(item.id)?.settled
        && (this.failed.get(item.id)?.retryAt ?? 0) <= performance.now()
        && (!this.chunks.has(item.id) || this.chunks.get(item.id)?.currentGrid?.preferredSourceRetry));
      if (!tile) return;
      this.acquiringTile = tile.id;
      acquisition = this.acquisitions.get(tile.id);
      if (!acquisition) return;
      consumedAcquisition = true;
      const { grid, error } = await acquisition.result;
      if (this.disposed || generation !== this.generation || !this.wanted.has(tile.id) || acquisition.controller.signal.aborted) return;
      if (error) throw error;
      if (!grid) { this.recordFailure(tile.id); return; }
      // Select the actual completed footprint before reserving resident space:
      // partial edge tiles can have a different vertex cost from their neighbors.
      let residentVertices = [...this.chunks.values()].reduce((n, chunk) => n + chunk.totalVertices, 0);
      let residentCount = this.chunks.size;
      const retiring = this.chunks.has(tile.id) ? [] : [...this.chunks.entries()].filter(([id, chunk]) => {
        if (this.wanted.has(id)) return false;
        if (residentCount + 1 <= policy.residentTiles && residentVertices + tile!.vertexCount <= policy.residentVertices) return false;
        residentCount--; residentVertices -= chunk.totalVertices; return true;
      });
      if (retiring.length) {
        consumedAcquisition = false;
        await this.prepareRetirement(retiring, generation);
        return;
      }
      const terrain = this.options.terrainResult;
      const x = (tile.bounds.minX + tile.bounds.maxX) / 2;
      const z = (tile.bounds.minZ + tile.bounds.maxZ) / 2;
      const geo = localMetersToGeo(x, z, terrain.terrainGeoBounds.centerLat, terrain.terrainGeoBounds.centerLon);
      // A temporary fallback stays visible while the preferred source retries;
      // another fallback result must not rebuild or replace the same geometry.
      const previous = this.chunks.get(tile.id);
      if (previous && grid.preferredSourceRetry) { this.recordFailure(tile.id); return; }
      const chunk = await LocalTerrainChunk.createAsync({
        localGrid: grid, centerLat: geo.lat, centerLon: geo.lon,
        referenceCenterLat: terrain.terrainGeoBounds.centerLat, referenceCenterLon: terrain.terrainGeoBounds.centerLon,
        terrainBaseElevation: terrain.terrainBaseElevation, layout: tile,
        baseElevationSampler: terrain.sampleBaseSurfaceY ?? terrain.elevationSampler,
        initialExaggeration: this.exaggeration, blendMarginRatio: 0.06,
        tileGrid: terrain.tileGrid, mapTexture: (terrain.terrainMesh.material as THREE.MeshStandardMaterial).map,
      }, terrain.baseSurfaceData, this.lifetime.signal);
      if (this.disposed || generation !== this.generation || !this.wanted.has(tile.id)) { chunk.dispose(); return; }
      if (!chunk.validate().isValid) {
        chunk.dispose(); this.failed.set(tile.id, { attempts: 0, retryAt: Infinity }); return;
      }
      let publish: (() => boolean) | undefined;
      try { publish = await this.options.prepareSurfacePromotion?.(chunk, previous); }
      catch (error) { chunk.dispose(); throw error; }
      if (this.disposed || generation !== this.generation) { chunk.dispose(); return; }
      this.ready = { id: tile.id, chunk, generation, publish };
    } catch (error) {
      if (!this.disposed && generation === this.generation && tile) {
        this.recordFailure(tile.id);
        console.warn('Terrain refinement unavailable; retaining base coverage:', error);
      }
    } finally {
      if (consumedAcquisition && tile && this.acquisitions.get(tile.id) === acquisition) this.acquisitions.delete(tile.id);
      this.acquiringTile = null;
      this.busy = false; this.nextWorkAt = 0;
    }
  }

  private async prepareRetirement(entries: [string, LocalTerrainChunk][], generation: number): Promise<void> {
    try {
      const publish = await this.options.prepareSurfaceRemoval?.(entries.map(([, chunk]) => chunk));
      if (!this.disposed && generation === this.generation) this.readyRemoval = { entries, generation, publish };
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        console.warn('Async terrain retirement unavailable; restoring parent coverage:', error);
        this.readyRemoval = { entries, generation };
      }
    }
  }

  private recordFailure(id: string): void {
    if (!this.wanted.has(id)) return;
    const attempts = Math.min(4, (this.failed.get(id)?.attempts ?? 0) + 1);
    // TileImageCache retains network failures for up to one minute. Avoid decoding
    // that same failed footprint repeatedly during its negative-cache lifetime.
    const delay = Math.min(300_000, 60_000 * 2 ** (attempts - 1));
    this.failed.set(id, { attempts, retryAt: performance.now() + delay });
  }

  private clearChunks(): void {
    for (const chunk of this.chunks.values()) {
      chunk.mesh.visible = false;
      this.options.terrainResult.detachLocalChunk?.(chunk);
    }
    this.chunks.clear();
    this.failed.clear();
    this.options.terrainResult.notifySurfaceChange?.();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cancelAcquisitions();
    this.lifetime.abort();
    this.ready?.chunk.dispose();
    this.ready = null;
    this.readyRemoval = null;
    this.clearChunks();
  }
}
