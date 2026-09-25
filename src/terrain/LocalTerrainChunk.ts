import * as THREE from 'three';
import { type ElevationGrid, ElevationTileService } from './ElevationTiles.ts';
import { geoToLocalMeters, localMetersToGeo } from '../gpx/Coordinates.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface LocalTerrainChunkOptions {
  localGrid: ElevationGrid;
  centerLat: number;
  centerLon: number;
  terrainBaseElevation: number;
  radiusMeters?: number;
  segments?: number;
  initialExaggeration?: number;
}

export class LocalTerrainChunk {
  public readonly mesh: THREE.Mesh;
  public readonly centerLat: number;
  public readonly centerLon: number;
  public readonly terrainBaseElevation: number;
  public readonly radiusMeters: number;
  public readonly localBounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  private geometry: THREE.PlaneGeometry;
  private material: THREE.MeshStandardMaterial;
  private unscaledHeights: Float32Array;
  private segments: number;
  private currentExaggeration: number;
  private isDisposed: boolean = false;

  constructor(options: LocalTerrainChunkOptions) {
    this.centerLat = options.centerLat;
    this.centerLon = options.centerLon;
    this.terrainBaseElevation = options.terrainBaseElevation;
    this.radiusMeters = options.radiusMeters ?? 750;
    this.segments = options.segments ?? 64;
    this.currentExaggeration = options.initialExaggeration ?? 1.0;

    const widthM = this.radiusMeters * 2;
    const depthM = this.radiusMeters * 2;
    this.localBounds = {
      minX: -this.radiusMeters,
      maxX: this.radiusMeters,
      minZ: -this.radiusMeters,
      maxZ: this.radiusMeters,
    };

    this.geometry = new THREE.PlaneGeometry(widthM, depthM, this.segments, this.segments);
    this.geometry.rotateX(-Math.PI / 2);

    const posAttr = this.geometry.attributes.position;
    const vertexCount = posAttr.count;
    this.unscaledHeights = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const geo = localMetersToGeo(vx, vz, this.centerLat, this.centerLon);

      const sample = ElevationTileService.sampleElevation(options.localGrid, geo.lat, geo.lon);
      let h = 0;
      if (sample.isValid && !isNaN(sample.elevation)) {
        h = Math.max(0, sample.elevation - this.terrainBaseElevation);
      }
      this.unscaledHeights[i] = h;
      posAttr.setY(i, h * this.currentExaggeration);
    }

    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();

    this.material = new THREE.MeshStandardMaterial({
      color: 0x8a9ba8,
      roughness: 0.85,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -0.5,
      polygonOffsetUnits: -0.5,
      wireframe: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'LocalHighResTerrainMesh';
    this.mesh.receiveShadow = true;
  }

  /**
   * Evaluates exact surface elevation within this local chunk's bounds using barycentric interpolation.
   * Returns null if (localX, localZ) is outside the chunk's footprint.
   */
  public sampleLocalSurfaceY(localX: number, localZ: number): number | null {
    if (this.isDisposed) return null;

    if (
      localX < this.localBounds.minX ||
      localX > this.localBounds.maxX ||
      localZ < this.localBounds.minZ ||
      localZ > this.localBounds.maxZ
    ) {
      return null;
    }

    const widthM = this.radiusMeters * 2;
    const depthM = this.radiusMeters * 2;

    const gx = ((localX + this.radiusMeters) / widthM) * this.segments;
    const gz = ((localZ + this.radiusMeters) / depthM) * this.segments;

    const ix = Math.min(this.segments - 1, Math.max(0, Math.floor(gx)));
    const iz = Math.min(this.segments - 1, Math.max(0, Math.floor(gz)));

    const u = Math.max(0, Math.min(1, gx - ix));
    const v = Math.max(0, Math.min(1, gz - iz));

    const rowStride = this.segments + 1;
    const idxTL = iz * rowStride + ix;
    const idxTR = idxTL + 1;
    const idxBL = (iz + 1) * rowStride + ix;
    const idxBR = idxBL + 1;

    const hTL = this.unscaledHeights[idxTL];
    const hTR = this.unscaledHeights[idxTR];
    const hBL = this.unscaledHeights[idxBL];
    const hBR = this.unscaledHeights[idxBR];

    // Standard Three.js PlaneGeometry diagonal split: BL(0,1) to TR(1,0)
    if (u + v <= 1) {
      return (1 - u - v) * hTL + v * hBL + u * hTR;
    } else {
      return (1 - u) * hBL + (u + v - 1) * hBR + (1 - v) * hTR;
    }
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed) return;
    this.currentExaggeration = Math.max(1.0, Math.min(3.0, factor));
    const posAttr = this.geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setY(i, this.unscaledHeights[i] * this.currentExaggeration);
    }
    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    disposeObject3D(this.mesh);
  }
}
