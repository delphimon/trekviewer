import * as THREE from 'three';
import type { GeoBounds, TextureStyle } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters, localMetersToGeo, tileToLatLon, latLonToTile, degToRad, radToDeg } from '../gpx/Coordinates.ts';
import type { ImageryProvider } from './providers/ImageryProvider.ts';
import { TextureProvider } from './TextureProvider.ts';
import { TileImageCache } from './TileImageCache.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export const ENABLE_ADAPTIVE_IMAGERY_LOD = true;

export interface ImageryPatch {
  key: string;
  zoom: number;
  x: number;
  y: number;
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  lastUsed: number;
  centerDist: number;
  dispose: () => void;
}

export interface ImageryLODManagerOptions {
  terrainGeoBounds: GeoBounds;
  terrainBaseElevation: number;
  elevationSampler: (x: number, z: number) => number;
  verticalExaggeration?: number;
  textureStyle?: TextureStyle;
  maxPatches?: number;
  enableInXR?: boolean;
}

export interface ImageryLODDiagnostics {
  activePatchesCount: number;
  targetZoom: number;
  inFlightRequests: number;
  patchesCreatedTotal: number;
  patchesDisposedTotal: number;
  generation: number;
}

/**
 * ImageryLODManager
 *
 * Implements Stage M: Adaptive High-Resolution Map Imagery.
 *
 * Dynamically streams and drapes high-resolution map imagery tiles over the
 * terrain area currently being inspected, refining resolution as the diorama
 * is scaled up or the camera moves closer.
 *
 * INVARIANT: This class NEVER mutates dioramaRoot position, rotation, scale,
 * camera transform, HUD transform, or session state.
 */
export class ImageryLODManager {
  public readonly group: THREE.Group;
  private options: ImageryLODManagerOptions;
  private patches: Map<string, ImageryPatch> = new Map();

  private isDisposed: boolean = false;
  private currentGeneration: number = 0;
  private abortController: AbortController | null = null;

  private currentTextureStyle: TextureStyle;
  private verticalExaggeration: number;
  private maxPatches: number;
  private enableInXR: boolean;

  // View state tracking & debouncing
  private currentTargetZoom: number = 14;
  private lastEvalTime: number = 0;
  private readonly EVAL_INTERVAL_MS: number = 250; // 4 evaluations/sec max

  private lastCamPos: THREE.Vector3 = new THREE.Vector3();
  private lastCamDir: THREE.Vector3 = new THREE.Vector3();
  private lastDioramaScale: number = 1.0;

  // Telemetry & diagnostics
  private inFlightRequests: number = 0;
  private patchesCreatedTotal: number = 0;
  private patchesDisposedTotal: number = 0;

  constructor(options: ImageryLODManagerOptions) {
    this.options = options;
    this.currentTextureStyle = options.textureStyle || 'satellite';
    this.verticalExaggeration = options.verticalExaggeration ?? 1.0;
    this.maxPatches = options.maxPatches ?? 36;
    this.enableInXR = options.enableInXR ?? false;

    this.group = new THREE.Group();
    this.group.name = 'ImageryLODGroup';
  }

  public getDiagnostics(): ImageryLODDiagnostics {
    return {
      activePatchesCount: this.patches.size,
      targetZoom: this.currentTargetZoom,
      inFlightRequests: this.inFlightRequests,
      patchesCreatedTotal: this.patchesCreatedTotal,
      patchesDisposedTotal: this.patchesDisposedTotal,
      generation: this.currentGeneration,
    };
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed || Math.abs(this.verticalExaggeration - factor) < 0.01) return;
    this.verticalExaggeration = factor;

    // Update heights on all active patches
    for (const patch of this.patches.values()) {
      this.updatePatchGeometryHeights(patch.mesh.geometry as THREE.BufferGeometry);
    }
  }

  public async setTextureStyle(style: TextureStyle): Promise<void> {
    if (this.isDisposed || this.currentTextureStyle === style) return;
    this.currentTextureStyle = style;

    // Invalidate and cancel current generation
    this.currentGeneration++;
    this.abortController?.abort();
    this.abortController = null;

    // Clear all existing patch meshes so old style never floats over new style
    this.clearAllPatches();
  }

  /**
   * Main per-frame update method called from scene render loop.
   * Debounced and movement-thresholded to prevent 72Hz head tracking churn.
   */
  public update(camera: THREE.Camera, dioramaRoot: THREE.Group, isXR: boolean = false): void {
    if (this.isDisposed || !ENABLE_ADAPTIVE_IMAGERY_LOD) return;

    // Stage M desktop-first gate: disable in XR until desktop is fully verified
    if (isXR && !this.enableInXR) {
      if (this.patches.size > 0) {
        this.clearAllPatches();
      }
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastEvalTime < this.EVAL_INTERVAL_MS) {
      return;
    }

    // Check movement thresholds (Requirement #72)
    const camPos = camera.position;
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const dioramaScale = dioramaRoot.scale.x;

    const posDelta = camPos.distanceTo(this.lastCamPos);
    const dirAngle = camDir.angleTo(this.lastCamDir);
    const scaleRatio = Math.abs(dioramaScale - this.lastDioramaScale) / Math.max(this.lastDioramaScale, 0.001);

    const isFirstRun = this.lastEvalTime === 0;
    if (!isFirstRun && posDelta < 0.04 && dirAngle < 0.03 && scaleRatio < 0.04) {
      return; // Under movement threshold, stationary view converges cleanly
    }

    this.lastEvalTime = now;
    this.lastCamPos.copy(camPos);
    this.lastCamDir.copy(camDir);
    this.lastDioramaScale = dioramaScale;

    this.evaluateLOD(camera, dioramaRoot);
  }

  /**
   * Pure zoom calculation function based on display texel density.
   * Can be tested independently.
   */
  public static calculateTargetZoom(
    cameraDist: number,
    dioramaScale: number,
    centerLat: number,
    fovDeg: number = 60,
    viewportHeightPx: number = 1080,
    providerMaxZoom: number = 19,
    currentZoom?: number
  ): number {
    const fovRad = degToRad(fovDeg);
    const metersPerPixel = (2 * cameraDist * Math.tan(fovRad / 2)) / Math.max(viewportHeightPx, 480);
    const localMetersPerPixel = metersPerPixel / Math.max(dioramaScale, 0.000001);

    const latRad = degToRad(centerLat);
    const earthCircumferenceMeters = 2 * Math.PI * 6371000 * Math.cos(latRad);
    const rawZoom = Math.log2((earthCircumferenceMeters / 256) / Math.max(localMetersPerPixel, 0.01));

    // Desired zoom with modest resolution bias for crisp alpine inspection
    const biasedZoom = rawZoom + 0.3;
    let targetZ = Math.round(biasedZoom);

    // Apply zoom hysteresis (Requirement #73): require > 0.6 drift from currentZoom to promote/demote
    if (currentZoom !== undefined) {
      if (biasedZoom > currentZoom + 0.6) {
        targetZ = Math.round(biasedZoom);
      } else if (biasedZoom < currentZoom - 0.6) {
        targetZ = Math.round(biasedZoom);
      } else {
        targetZ = currentZoom;
      }
    }

    // Minimum patch zoom: 13. Maximum: provider limit.
    return Math.max(13, Math.min(providerMaxZoom, targetZ));
  }

  private evaluateLOD(camera: THREE.Camera, dioramaRoot: THREE.Group): void {
    const provider = TextureProvider.getProviderForStyle(this.currentTextureStyle);
    const centerLat = this.options.terrainGeoBounds.centerLat;

    // Estimate distance to diorama center in world space
    const dioramaWorldPos = new THREE.Vector3();
    dioramaRoot.getWorldPosition(dioramaWorldPos);
    const camDist = Math.max(camera.position.distanceTo(dioramaWorldPos), 0.2);
    const dioramaScale = dioramaRoot.scale.x;

    const fov = (camera as THREE.PerspectiveCamera).fov || 60;
    const targetZoom = ImageryLODManager.calculateTargetZoom(
      camDist,
      dioramaScale,
      centerLat,
      fov,
      typeof window !== 'undefined' ? window.innerHeight : 1080,
      provider.maxZoom,
      this.currentTargetZoom
    );

    this.currentTargetZoom = targetZoom;

    // Determine target center point on the diorama
    // Cast a ray from camera forward vector onto diorama tabletop plane (y = dioramaWorldPos.y)
    const ray = new THREE.Ray(camera.position, this.lastCamDir);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dioramaWorldPos.y);
    const hit = new THREE.Vector3();

    let targetGeo = { lat: centerLat, lon: this.options.terrainGeoBounds.centerLon };

    if (ray.intersectPlane(plane, hit)) {
      // Transform world hit point into local diorama space
      const localHit = hit.clone();
      dioramaRoot.worldToLocal(localHit);

      // Verify intersection lies near or within terrain bounds
      const halfW = (this.options.terrainGeoBounds.widthMeters * 1.5) / 2;
      const halfD = (this.options.terrainGeoBounds.depthMeters * 1.5) / 2;
      if (Math.abs(localHit.x) <= halfW && Math.abs(localHit.z) <= halfD) {
        targetGeo = localMetersToGeo(
          localHit.x,
          localHit.z,
          centerLat,
          this.options.terrainGeoBounds.centerLon
        );
      }
    }

    // Select candidate tiles around target point
    const centerTile = latLonToTile(targetGeo.lat, targetGeo.lon, targetZoom);
    const candidates = this.collectCandidateTiles(centerTile.x, centerTile.y, targetZoom);

    // Filter candidate tiles that intersect the terrain footprint
    const validCandidates = candidates.filter((tile) =>
      this.tileIntersectsTerrain(tile.x, tile.y, targetZoom)
    );

    // Request new tiles and prune expired ones
    this.scheduleTileFetches(validCandidates, provider, targetZoom);
  }

  private collectCandidateTiles(cx: number, cy: number, zoom: number): { x: number; y: number; dist: number }[] {
    const list: { x: number; y: number; dist: number }[] = [];
    const maxRadius = 2; // 5x5 grid = up to 25 tiles

    for (let dy = -maxRadius; dy <= maxRadius; dy++) {
      for (let dx = -maxRadius; dx <= maxRadius; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        list.push({
          x: cx + dx,
          y: cy + dy,
          dist,
        });
      }
    }

    // Progressive refinement order: screen center first, then expanding outward
    list.sort((a, b) => a.dist - b.dist);
    return list;
  }

  private tileIntersectsTerrain(x: number, y: number, zoom: number): boolean {
    const nw = tileToLatLon(x, y, zoom);
    const se = tileToLatLon(x + 1, y + 1, zoom);
    const bounds = this.options.terrainGeoBounds;

    const tileMinLat = Math.min(nw.lat, se.lat);
    const tileMaxLat = Math.max(nw.lat, se.lat);
    const tileMinLon = Math.min(nw.lon, se.lon);
    const tileMaxLon = Math.max(nw.lon, se.lon);

    return !(
      tileMaxLon < bounds.minLon ||
      tileMinLon > bounds.maxLon ||
      tileMaxLat < bounds.minLat ||
      tileMinLat > bounds.maxLat
    );
  }

  private scheduleTileFetches(
    candidates: { x: number; y: number; dist: number }[],
    provider: ImageryProvider,
    zoom: number
  ): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const generation = ++this.currentGeneration;
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const activeKeys = new Set<string>();

    for (const c of candidates) {
      const key = `${this.currentTextureStyle}:${zoom}:${c.x}:${c.y}`;
      activeKeys.add(key);

      const existing = this.patches.get(key);
      if (existing) {
        existing.lastUsed = now;
        existing.centerDist = c.dist;
        continue;
      }

      // Load tile asynchronously
      this.inFlightRequests++;
      TileImageCache.loadTile(provider, zoom, c.x, c.y, 4500, signal)
        .then((img) => {
          this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
          if (this.isDisposed || generation !== this.currentGeneration || signal.aborted) {
            return;
          }
          this.createAndMountPatch(key, zoom, c.x, c.y, img, c.dist, now);
        })
        .catch(() => {
          this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
          // Graceful degradation: overview base texture remains visible
        });
    }

    // Prune distant/obsolete patches exceeding budget
    this.prunePatches(activeKeys);
  }

  private createAndMountPatch(
    key: string,
    zoom: number,
    x: number,
    y: number,
    img: HTMLImageElement,
    dist: number,
    now: number
  ): void {
    if (this.patches.has(key)) return;

    // Create GPU Texture
    const texture = new THREE.CanvasTexture(img);
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;

    // Build conforming terrain geometry
    const geo = this.buildPatchGeometry(zoom, x, y);

    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.85,
      metalness: 0.05,
      // Polygon offset prevents z-fighting with the base terrain mesh
      polygonOffset: true,
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -1.0,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `ImageryPatch_${key}`;
    this.group.add(mesh);

    const patch: ImageryPatch = {
      key,
      zoom,
      x,
      y,
      mesh,
      texture,
      lastUsed: now,
      centerDist: dist,
      dispose: () => {
        this.group.remove(mesh);
        geo.dispose();
        mat.dispose();
        texture.dispose();
      },
    };

    this.patches.set(key, patch);
    this.patchesCreatedTotal++;

    // Enforce patch budget
    if (this.patches.size > this.maxPatches) {
      this.evictFurthestPatch();
    }
  }

  private buildPatchGeometry(zoom: number, x: number, y: number): THREE.BufferGeometry {
    const nw = tileToLatLon(x, y, zoom);
    const se = tileToLatLon(x + 1, y + 1, zoom);

    const segments = 12; // 12x12 grid per tile
    const numVerts = (segments + 1) * (segments + 1);

    const positions = new Float32Array(numVerts * 3);
    const uvs = new Float32Array(numVerts * 2);
    const indices: number[] = [];

    const centerLat = this.options.terrainGeoBounds.centerLat;
    const centerLon = this.options.terrainGeoBounds.centerLon;
    const baseElevation = this.options.terrainBaseElevation;

    let vIdx = 0;
    for (let j = 0; j <= segments; j++) {
      const v = j / segments;
      const yVal = y + v;
      // Exact Web Mercator inverse projection for latitude
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yVal) / 2 ** zoom)));
      const lat = radToDeg(latRad);

      for (let i = 0; i <= segments; i++) {
        const u = i / segments;
        const lon = nw.lon + u * (se.lon - nw.lon);

        const loc = geoToLocalMeters(lat, lon, 0, centerLat, centerLon, baseElevation);
        const groundEle = this.options.elevationSampler(loc.x, loc.z);
        const yPos = (groundEle - baseElevation) * this.verticalExaggeration + 0.04;

        positions[vIdx * 3] = loc.x;
        positions[vIdx * 3 + 1] = yPos;
        positions[vIdx * 3 + 2] = loc.z;

        uvs[vIdx * 2] = u;
        uvs[vIdx * 2 + 1] = 1 - v;

        vIdx++;
      }
    }

    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * (segments + 1) + i;
        const b = a + 1;
        const c = a + (segments + 1);
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return geo;
  }

  private updatePatchGeometryHeights(geo: THREE.BufferGeometry): void {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const baseElevation = this.options.terrainBaseElevation;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const groundEle = this.options.elevationSampler(x, z);
      const y = (groundEle - baseElevation) * this.verticalExaggeration + 0.04;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private prunePatches(activeKeys: Set<string>): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const RETENTION_MS = 6000; // Keep patches for 6s after leaving immediate frustum

    for (const [key, patch] of this.patches.entries()) {
      if (!activeKeys.has(key) && now - patch.lastUsed > RETENTION_MS) {
        patch.dispose();
        this.patches.delete(key);
        this.patchesDisposedTotal++;
      }
    }
  }

  private evictFurthestPatch(): void {
    let furthestKey: string | null = null;
    let maxDist = -1;

    for (const [key, patch] of this.patches.entries()) {
      if (patch.centerDist > maxDist) {
        maxDist = patch.centerDist;
        furthestKey = key;
      }
    }

    if (furthestKey) {
      const patch = this.patches.get(furthestKey);
      if (patch) {
        patch.dispose();
        this.patches.delete(furthestKey);
        this.patchesDisposedTotal++;
      }
    }
  }

  private clearAllPatches(): void {
    for (const patch of this.patches.values()) {
      patch.dispose();
      this.patchesDisposedTotal++;
    }
    this.patches.clear();
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.abortController?.abort();
    this.abortController = null;

    this.clearAllPatches();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    disposeObject3D(this.group);
  }
}
