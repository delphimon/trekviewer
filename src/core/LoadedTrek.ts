import * as THREE from 'three';
import type { TrackStats, TextureStyle, TrailColorMode, ViewMode } from '../gpx/TrackTypes.ts';
import type { TerrainResult } from '../terrain/TerrainGenerator.ts';
import type { TrailResult } from '../visualization/TrailMesh.ts';
import { DioramaBase } from '../visualization/DioramaBase.ts';
import { FlyoverController } from '../visualization/FlyoverController.ts';
import { ImageryLODManager } from '../terrain/ImageryLODManager.ts';
import { LocalTerrainStreamer } from '../terrain/LocalTerrainStreamer.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';
import { type QualityProfile, QualityProfileManager } from '../terrain/QualityProfile.ts';

export interface LoadedTrekParams {
  track: TrackStats;
  terrainResult: TerrainResult;
  trailResult: TrailResult;
  dioramaBase: THREE.Group;
  flyoverController: FlyoverController;
  imageryLOD?: ImageryLODManager;
  qualityProfile?: QualityProfile;
}

/**
 * Encapsulates all 3D assets, controllers, and metadata of a single loaded trek
 * into a self-contained, transactional, and disposable bundle.
 */
export class LoadedTrek {
  public readonly track: TrackStats;
  public readonly terrainResult: TerrainResult;
  public readonly trailResult: TrailResult;
  public readonly dioramaBase: THREE.Group;
  public readonly flyoverController: FlyoverController;
  public readonly imageryLOD: ImageryLODManager;
  public readonly localTerrainStreamer?: LocalTerrainStreamer;
  public readonly group: THREE.Group;
  private _isDisposed: boolean = false;

  constructor(params: LoadedTrekParams) {
    this.track = params.track;
    this.terrainResult = params.terrainResult;
    this.trailResult = params.trailResult;
    this.dioramaBase = params.dioramaBase;
    this.flyoverController = params.flyoverController;

    const qualityProfile = params.qualityProfile || QualityProfileManager.getActiveProfile();

    this.imageryLOD =
      params.imageryLOD ||
      new ImageryLODManager({
        terrainGeoBounds: params.terrainResult.terrainGeoBounds || params.track.bounds,
        terrainBaseElevation: params.terrainResult.terrainBaseElevation,
        elevationSampler: params.terrainResult.sampleRenderedSurfaceY || params.terrainResult.elevationSampler,
        routeGeometry: params.trailResult.routeGeometry,
        track: params.track,
        verticalExaggeration: 1.0,
        textureStyle: 'satellite',
        qualityProfile,
        enableInXR: true,
        terrainMesh: params.terrainResult.terrainMesh,
      });

    if (this.terrainResult.demGrid && this.trailResult.routeGeometry) {
      this.localTerrainStreamer = new LocalTerrainStreamer({
        terrainResult: this.terrainResult,
        routeGeometry: this.trailResult.routeGeometry,
        demGrid: this.terrainResult.demGrid,
        qualityProfile,
        initialViewMode: 'diorama',
      });
      this.localTerrainStreamer.update(0);
    }

    this.group = new THREE.Group();
    this.group.name = `LoadedTrek_${params.track.name || 'unnamed'}`;

    // Assemble all diorama 3D components under this trek's isolated group
    this.group.add(this.terrainResult.group);
    this.group.add(this.imageryLOD.group);
    this.group.add(this.trailResult.group);
    this.group.add(this.dioramaBase);
  }

  public get isDisposed(): boolean {
    return this._isDisposed;
  }

  public setVerticalExaggeration(factor: number): void {
    if (this._isDisposed) return;
    this.terrainResult.setVerticalExaggeration(factor);
    this.localTerrainStreamer?.setVerticalExaggeration(factor);
    this.imageryLOD.setVerticalExaggeration(factor);
    this.trailResult.setVerticalExaggeration(factor);
    DioramaBase.setVerticalExaggeration(this.dioramaBase, factor);
  }

  public async setTextureStyle(style: TextureStyle): Promise<void> {
    if (this._isDisposed) return;
    await Promise.all([
      this.terrainResult.setTextureStyle(style),
      this.imageryLOD.setTextureStyle(style),
    ]);
  }

  public setTrailColorMode(mode: TrailColorMode): void {
    if (this._isDisposed) return;
    this.trailResult.setColorMode(mode);
  }

  public setViewMode(mode: ViewMode): void {
    if (this._isDisposed) return;
    this.trailResult.setViewMode(mode);
    this.flyoverController.setViewMode(mode);
    this.imageryLOD.setViewMode(mode);
    this.localTerrainStreamer?.setViewMode(mode);
  }

  public setQualityProfile(profile: QualityProfile): void {
    if (this._isDisposed) return;
    this.imageryLOD.setQualityProfile(profile);
    this.localTerrainStreamer?.setQualityProfile(profile);
  }

  public setDebugPatchBounds(enabled: boolean): void {
    if (this._isDisposed) return;
    this.imageryLOD.setDebugPatchBounds(enabled);
    this.terrainResult.setDebugPatchBounds?.(enabled);
  }

  public updateWaypoints(camera: THREE.Camera, dioramaScale: number, delta: number): void {
    if (this._isDisposed) return;
    DioramaBase.updateWaypoints(this.dioramaBase, camera, dioramaScale, delta);
  }

  public updateHikerProgress(progress: number): void {
    if (this._isDisposed) return;
    this.localTerrainStreamer?.update(progress);
  }

  public dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    // 1. Detach from any parent scene node
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }

    // 2. Stop and release flyover controller
    this.flyoverController.dispose();

    // 3. Release trail mesh, ribbons, markers
    this.trailResult.dispose();

    // 4. Release local terrain streamer and chunks
    this.localTerrainStreamer?.dispose();

    // 5. Release terrain mesh, DEM tiles, and textures
    this.terrainResult.dispose();

    // 6. Release imagery LOD patches and abort in-flight requests
    this.imageryLOD.dispose();

    // 6. Release diorama plinth and waypoint markers
    if (this.dioramaBase.parent) {
      this.dioramaBase.parent.remove(this.dioramaBase);
    }
    disposeObject3D(this.dioramaBase);

    // 7. Recursively dispose and clear container group
    disposeObject3D(this.group);
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
  }
}
