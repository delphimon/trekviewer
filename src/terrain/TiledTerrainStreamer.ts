import * as THREE from 'three';
import { geoToLocalMeters, localMetersToGeo } from '../gpx/Coordinates.ts';
import type { ViewMode } from '../gpx/TrackTypes.ts';
import { ElevationTileService } from './ElevationTiles.ts';
import { LocalTerrainChunk } from './LocalTerrainChunk.ts';
import type { LocalTerrainStreamerOptions } from './LocalTerrainStreamer.ts';
import type { QualityProfile } from './QualityProfile.ts';
import { QualityProfileManager } from './QualityProfile.ts';
import { planTerrainTiles, type TerrainTileLayout } from './TerrainTileLayout.ts';

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
  }

  public setQualityProfile(profile: QualityProfile): void {
    if (this.profile.name === profile.name) return;
    this.profile = profile;
    this.generation++;
    this.ready?.chunk.dispose();
    this.ready = null;
    this.readyRemoval = null;
    this.retireAll = this.chunks.size > 0;
    this.failed.clear();
    this.planKey = '';
    this.plannedAt = null;
  }

  public setVerticalExaggeration(factor: number): void {
    if (factor !== this.exaggeration) this.generation++;
    this.exaggeration = factor;
    for (const chunk of this.chunks.values()) chunk.setVerticalExaggeration(factor);
    this.ready?.chunk.setVerticalExaggeration(factor);
  }

  public update(progress: number, tabletopFocus?: { lat: number; lon: number } | null): void {
    if (this.disposed || !this.options.terrainResult.baseMeshGrid) return;
    const terrain = this.options.terrainResult;
    const geo = this.mode === 'diorama' && tabletopFocus ? tabletopFocus
      : this.options.routeGeometry.getTelemetryAtProgress(progress).currentPoint;
    const center = terrain.terrainGeoBounds;
    const local = geoToLocalMeters(geo.lat, geo.lon, 0, center.centerLat, center.centerLon, 0);
    if (!this.plannedAt || Math.hypot(local.x - this.plannedAt.x, local.z - this.plannedAt.z) >= 60) {
      this.plannedAt = { x: local.x, z: local.z };
      const balanced = this.profile.name === 'quest-balanced';
      const desktop = this.profile.name === 'desktop-high';
      const plan = planTerrainTiles({
        parent: terrain.baseMeshGrid!, focusX: local.x, focusZ: local.z,
        radiusM: balanced ? 1500 : desktop ? 3500 : 2500,
        parentCellsPerTile: 8, targetCellM: balanced ? 25 : 10,
        maxTiles: balanced ? 9 : desktop ? 24 : 12,
        maxVertices: balanced ? 40_000 : desktop ? 160_000 : 96_000,
      });
      const key = plan.tiles.map(tile => tile.id).sort().join('|');
      if (key !== this.planKey) {
        this.planKey = key;
        this.focus = { lat: geo.lat, lon: geo.lon };
        this.focusChanges++;
        this.wanted = new Map(plan.tiles.map(tile => [tile.id, tile]));
      }
    }
    if (this.readyRemoval) {
      const { entries, generation, publish } = this.readyRemoval;
      this.readyRemoval = null;
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
      if (generation !== this.generation || !this.wanted.has(id) || publish?.() === false) chunk.dispose();
      else {
        chunk.setVerticalExaggeration(this.exaggeration);
        chunk.setMapTexture((terrain.terrainMesh.material as THREE.MeshStandardMaterial).map, terrain.tileGrid);
        chunk.mesh.visible = false;
        terrain.attachLocalChunk?.(chunk);
        this.chunks.set(id, chunk);
        chunk.mesh.visible = true;
        terrain.notifySurfaceChange?.(chunk.getSurfaceBounds());
      }
    }
    if (!this.busy && !this.ready && !this.readyRemoval) void this.prepareNext();
  }

  private failed = new Set<string>();
  private async prepareNext(): Promise<void> {
    const retiring = [...this.chunks.entries()].filter(([id]) => this.retireAll || !this.wanted.has(id));
    if (retiring.length) {
      this.busy = true;
      const generation = this.generation;
      try {
        const publish = await this.options.prepareSurfaceRemoval?.(retiring.map(([, chunk]) => chunk));
        if (!this.disposed && generation === this.generation) this.readyRemoval = { entries: retiring, generation, publish };
      } catch (error) {
        if (!this.disposed && generation === this.generation) {
          console.warn('Async terrain retirement unavailable; restoring parent coverage:', error);
          this.readyRemoval = { entries: retiring, generation };
        }
      } finally { this.busy = false; }
      return;
    }
    const tile = [...this.wanted.values()].find(tile => !this.chunks.has(tile.id) && !this.failed.has(tile.id));
    if (!tile) return;
    this.busy = true;
    const generation = this.generation;
    const terrain = this.options.terrainResult;
    const x = (tile.bounds.minX + tile.bounds.maxX) / 2;
    const z = (tile.bounds.minZ + tile.bounds.maxZ) / 2;
    const geo = localMetersToGeo(x, z, terrain.terrainGeoBounds.centerLat, terrain.terrainGeoBounds.centerLon);
    try {
      const grid = await ElevationTileService.fetchLocalElevationGrid(geo.lat, geo.lon,
        Math.max(tile.width, tile.depth) / 2 + 100, 15, this.profile.localDemMaxTiles, this.lifetime.signal);
      if (this.disposed || generation !== this.generation || !this.wanted.has(tile.id)) return;
      if (!grid) { this.failed.add(tile.id); return; }
      const chunk = await LocalTerrainChunk.createAsync({
        localGrid: grid, centerLat: geo.lat, centerLon: geo.lon,
        referenceCenterLat: terrain.terrainGeoBounds.centerLat, referenceCenterLon: terrain.terrainGeoBounds.centerLon,
        terrainBaseElevation: terrain.terrainBaseElevation, layout: tile,
        baseElevationSampler: terrain.sampleBaseSurfaceY ?? terrain.elevationSampler,
        initialExaggeration: this.exaggeration, blendMarginRatio: 0.06,
        tileGrid: terrain.tileGrid, mapTexture: (terrain.terrainMesh.material as THREE.MeshStandardMaterial).map,
      }, terrain.baseSurfaceData, this.lifetime.signal);
      if (!chunk.validate().isValid || this.disposed || generation !== this.generation) {
        chunk.dispose(); this.failed.add(tile.id); return;
      }
      let publish: (() => boolean) | undefined;
      try { publish = await this.options.prepareSurfacePromotion?.(chunk); }
      catch (error) { chunk.dispose(); throw error; }
      if (this.disposed || generation !== this.generation) { chunk.dispose(); return; }
      this.ready = { id: tile.id, chunk, generation, publish };
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.failed.add(tile.id);
        console.warn('Terrain refinement unavailable; retaining base coverage:', error);
      }
    } finally { this.busy = false; }
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
    this.lifetime.abort();
    this.ready?.chunk.dispose();
    this.ready = null;
    this.readyRemoval = null;
    this.clearChunks();
  }
}
