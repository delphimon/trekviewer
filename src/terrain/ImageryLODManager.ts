import * as THREE from 'three';
import type { GeoBounds, TextureStyle } from '../gpx/TrackTypes.ts';
import {
  geoToLocalMeters,
  localMetersToGeo,
  latLonToTile,
  degToRad,
  radToDeg,
  clampLatitude,
  metersPerPixelAtZoom,
  tileBounds,
} from '../gpx/Coordinates.ts';
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
  maxConcurrency?: number;
  enableInXR?: boolean;
}

export interface ImageryLODDiagnostics {
  activePatchesCount: number;
  targetZoom: number;
  calculatedDesiredZoom: number;
  effectiveProviderClampedZoom: number;
  providerMaxZoom: number;
  inFlightRequests: number;
  requestQueueLength: number;
  pendingRequestsCount: number;
  patchesCreatedTotal: number;
  patchesDisposedTotal: number;
  generation: number;
}

interface PendingTileRequest {
  key: string;
  zoom: number;
  x: number;
  y: number;
  dist: number;
  style: TextureStyle;
  abortController: AbortController;
}

interface QueuedTile {
  key: string;
  zoom: number;
  x: number;
  y: number;
  dist: number;
  style: TextureStyle;
}

/**
 * ImageryLODManager
 *
 * Implements Stage R2: Bounded Adaptive High-Resolution Map Imagery Lifecycle.
 *
 * Features:
 * - Web Mercator ground-resolution-based target zoom selection with hysteresis.
 * - Dynamic view footprint / region of interest (not fixed center grid).
 * - Desired-tile reconciliation (replaces all-or-nothing generation aborts).
 * - Bounded request scheduler with concurrency limits and distance priority.
 * - Conforming terrain patch meshes with true local-Y datum coordinates.
 * - Decoupled GPU patch lifecycle and LRU caching.
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

  private currentTextureStyle: TextureStyle;
  private verticalExaggeration: number;
  private maxPatches: number;
  private maxConcurrency: number;
  private enableInXR: boolean;

  // Reconciliation state (Section 14 & 30)
  private desiredTileKeys: Set<string> = new Set();
  private pendingRequests: Map<string, PendingTileRequest> = new Map();
  private requestQueue: QueuedTile[] = [];
  private activeRequestCount: number = 0;

  // View state tracking & debouncing
  private currentTargetZoom: number = 14;
  private calculatedDesiredZoom: number = 14;
  private providerMaxZoom: number = 19;
  private lastEvalTime: number = 0;
  private readonly EVAL_INTERVAL_MS: number = 250; // 4 evaluations/sec max

  private lastCamPos: THREE.Vector3 = new THREE.Vector3();
  private lastCamDir: THREE.Vector3 = new THREE.Vector3();
  private lastDioramaScale: number = 1.0;

  // Telemetry & diagnostics
  private patchesCreatedTotal: number = 0;
  private patchesDisposedTotal: number = 0;

  constructor(options: ImageryLODManagerOptions) {
    this.options = options;
    this.currentTextureStyle = options.textureStyle || 'satellite';
    this.verticalExaggeration = options.verticalExaggeration ?? 1.0;
    this.maxPatches = options.maxPatches ?? 36;
    this.maxConcurrency = options.maxConcurrency ?? 6;
    this.enableInXR = options.enableInXR ?? false;

    this.group = new THREE.Group();
    this.group.name = 'ImageryLODGroup';
  }

  public getDiagnostics(): ImageryLODDiagnostics {
    return {
      activePatchesCount: this.patches.size,
      targetZoom: this.currentTargetZoom,
      calculatedDesiredZoom: this.calculatedDesiredZoom,
      effectiveProviderClampedZoom: this.currentTargetZoom,
      providerMaxZoom: this.providerMaxZoom,
      inFlightRequests: this.activeRequestCount,
      requestQueueLength: this.requestQueue.length,
      pendingRequestsCount: this.pendingRequests.size,
      patchesCreatedTotal: this.patchesCreatedTotal,
      patchesDisposedTotal: this.patchesDisposedTotal,
      generation: this.currentGeneration,
    };
  }

  public setDeviceProfile(isQuest: boolean): void {
    if (isQuest) {
      this.maxPatches = 24;
      this.maxConcurrency = 4;
    } else {
      this.maxPatches = 36;
      this.maxConcurrency = 6;
    }
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
    this.currentGeneration++;

    // Abort pending consumer requests
    for (const pending of this.pendingRequests.values()) {
      pending.abortController.abort();
    }
    this.pendingRequests.clear();
    this.requestQueue = [];
    this.desiredTileKeys.clear();
    this.activeRequestCount = 0;

    // Clear all existing patch meshes so old style never floats over new style
    this.clearAllPatches();
  }

  /**
   * Main per-frame update method called from scene render loop.
   * Debounced and movement-thresholded to prevent high-frequency tracking churn.
   */
  public update(camera: THREE.Camera, dioramaRoot: THREE.Group, isXR: boolean = false): void {
    if (this.isDisposed || !ENABLE_ADAPTIVE_IMAGERY_LOD) return;

    // Desktop-first gate until explicitly enabled in XR stage
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

    const camPos = camera.position;
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const dioramaScale = dioramaRoot.scale.x;

    const posDelta = camPos.distanceTo(this.lastCamPos);
    const dirAngle = camDir.angleTo(this.lastCamDir);
    const scaleRatio = Math.abs(dioramaScale - this.lastDioramaScale) / Math.max(this.lastDioramaScale, 0.001);

    const isFirstRun = this.lastEvalTime === 0;
    if (!isFirstRun && posDelta < 0.04 && dirAngle < 0.03 && scaleRatio < 0.04) {
      return; // Under movement threshold, view converged cleanly
    }

    this.lastEvalTime = now;
    this.lastCamPos.copy(camPos);
    this.lastCamDir.copy(camDir);
    this.lastDioramaScale = dioramaScale;

    this.evaluateLOD(camera, dioramaRoot);
  }

  /**
   * Pure zoom calculation function based on Web Mercator ground texel density.
   * Supports hysteresis and provider clamping.
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
    // Displayed metric extent per viewport pixel
    const metersPerPixel = (2 * cameraDist * Math.tan(fovRad / 2)) / Math.max(viewportHeightPx, 480);
    const localMetersPerPixel = metersPerPixel / Math.max(dioramaScale, 0.000001);

    const latRad = degToRad(clampLatitude(centerLat));
    const earthCircumferenceMeters = 2 * Math.PI * 6378137 * Math.cos(latRad);
    const rawZoom = Math.log2((earthCircumferenceMeters / 256) / Math.max(localMetersPerPixel, 0.01));

    // Quality multiplier 1.25 -> +0.32 in log2 space
    const biasedZoom = rawZoom + 0.35;
    let targetZ = Math.round(biasedZoom);

    // Zoom hysteresis (Section 31): require > 0.6 drift above or > 0.7 below to promote/demote
    if (currentZoom !== undefined) {
      if (biasedZoom > currentZoom + 0.6) {
        targetZ = Math.round(biasedZoom);
      } else if (biasedZoom < currentZoom - 0.7) {
        targetZ = Math.round(biasedZoom);
      } else {
        targetZ = currentZoom;
      }
    }

    // Minimum patch zoom: 13. Maximum: clamped strictly to provider maxZoom (Section 19)
    return Math.max(13, Math.min(providerMaxZoom, targetZ));
  }

  /**
   * Pure helper to test whether a tile intersects the terrain geographic bounds.
   */
  public static tileIntersectsBounds(x: number, y: number, zoom: number, bounds: GeoBounds): boolean {
    const tb = tileBounds(x, y, zoom);
    return !(
      tb.maxLon < bounds.minLon ||
      tb.minLon > bounds.maxLon ||
      tb.maxLat < bounds.minLat ||
      tb.minLat > bounds.maxLat
    );
  }

  private evaluateLOD(camera: THREE.Camera, dioramaRoot: THREE.Group): void {
    const provider = TextureProvider.getProviderForStyle(this.currentTextureStyle);
    this.providerMaxZoom = provider.maxZoom;
    const centerLat = this.options.terrainGeoBounds.centerLat;

    // Estimate distance to diorama center in world space
    const dioramaWorldPos = new THREE.Vector3();
    dioramaRoot.getWorldPosition(dioramaWorldPos);
    const camDist = Math.max(camera.position.distanceTo(dioramaWorldPos), 0.2);
    const dioramaScale = dioramaRoot.scale.x;

    const fov = (camera as THREE.PerspectiveCamera).fov || 60;
    const vHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const targetZoom = ImageryLODManager.calculateTargetZoom(
      camDist,
      dioramaScale,
      centerLat,
      fov,
      vHeight,
      provider.maxZoom,
      this.currentTargetZoom
    );

    this.calculatedDesiredZoom = targetZoom;
    this.currentTargetZoom = targetZoom;

    // Determine target center point on the diorama
    const ray = new THREE.Ray(camera.position, this.lastCamDir);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dioramaWorldPos.y);
    const hit = new THREE.Vector3();

    let targetGeo = { lat: centerLat, lon: this.options.terrainGeoBounds.centerLon };

    if (ray.intersectPlane(plane, hit)) {
      const localHit = hit.clone();
      dioramaRoot.worldToLocal(localHit);

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

    // Dynamic region-of-interest footprint calculation (Section 9)
    const vWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const aspect = Math.max(0.5, Math.min(2.5, vWidth / vHeight));
    const fovRad = degToRad(fov);
    const halfVisibleH = (camDist * Math.tan(fovRad / 2)) / Math.max(dioramaScale, 0.000001);
    const halfVisibleW = halfVisibleH * aspect;
    const visibleRadiusLocalMeters = Math.hypot(halfVisibleW, halfVisibleH);

    const tileSpanMeters = metersPerPixelAtZoom(targetGeo.lat, targetZoom) * 256;
    const rawRadius = Math.ceil((visibleRadiusLocalMeters * 1.3) / Math.max(tileSpanMeters, 1));
    const tileRadius = Math.max(1, Math.min(4, rawRadius));

    const centerTile = latLonToTile(targetGeo.lat, targetGeo.lon, targetZoom);
    const candidates = this.collectCandidateTiles(centerTile.x, centerTile.y, targetZoom, tileRadius);

    // Filter candidate tiles that intersect actual terrain geographic bounds
    const validCandidates = candidates.filter((tile) =>
      ImageryLODManager.tileIntersectsBounds(tile.x, tile.y, targetZoom, this.options.terrainGeoBounds)
    );

    // Limit desired candidates to budget
    const budgetedCandidates = validCandidates.slice(0, this.maxPatches);

    // Reconcile desired tiles with in-flight and visible patches (Section 14 & 30)
    this.reconcileDesiredTiles(budgetedCandidates, provider, targetZoom);
  }

  private collectCandidateTiles(
    cx: number,
    cy: number,
    zoom: number,
    radius: number
  ): { x: number; y: number; dist: number }[] {
    const list: { x: number; y: number; dist: number }[] = [];
    const maxCoord = (2 ** zoom) - 1;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist = Math.hypot(dx, dy);
        if (dist <= radius + 0.5) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (tx >= 0 && tx <= maxCoord && ty >= 0 && ty <= maxCoord) {
            list.push({
              x: tx,
              y: ty,
              dist,
            });
          }
        }
      }
    }

    // Sort priority: center tiles first, expanding outward (Section 30)
    list.sort((a, b) => a.dist - b.dist);
    return list;
  }

  /**
   * Reconciles desired candidate tiles against active and pending tiles.
   * Cancels consumer subscriptions for obsolete requests without aborting useful shared work.
   */
  private reconcileDesiredTiles(
    candidates: { x: number; y: number; dist: number }[],
    provider: ImageryProvider,
    zoom: number
  ): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const newDesiredKeys = new Set<string>();
    const candidateMap = new Map<string, { x: number; y: number; dist: number }>();

    for (const c of candidates) {
      const key = `${this.currentTextureStyle}:${zoom}:${c.x}:${c.y}`;
      newDesiredKeys.add(key);
      candidateMap.set(key, c);
    }

    this.desiredTileKeys = newDesiredKeys;

    // 1. Update lastUsed for already visible patches
    for (const [key, patch] of this.patches.entries()) {
      if (newDesiredKeys.has(key)) {
        patch.lastUsed = now;
        const c = candidateMap.get(key);
        if (c) patch.centerDist = c.dist;
      }
    }

    // 2. Cancel pending requests no longer in desired set (Section 14)
    for (const [key, pending] of this.pendingRequests.entries()) {
      if (!newDesiredKeys.has(key)) {
        pending.abortController.abort();
        this.pendingRequests.delete(key);
      }
    }

    // 3. Rebuild prioritized request queue for desired tiles not yet visible or pending
    this.requestQueue = [];
    for (const [key, c] of candidateMap.entries()) {
      if (!this.patches.has(key) && !this.pendingRequests.has(key)) {
        this.requestQueue.push({
          key,
          zoom,
          x: c.x,
          y: c.y,
          dist: c.dist,
          style: this.currentTextureStyle,
        });
      }
    }

    // Priority sort: lowest distance from view center first
    this.requestQueue.sort((a, b) => a.dist - b.dist);

    // 4. Drain queue up to concurrency limit
    this.drainQueue(provider);

    // 5. Prune expired or distant patches exceeding budget
    this.prunePatches(newDesiredKeys);
  }

  /**
   * Bounded scheduler processing tile requests up to concurrency limit (Section 30).
   */
  private drainQueue(provider: ImageryProvider): void {
    if (this.isDisposed) return;

    while (this.activeRequestCount < this.maxConcurrency && this.requestQueue.length > 0) {
      const next = this.requestQueue.shift();
      if (!next) break;

      // Verify request is still desired
      if (!this.desiredTileKeys.has(next.key) || this.patches.has(next.key)) {
        continue;
      }

      const abortController = new AbortController();
      const pending: PendingTileRequest = {
        ...next,
        abortController,
      };

      this.pendingRequests.set(next.key, pending);
      this.activeRequestCount++;

      const requestStyle = this.currentTextureStyle;
      TileImageCache.loadTile(provider, next.zoom, next.x, next.y, 4500, abortController.signal)
        .then((img) => {
          this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
          this.pendingRequests.delete(next.key);

          if (
            !this.isDisposed &&
            !abortController.signal.aborted &&
            this.desiredTileKeys.has(next.key) &&
            this.currentTextureStyle === requestStyle
          ) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this.createAndMountPatch(next.key, next.zoom, next.x, next.y, img, next.dist, now);
          }

          this.drainQueue(provider);
        })
        .catch(() => {
          this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
          this.pendingRequests.delete(next.key);
          this.drainQueue(provider);
        });
    }
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

    // Build conforming terrain geometry with true local Y datum
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
    const tb = tileBounds(x, y, zoom);
    const nw = tb.nw;
    const se = tb.se;

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
        const groundLocalY = this.options.elevationSampler(loc.x, loc.z);
        const yPos = groundLocalY * this.verticalExaggeration + 0.04;

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

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const groundLocalY = this.options.elevationSampler(x, z);
      const y = groundLocalY * this.verticalExaggeration + 0.04;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private prunePatches(activeKeys: Set<string>): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const RETENTION_MS = 6000; // Keep inactive patches for 6s before disposing

    // Dispose patches that have expired and are no longer desired
    for (const [key, patch] of this.patches.entries()) {
      if (!activeKeys.has(key) && now - patch.lastUsed > RETENTION_MS) {
        patch.dispose();
        this.patches.delete(key);
        this.patchesDisposedTotal++;
      }
    }

    // If still exceeding budget, evict furthest inactive patches first
    while (this.patches.size > this.maxPatches) {
      let candidateKey: string | null = null;
      let maxDist = -1;

      for (const [key, patch] of this.patches.entries()) {
        if (!activeKeys.has(key) && patch.centerDist > maxDist) {
          maxDist = patch.centerDist;
          candidateKey = key;
        }
      }

      // If all are currently active, evict furthest active patch
      if (!candidateKey) {
        for (const [key, patch] of this.patches.entries()) {
          if (patch.centerDist > maxDist) {
            maxDist = patch.centerDist;
            candidateKey = key;
          }
        }
      }

      if (candidateKey) {
        const patch = this.patches.get(candidateKey);
        patch?.dispose();
        this.patches.delete(candidateKey);
        this.patchesDisposedTotal++;
      } else {
        break;
      }
    }
  }

  private evictFurthestPatch(): void {
    let furthestKey: string | null = null;
    let maxDist = -1;

    for (const [key, patch] of this.patches.entries()) {
      if (!this.desiredTileKeys.has(key) && patch.centerDist > maxDist) {
        maxDist = patch.centerDist;
        furthestKey = key;
      }
    }

    if (!furthestKey) {
      for (const [key, patch] of this.patches.entries()) {
        if (patch.centerDist > maxDist) {
          maxDist = patch.centerDist;
          furthestKey = key;
        }
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

    for (const pending of this.pendingRequests.values()) {
      pending.abortController.abort();
    }
    this.pendingRequests.clear();
    this.requestQueue = [];
    this.desiredTileKeys.clear();
    this.activeRequestCount = 0;

    this.clearAllPatches();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    disposeObject3D(this.group);
  }
}
