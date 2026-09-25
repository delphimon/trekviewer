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
  referenceCenterLat?: number;
  referenceCenterLon?: number;
  baseElevationSampler?: (localX: number, localZ: number) => number;
  blendMarginRatio?: number;
}

export class LocalTerrainChunk {
  public readonly mesh: THREE.Mesh;
  public readonly centerLat: number;
  public readonly centerLon: number;
  public readonly referenceCenterLat: number;
  public readonly referenceCenterLon: number;
  public readonly localCenter: { x: number; z: number };
  public readonly terrainBaseElevation: number;
  public readonly radiusMeters: number;
  public readonly localBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  public isRealHighRes: boolean = false;
  public currentGrid: ElevationGrid;

  private geometry: THREE.PlaneGeometry;
  private material: THREE.MeshStandardMaterial;
  private unscaledHeights: Float32Array;
  private segments: number;
  private currentExaggeration: number;
  private isDisposed: boolean = false;

  constructor(options: LocalTerrainChunkOptions) {
    this.currentGrid = options.localGrid;
    this.isRealHighRes = options.localGrid.zoom >= 14 && options.localGrid.isRealDEM;
    this.centerLat = options.centerLat;
    this.centerLon = options.centerLon;
    this.referenceCenterLat = options.referenceCenterLat ?? this.centerLat;
    this.referenceCenterLon = options.referenceCenterLon ?? this.centerLon;
    this.terrainBaseElevation = options.terrainBaseElevation;
    // Stage W6: Expanded default radius to 1250m (Quest 1000-1500m)
    this.radiusMeters = options.radiusMeters ?? 1250;
    this.segments = options.segments ?? 64;
    this.currentExaggeration = options.initialExaggeration ?? 1.0;

    // Offset in local diorama meters from reference terrain origin
    const centerMeters = geoToLocalMeters(
      this.centerLat,
      this.centerLon,
      0,
      this.referenceCenterLat,
      this.referenceCenterLon,
      0
    );
    this.localCenter = { x: centerMeters.x, z: centerMeters.z };

    const widthM = this.radiusMeters * 2;
    const depthM = this.radiusMeters * 2;
    this.localBounds = {
      minX: this.localCenter.x - this.radiusMeters,
      maxX: this.localCenter.x + this.radiusMeters,
      minZ: this.localCenter.z - this.radiusMeters,
      maxZ: this.localCenter.z + this.radiusMeters,
    };

    this.geometry = new THREE.PlaneGeometry(widthM, depthM, this.segments, this.segments);
    this.geometry.rotateX(-Math.PI / 2);

    const posAttr = this.geometry.attributes.position;
    const vertexCount = posAttr.count;
    this.unscaledHeights = new Float32Array(vertexCount);

    const blendMargin = options.blendMarginRatio ?? 0.15;
    const innerRadius = this.radiusMeters * (1 - blendMargin);

    for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const geo = localMetersToGeo(vx, vz, this.centerLat, this.centerLon);

      const sample = ElevationTileService.sampleElevation(options.localGrid, geo.lat, geo.lon);
      let hLocal = 0;
      if (sample.isValid && !isNaN(sample.elevation)) {
        hLocal = Math.max(0, sample.elevation - this.terrainBaseElevation);
      }

      let h = hLocal;
      if (options.baseElevationSampler) {
        const sceneX = this.localCenter.x + vx;
        const sceneZ = this.localCenter.z + vz;
        const hBase = options.baseElevationSampler(sceneX, sceneZ);

        const r = Math.hypot(vx, vz);
        if (r > innerRadius) {
          const tLinear = Math.min(1, Math.max(0, (r - innerRadius) / (this.radiusMeters - innerRadius)));
          // Hermite smoothstep for seamless C1 boundary continuity
          const t = tLinear * tLinear * (3 - 2 * tLinear);
          h = (1 - t) * hLocal + t * hBase;
        }
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
    this.mesh.position.set(this.localCenter.x, 0, this.localCenter.z);
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

    const relX = localX - this.localCenter.x;
    const relZ = localZ - this.localCenter.z;

    const gx = ((relX + this.radiusMeters) / widthM) * this.segments;
    const gz = ((relZ + this.radiusMeters) / depthM) * this.segments;

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

  public outlineMesh?: THREE.LineSegments;

  /**
   * Dynamically applies an updated high-resolution elevation grid (Stage X2).
   */
  public updateElevationGrid(
    newGrid: ElevationGrid,
    baseElevationSampler?: (localX: number, localZ: number) => number
  ): void {
    if (this.isDisposed) return;
    this.currentGrid = newGrid;
    this.isRealHighRes = newGrid.zoom >= 14 && newGrid.isRealDEM;

    const posAttr = this.geometry.attributes.position;
    const vertexCount = posAttr.count;

    const blendMargin = 0.15;
    const innerRadius = this.radiusMeters * (1 - blendMargin);

    for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const geo = localMetersToGeo(vx, vz, this.centerLat, this.centerLon);

      const sample = ElevationTileService.sampleElevation(newGrid, geo.lat, geo.lon);
      let hLocal = 0;
      if (sample.isValid && !isNaN(sample.elevation)) {
        hLocal = Math.max(0, sample.elevation - this.terrainBaseElevation);
      }

      let h = hLocal;
      if (baseElevationSampler) {
        const sceneX = this.localCenter.x + vx;
        const sceneZ = this.localCenter.z + vz;
        const hBase = baseElevationSampler(sceneX, sceneZ);

        const r = Math.hypot(vx, vz);
        if (r > innerRadius) {
          const tLinear = Math.min(1, Math.max(0, (r - innerRadius) / (this.radiusMeters - innerRadius)));
          const t = tLinear * tLinear * (3 - 2 * tLinear);
          h = (1 - t) * hLocal + t * hBase;
        }
      }

      this.unscaledHeights[i] = h;
      posAttr.setY(i, h * this.currentExaggeration);
    }

    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();

    if (this.outlineMesh) {
      this.mesh.remove(this.outlineMesh);
      this.outlineMesh.geometry.dispose();
      (this.outlineMesh.material as THREE.Material)?.dispose();
      this.outlineMesh = undefined;
      this.setDebugOutline(true);
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

    if (this.outlineMesh) {
      this.mesh.remove(this.outlineMesh);
      this.outlineMesh.geometry.dispose();
      (this.outlineMesh.material as THREE.Material)?.dispose();
      this.outlineMesh = undefined;
      this.setDebugOutline(true);
    }
  }

  public setDebugOutline(enabled: boolean): void {
    if (this.isDisposed) return;
    if (enabled && !this.outlineMesh) {
      const edges = new THREE.EdgesGeometry(this.geometry, 40);
      const mat = new THREE.LineBasicMaterial({
        color: 0xf43f5e, // rose / vibrant magenta for local terrain extents
        transparent: true,
        opacity: 0.85,
      });
      this.outlineMesh = new THREE.LineSegments(edges, mat);
      this.outlineMesh.name = 'DebugLocalTerrainBoundary';
      this.mesh.add(this.outlineMesh);
    } else if (!enabled && this.outlineMesh) {
      this.mesh.remove(this.outlineMesh);
      this.outlineMesh.geometry.dispose();
      (this.outlineMesh.material as THREE.Material)?.dispose();
      this.outlineMesh = undefined;
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.outlineMesh) {
      this.mesh.remove(this.outlineMesh);
      this.outlineMesh.geometry.dispose();
      (this.outlineMesh.material as THREE.Material)?.dispose();
      this.outlineMesh = undefined;
    }
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    disposeObject3D(this.mesh);
  }
}
