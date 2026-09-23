import * as THREE from 'three';
import type { TrackStats, TextureStyle, TrailColorMode, ViewMode } from '../gpx/TrackTypes.ts';
import type { TerrainResult } from '../terrain/TerrainGenerator.ts';
import type { TrailResult } from '../visualization/TrailMesh.ts';
import { DioramaBase } from '../visualization/DioramaBase.ts';
import { FlyoverController } from '../visualization/FlyoverController.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';

export interface LoadedTrekParams {
  track: TrackStats;
  terrainResult: TerrainResult;
  trailResult: TrailResult;
  dioramaBase: THREE.Group;
  flyoverController: FlyoverController;
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
  public readonly group: THREE.Group;
  private _isDisposed: boolean = false;

  constructor(params: LoadedTrekParams) {
    this.track = params.track;
    this.terrainResult = params.terrainResult;
    this.trailResult = params.trailResult;
    this.dioramaBase = params.dioramaBase;
    this.flyoverController = params.flyoverController;

    this.group = new THREE.Group();
    this.group.name = `LoadedTrek_${params.track.name || 'unnamed'}`;

    // Assemble all diorama 3D components under this trek's isolated group
    this.group.add(this.terrainResult.group);
    this.group.add(this.trailResult.group);
    this.group.add(this.dioramaBase);
  }

  public get isDisposed(): boolean {
    return this._isDisposed;
  }

  public setVerticalExaggeration(factor: number): void {
    if (this._isDisposed) return;
    this.terrainResult.setVerticalExaggeration(factor);
    this.trailResult.setVerticalExaggeration(factor);
    DioramaBase.setVerticalExaggeration(this.dioramaBase, factor);
  }

  public async setTextureStyle(style: TextureStyle): Promise<void> {
    if (this._isDisposed) return;
    await this.terrainResult.setTextureStyle(style);
  }

  public setTrailColorMode(mode: TrailColorMode): void {
    if (this._isDisposed) return;
    this.trailResult.setColorMode(mode);
  }

  public setViewMode(mode: ViewMode): void {
    if (this._isDisposed) return;
    this.trailResult.setViewMode(mode);
    this.flyoverController.setViewMode(mode);
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

    // 4. Release terrain mesh, DEM tiles, and textures
    this.terrainResult.dispose();

    // 5. Release diorama plinth and waypoint markers
    disposeObject3D(this.dioramaBase);

    // 6. Recursively dispose and clear container group
    disposeObject3D(this.group);
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
  }
}
