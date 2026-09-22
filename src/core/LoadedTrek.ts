import * as THREE from 'three';
import type { TrackStats, TextureStyle } from '../gpx/TrackTypes.ts';
import type { TerrainResult } from '../terrain/TerrainGenerator.ts';
import type { TrailResult } from '../visualization/TrailMesh.ts';
import type { FlyoverController } from '../visualization/FlyoverController.ts';
import type { ImageryLODManager } from '../terrain/ImageryLODManager.ts';
import { DioramaBase } from '../visualization/DioramaBase.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';

export class LoadedTrek {
  public readonly track: TrackStats;
  public readonly terrainResult: TerrainResult;
  public readonly trailResult: TrailResult;
  public readonly dioramaBase: THREE.Group;
  public readonly flyoverController: FlyoverController;
  public readonly lodManager?: ImageryLODManager;
  public readonly group: THREE.Group;

  constructor(
    track: TrackStats,
    terrainResult: TerrainResult,
    trailResult: TrailResult,
    dioramaBase: THREE.Group,
    flyoverController: FlyoverController,
    lodManager?: ImageryLODManager
  ) {
    this.track = track;
    this.terrainResult = terrainResult;
    this.trailResult = trailResult;
    this.dioramaBase = dioramaBase;
    this.flyoverController = flyoverController;
    this.lodManager = lodManager;

    this.group = new THREE.Group();
    this.group.name = `LoadedTrek_${track.name}`;
    this.group.add(terrainResult.group);
    this.group.add(trailResult.group);
    this.group.add(dioramaBase);
    if (lodManager) {
      this.group.add(lodManager.group);
    }
  }

  public setVerticalExaggeration(factor: number): void {
    this.terrainResult.setVerticalExaggeration(factor);
    this.trailResult.setVerticalExaggeration(factor);
    DioramaBase.setVerticalExaggeration(this.dioramaBase, factor);
    this.lodManager?.setVerticalExaggeration(factor);
  }

  public setTextureStyle(style: TextureStyle): void {
    this.terrainResult.setTextureStyle(style);
    this.lodManager?.setTextureStyle(style);
  }

  public dispose(): void {
    // Dispose imagery LOD manager
    this.lodManager?.dispose();

    // Stop and dispose flyover controller
    this.flyoverController.dispose();

    // Dispose trail result
    this.trailResult.dispose();

    // Dispose terrain result
    this.terrainResult.dispose();

    // Dispose diorama base
    disposeObject3D(this.dioramaBase);

    // Dispose container group
    disposeObject3D(this.group);
  }
}
