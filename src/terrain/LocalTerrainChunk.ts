import * as THREE from 'three';
import { type ElevationGrid, ElevationTileService } from './ElevationTiles.ts';
import { geoToLocalMeters, localMetersToGeo } from '../gpx/Coordinates.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';
import { TextureProvider, type TileGridBounds } from './TextureProvider.ts';
import { refinementGrid, type TerrainGridLayout } from './TerrainGrid.ts';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';
import type { TerrainSurfaceData } from './TerrainGrid.ts';
import { runTerrainJob } from './TerrainJobs.ts';

export interface TerrainChunkData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  heights: Float32Array;
  bounds: { min: [number, number, number]; max: [number, number, number]; center: [number, number, number]; radius: number };
  fallbackCount: number;
  maxDiffFromBase: number;
}

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
  tileGrid?: TileGridBounds;
  mapTexture?: THREE.Texture | null;
  baseMeshGrid?: TerrainGridLayout;
  layout?: TerrainGridLayout & { bounds: TerrainSurfaceBounds };
  /** Transfers ownership of the prepared arrays to this chunk. */
  preparedData?: TerrainChunkData;
}

export interface ChunkValidationResult {
  isValid: boolean;
  reason?: string;
  fallbackRatio: number;
  maxDiffFromBase: number;
  nanCount: number;
  infiniteCount: number;
}

/** Export rasters use zoom 0; their explicit sample spacing determines detail. */
function hasLocalElevationDetail(grid: ElevationGrid): boolean {
  return grid.isRealDEM && (grid.rasterBounds
    ? Number.isFinite(grid.sampleSpacingMeters) && grid.sampleSpacingMeters! > 0 && grid.sampleSpacingMeters! <= 10
    : grid.zoom >= 14);
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
  public readonly localBounds: TerrainSurfaceBounds;

  public getSurfaceBounds(): TerrainSurfaceBounds {
    return this.localBounds;
  }

  public getCellSize(): { x: number; z: number } {
    return { x: this.widthM / this.segmentsX, z: this.depthM / this.segmentsZ };
  }

  public isRealHighRes: boolean = false;
  public currentGrid: ElevationGrid;
  public fallbackCount: number = 0;
  public maxDiffFromBase: number = 0;
  public totalVertices: number = 0;

  public readonly geometry: THREE.PlaneGeometry;
  public readonly material: THREE.MeshStandardMaterial;
  private unscaledHeights: Float32Array;
  private segments: number;
  private segmentsX: number;
  private segmentsZ: number;
  private widthM: number;
  private depthM: number;
  private readonly blendMargin: number;
  private currentExaggeration: number;
  private isDisposed: boolean = false;
  private uvGridKey: string = '';
  private baseSampler?: (x: number, z: number) => number;
  private preserveParentEdges: boolean;

  public static async createAsync(options: LocalTerrainChunkOptions, base?: TerrainSurfaceData, signal?: AbortSignal): Promise<LocalTerrainChunk> {
    if (typeof Worker === 'undefined' || !base) return new LocalTerrainChunk(options);
    const { mapTexture: _map, baseElevationSampler: _sampler, ...serializable } = options;
    const data = await runTerrainJob<TerrainChunkData>({ kind: 'chunk', options: serializable, base }, () => {
      const candidate = new LocalTerrainChunk(options);
      const data = candidate.getBuildData();
      candidate.dispose();
      return data;
    }, signal);
    if (signal?.aborted) throw new DOMException('Chunk cancelled', 'AbortError');
    return new LocalTerrainChunk({ ...options, preparedData: data });
  }

  public getBuildData(): TerrainChunkData {
    return {
      positions: this.geometry.attributes.position.array as Float32Array,
      normals: this.geometry.attributes.normal.array as Float32Array,
      uvs: this.geometry.attributes.uv.array as Float32Array,
      indices: this.geometry.index!.array as Uint16Array | Uint32Array,
      bounds: { min: this.geometry.boundingBox!.min.toArray(), max: this.geometry.boundingBox!.max.toArray(),
        center: this.geometry.boundingSphere!.center.toArray(), radius: this.geometry.boundingSphere!.radius },
      heights: this.unscaledHeights, fallbackCount: this.fallbackCount, maxDiffFromBase: this.maxDiffFromBase,
    };
  }

  constructor(options: LocalTerrainChunkOptions) {
    this.baseSampler = options.baseElevationSampler;
    this.preserveParentEdges = !!(options.layout || options.baseMeshGrid);
    this.currentGrid = options.localGrid;
    this.isRealHighRes = hasLocalElevationDetail(options.localGrid);
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
    const aligned = options.layout ?? (options.baseMeshGrid
      ? refinementGrid(options.baseMeshGrid, centerMeters.x, centerMeters.z, this.radiusMeters, this.segments)
      : null);
    this.localBounds = aligned?.bounds ?? {
      minX: centerMeters.x - this.radiusMeters, maxX: centerMeters.x + this.radiusMeters,
      minZ: centerMeters.z - this.radiusMeters, maxZ: centerMeters.z + this.radiusMeters,
    };
    this.localCenter = {
      x: (this.localBounds.minX + this.localBounds.maxX) / 2,
      z: (this.localBounds.minZ + this.localBounds.maxZ) / 2,
    };
    this.widthM = aligned?.width ?? this.radiusMeters * 2;
    this.depthM = aligned?.depth ?? this.radiusMeters * 2;
    this.segmentsX = aligned?.segmentsX ?? this.segments;
    this.segmentsZ = aligned?.segmentsZ ?? this.segments;
    this.blendMargin = options.blendMarginRatio ?? 0.15;

    if (![this.widthM, this.depthM, this.segmentsX, this.segmentsZ].every(Number.isFinite)
      || this.widthM <= 0 || this.depthM <= 0 || this.segmentsX < 1 || this.segmentsZ < 1
      || (this.segmentsX + 1) * (this.segmentsZ + 1) > 200_000) {
      throw new RangeError('Local terrain exceeds the vertex budget or has invalid dimensions.');
    }
    const prepared = options.preparedData;
    if (prepared) {
      // The worker transfers sole ownership of these buffers. Adopt them directly
      // instead of generating, rotating and overwriting another complete plane.
      // Keep the regular-grid contract used by exact terrain ray traversal and
      // imagery clipping. Only the constant-size shell is generated here.
      this.geometry = new THREE.PlaneGeometry(this.widthM, this.depthM, 1, 1);
      Object.assign(this.geometry.parameters, { widthSegments: this.segmentsX, heightSegments: this.segmentsZ });
      this.geometry.setAttribute('position', new THREE.BufferAttribute(prepared.positions, 3));
      this.geometry.setAttribute('normal', new THREE.BufferAttribute(prepared.normals, 3));
      this.geometry.setAttribute('uv', new THREE.BufferAttribute(prepared.uvs, 2));
      this.geometry.setIndex(new THREE.BufferAttribute(prepared.indices, 1));
      this.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...prepared.bounds.min), new THREE.Vector3(...prepared.bounds.max));
      this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...prepared.bounds.center), prepared.bounds.radius);
    } else {
      this.geometry = new THREE.PlaneGeometry(this.widthM, this.depthM, this.segmentsX, this.segmentsZ);
      this.geometry.rotateX(-Math.PI / 2);
    }

    const posAttr = this.geometry.attributes.position;
    const vertexCount = posAttr.count;
    this.totalVertices = vertexCount;
    this.unscaledHeights = prepared?.heights ?? new Float32Array(vertexCount);
    this.fallbackCount = 0;
    this.maxDiffFromBase = 0;


    if (options.preparedData) {
      this.fallbackCount = options.preparedData.fallbackCount;
      this.maxDiffFromBase = options.preparedData.maxDiffFromBase;
    } else for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const geo = localMetersToGeo(this.localCenter.x + vx, this.localCenter.z + vz, this.referenceCenterLat, this.referenceCenterLon);

      const sceneX = this.localCenter.x + vx;
      const sceneZ = this.localCenter.z + vz;
      const hBase = options.baseElevationSampler ? options.baseElevationSampler(sceneX, sceneZ) : 0;

      const sample = ElevationTileService.sampleElevation(options.localGrid, geo.lat, geo.lon);
      let hLocal: number;
      let isHighResValid = false;

      if (sample.isValid && !isNaN(sample.elevation)) {
        hLocal = sample.elevation - this.terrainBaseElevation;
        isHighResValid = true;
      } else {
        // Stage X3.1: NEVER convert missing local DEM data to zero height!
        // Fall back to authoritative base terrain surface for this coordinate.
        hLocal = hBase;
        this.fallbackCount++;
      }

      let h = hLocal;
      if (options.baseElevationSampler && isHighResValid) {
        const t = this.baseBlendWeight(vx, vz);
        h = (1 - t) * hLocal + t * hBase;
      }

      const diff = Math.abs(h - hBase);
      if (diff > this.maxDiffFromBase) {
        this.maxDiffFromBase = diff;
      }

      this.unscaledHeights[i] = h;
      posAttr.setY(i, h * this.currentExaggeration);
    }

    posAttr.needsUpdate = true;
    if (!options.preparedData) this.geometry.computeVertexNormals();
    if (!options.preparedData) this.applyParentEdgeNormals();
    if (!prepared) {
      this.geometry.computeBoundingBox();
      this.geometry.computeBoundingSphere();
    }

    // Map local chunk vertices to global geographic UVs (Stage X3)
    if (options.tileGrid && !options.preparedData) {
      const uvAttr = this.geometry.attributes.uv;
      for (let i = 0; i < vertexCount; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);
        const geo = localMetersToGeo(this.localCenter.x + vx, this.localCenter.z + vz, this.referenceCenterLat, this.referenceCenterLon);
        const uv = TextureProvider.getUVForGeo(geo.lat, geo.lon, options.tileGrid);
        uvAttr.setXY(i, uv.u, uv.v);
      }
      uvAttr.needsUpdate = true;
    }

    // Physical non-metallic terrain material with active map texture (Stage X3)
    this.material = new THREE.MeshStandardMaterial({
      map: options.mapTexture ?? null,
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -0.5,
      polygonOffsetUnits: -0.5,
      wireframe: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'LocalHighResTerrainMesh';
    this.mesh.position.set(this.localCenter.x, 0, this.localCenter.z);
    this.mesh.receiveShadow = true;
    if (options.tileGrid) this.uvGridKey = JSON.stringify(options.tileGrid);
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

    const widthM = this.widthM;
    const depthM = this.depthM;

    const relX = localX - this.localCenter.x;
    const relZ = localZ - this.localCenter.z;

    const gx = ((relX + widthM / 2) / widthM) * this.segmentsX;
    const gz = ((relZ + depthM / 2) / depthM) * this.segmentsZ;

    const ix = Math.min(this.segmentsX - 1, Math.max(0, Math.floor(gx)));
    const iz = Math.min(this.segmentsZ - 1, Math.max(0, Math.floor(gz)));

    const u = Math.max(0, Math.min(1, gx - ix));
    const v = Math.max(0, Math.min(1, gz - iz));

    const rowStride = this.segmentsX + 1;
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

  private baseBlendWeight(x: number, z: number): number {
    const edgeDistance = Math.min(this.widthM / 2 - Math.abs(x), this.depthM / 2 - Math.abs(z));
    const margin = Math.max(1, Math.min(this.widthM, this.depthM) * 0.5 * this.blendMargin);
    const t = Math.max(0, Math.min(1, 1 - edgeDistance / margin));
    return t * t * (3 - 2 * t);
  }

  private applyParentEdgeNormals(): void {
    if (this.baseSampler && this.preserveParentEdges) {
      // Independent child meshes share the parent's edge normal as well as its height.
      // This removes lighting seams without hiding real interior relief.
      const posAttr = this.geometry.attributes.position;
      const normals = this.geometry.attributes.normal;
      for (let row = 0; row <= this.segmentsZ; row++) {
        for (let col = 0; col <= this.segmentsX; col++) {
          if (row !== 0 && row !== this.segmentsZ && col !== 0 && col !== this.segmentsX) continue;
          const i = row * (this.segmentsX + 1) + col;
          const x = this.localCenter.x + posAttr.getX(i), z = this.localCenter.z + posAttr.getZ(i);
          const dx = (this.baseSampler(x + 1, z) - this.baseSampler(x - 1, z)) * this.currentExaggeration;
          const dz = (this.baseSampler(x, z + 1) - this.baseSampler(x, z - 1)) * this.currentExaggeration;
          const length = Math.hypot(dx, 2, dz);
          normals.setXYZ(i, -dx / length, 2 / length, -dz / length);
        }
      }
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
    if (baseElevationSampler) this.baseSampler = baseElevationSampler;
    this.isRealHighRes = hasLocalElevationDetail(newGrid);

    const posAttr = this.geometry.attributes.position;
    const vertexCount = posAttr.count;
    this.totalVertices = vertexCount;
    this.fallbackCount = 0;
    this.maxDiffFromBase = 0;


    for (let i = 0; i < vertexCount; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const geo = localMetersToGeo(this.localCenter.x + vx, this.localCenter.z + vz, this.referenceCenterLat, this.referenceCenterLon);

      const sceneX = this.localCenter.x + vx;
      const sceneZ = this.localCenter.z + vz;
      const hBase = baseElevationSampler ? baseElevationSampler(sceneX, sceneZ) : 0;

      const sample = ElevationTileService.sampleElevation(newGrid, geo.lat, geo.lon);
      let hLocal: number;
      let isHighResValid = false;

      if (sample.isValid && !isNaN(sample.elevation)) {
        hLocal = sample.elevation - this.terrainBaseElevation;
        isHighResValid = true;
      } else {
        // Stage X3.1: NEVER convert missing local DEM data to zero height!
        hLocal = hBase;
        this.fallbackCount++;
      }

      let h = hLocal;
      if (baseElevationSampler && isHighResValid) {
        const t = this.baseBlendWeight(vx, vz);
        h = (1 - t) * hLocal + t * hBase;
      }

      const diff = Math.abs(h - hBase);
      if (diff > this.maxDiffFromBase) {
        this.maxDiffFromBase = diff;
      }

      this.unscaledHeights[i] = h;
      posAttr.setY(i, h * this.currentExaggeration);
    }

    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();

    if (this.outlineMesh) {
      this.mesh.remove(this.outlineMesh);
      this.outlineMesh.geometry.dispose();
      (this.outlineMesh.material as THREE.Material)?.dispose();
      this.outlineMesh = undefined;
      this.setDebugOutline(true);
    }
  }

  /**
   * Validates generated chunk vertices for finite heights and sane surface fidelity (Stage X3.1).
   */
  public validate(baseSampler?: (x: number, z: number) => number): ChunkValidationResult {
    const posAttr = this.geometry.attributes.position;
    const count = posAttr.count;
    let nanCount = 0;
    let infiniteCount = 0;

    for (let i = 0; i < count; i++) {
      const y = posAttr.getY(i);
      if (isNaN(y)) nanCount++;
      if (!isFinite(y)) infiniteCount++;
    }

    if (nanCount > 0) {
      return {
        isValid: false,
        reason: `Local terrain contains ${nanCount} NaN vertices`,
        fallbackRatio: 1,
        maxDiffFromBase: this.maxDiffFromBase,
        nanCount,
        infiniteCount,
      };
    }

    if (infiniteCount > 0) {
      return {
        isValid: false,
        reason: `Local terrain contains ${infiniteCount} non-finite vertices`,
        fallbackRatio: 1,
        maxDiffFromBase: this.maxDiffFromBase,
        nanCount,
        infiniteCount,
      };
    }

    const fallbackRatio = this.fallbackCount / Math.max(1, count);
    return {
      isValid: true,
      fallbackRatio,
      maxDiffFromBase: this.maxDiffFromBase,
      nanCount: 0,
      infiniteCount: 0,
    };
  }

  /**
   * Updates map imagery texture and reprojects geographic UVs across the chunk (Stage X3).
   */
  public setMapTexture(texture: THREE.Texture | null, tileGrid?: TileGridBounds): void {
    if (this.isDisposed) return;
    const shaderChanged = !!this.material.map !== !!texture;
    this.material.map = texture;
    if (shaderChanged) this.material.needsUpdate = true;

    const gridKey = tileGrid ? JSON.stringify(tileGrid) : '';
    if (tileGrid && gridKey !== this.uvGridKey) {
      this.uvGridKey = gridKey;
      const posAttr = this.geometry.attributes.position;
      const uvAttr = this.geometry.attributes.uv;
      const vertexCount = posAttr.count;
      for (let i = 0; i < vertexCount; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);
        const geo = localMetersToGeo(this.localCenter.x + vx, this.localCenter.z + vz, this.referenceCenterLat, this.referenceCenterLon);
        const uv = TextureProvider.getUVForGeo(geo.lat, geo.lon, tileGrid);
        uvAttr.setXY(i, uv.u, uv.v);
      }
      uvAttr.needsUpdate = true;
    }
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed) return;
    const next = Math.max(1.0, Math.min(3.0, factor));
    if (next === this.currentExaggeration) return;
    this.currentExaggeration = next;
    const posAttr = this.geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setY(i, this.unscaledHeights[i] * this.currentExaggeration);
    }
    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();

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
    // Shared base texture protection (Stage X3.1):
    // LocalTerrainChunk references base terrain texture but does NOT own it.
    // Detach and preserve map texture so disposeObject3D never disposes or collapses it.
    const sharedTexture = this.material.map;
    this.material.map = null;
    const preserve = new Set<THREE.Texture>();
    if (sharedTexture) {
      preserve.add(sharedTexture);
    }
    disposeObject3D(this.mesh, preserve);
  }
}
