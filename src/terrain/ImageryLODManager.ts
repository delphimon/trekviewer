import * as THREE from 'three';
import type { GeoBounds, TextureStyle, ViewMode } from '../gpx/TrackTypes.ts';
import { latLonToTile, localMetersToGeo, geoToLocalMeters, degToRad } from '../gpx/Coordinates.ts';
import { TextureBudget } from './TextureBudget.ts';
import { TileImageCache } from './TileImageCache.ts';
import { TileRequestScheduler } from './TileRequestScheduler.ts';
import { ImageryPatch } from './ImageryPatch.ts';
import {
  TextureProvider,
} from './TextureProvider.ts';
import {
  EsriWorldImageryProvider,
  USGSTopoProvider,
  EsriReferenceOverlayProvider,
  type ImageryProvider,
} from './providers/ImageryProvider.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface ImageryLODOptions {
  bounds: GeoBounds;
  terrainBaseElevation: number;
  centerLat: number;
  centerLon: number;
  elevationSampler: (x: number, z: number) => number;
  baseZoom: number;
  initialExaggeration?: number;
  initialStyle?: TextureStyle;
  isXR?: boolean;
}

export class ImageryLODManager {
  public readonly group: THREE.Group;

  private bounds: GeoBounds;
  private terrainBaseElevation: number;
  private centerLat: number;
  private centerLon: number;
  private elevationSampler: (x: number, z: number) => number;
  private baseZoom: number;
  private currentExaggeration: number;
  private currentStyle: TextureStyle;

  private currentTargetZoom: number;
  private activePatches: Map<string, ImageryPatch> = new Map();
  private scheduler: TileRequestScheduler;
  private maxPatches: number;

  private lastCheckTime: number = 0;
  private debounceTimer: number | null = null;
  private isDisposed: boolean = false;
  private abortController: AbortController = new AbortController();

  private static esriSatelliteProvider = new EsriWorldImageryProvider();
  private static usgsTopoProvider = new USGSTopoProvider();
  private static esriOverlayProvider = new EsriReferenceOverlayProvider();

  constructor(options: ImageryLODOptions) {
    this.bounds = options.bounds;
    this.terrainBaseElevation = options.terrainBaseElevation;
    this.centerLat = options.centerLat;
    this.centerLon = options.centerLon;
    this.elevationSampler = options.elevationSampler;
    this.baseZoom = options.baseZoom;
    this.currentTargetZoom = options.baseZoom;
    this.currentExaggeration = options.initialExaggeration ?? 1.0;
    this.currentStyle = options.initialStyle ?? 'satellite';

    const isConstrained = options.isXR || TextureBudget.isQuestHeadset();
    this.maxPatches = isConstrained ? 32 : 64;
    this.scheduler = new TileRequestScheduler(isConstrained ? 4 : 8);

    this.group = new THREE.Group();
    this.group.name = 'ImageryLODPatches';
  }

  public setVerticalExaggeration(factor: number): void {
    if (this.isDisposed || Math.abs(this.currentExaggeration - factor) < 0.001) return;
    this.currentExaggeration = factor;
    for (const patch of this.activePatches.values()) {
      patch.setVerticalExaggeration(factor);
    }
  }

  public setTextureStyle(style: TextureStyle): void {
    if (this.isDisposed || this.currentStyle === style) return;
    this.currentStyle = style;

    // Cancel pending requests for old style and evict existing refinement patches
    this.scheduler.cancelPending();
    this.clearPatches();

    // Trigger update for new style
    this.scheduleDebouncedUpdate();
  }

  public update(
    camera: THREE.Camera,
    dioramaRoot: THREE.Group,
    viewMode: ViewMode,
    delta: number
  ): void {
    if (this.isDisposed) return;

    this.lastCheckTime += delta;
    // Check at ~4Hz (every 250ms)
    if (this.lastCheckTime < 0.25) return;
    this.lastCheckTime = 0;

    this.evaluateLOD(camera, dioramaRoot, viewMode);
  }

  private evaluateLOD(
    camera: THREE.Camera,
    dioramaRoot: THREE.Group,
    viewMode: ViewMode
  ): void {
    // 1. Calculate effective viewing distance and required ground resolution (meters per pixel)
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    const fovRad = degToRad(fov);
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 1080;

    let targetZoom = this.baseZoom;
    let lookCenterLocal: { x: number; z: number };
    let radiusMeters: number;

    const dioramaScale = dioramaRoot.scale.x;

    if (viewMode === 'first-person') {
      // In 1:1 trail mode: camera is at true scale (scale = 1.0)
      const camPos = camera.position;
      const camLocal = dioramaRoot.worldToLocal(camPos.clone());
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

      // Focus point 250m ahead on trail/gaze
      lookCenterLocal = {
        x: camLocal.x + forward.x * 250,
        z: camLocal.z + forward.z * 250,
      };
      radiusMeters = 800; // 800m refinement bubble around hiker

      // In 1:1 trail mode, target zoom is high (zoom 16-17)
      targetZoom = Math.min(this.baseZoom + 4, 17);
    } else {
      // Tabletop diorama mode
      const camPos = camera.position;
      const dioramaWorldPos = new THREE.Vector3();
      dioramaRoot.getWorldPosition(dioramaWorldPos);

      const distanceToTabletop = camPos.distanceTo(dioramaWorldPos);
      const effectiveDistanceMeters = distanceToTabletop / Math.max(dioramaScale, 0.00001);

      // Frustum height at terrain distance in unscaled world meters
      const frustumHeightM = 2 * effectiveDistanceMeters * Math.tan(fovRad / 2);
      const metersPerPixel = frustumHeightM / viewportH;

      // Web Mercator resolution formula: metersPerPixel = (156543.03392 * cos(lat)) / 2^zoom
      const latRad = degToRad(this.centerLat);
      const idealZoom = Math.log2((156543.03392 * Math.cos(latRad)) / Math.max(metersPerPixel, 0.1));

      // Hysteresis: only step up at +0.65, only step down at -0.65
      if (idealZoom > this.currentTargetZoom + 0.65) {
        targetZoom = Math.min(Math.round(idealZoom), this.baseZoom + 4);
      } else if (idealZoom < this.currentTargetZoom - 0.65) {
        targetZoom = Math.max(Math.round(idealZoom), this.baseZoom);
      } else {
        targetZoom = this.currentTargetZoom;
      }

      // Clamp between baseZoom and 17 (or max supported by provider)
      targetZoom = Math.max(this.baseZoom, Math.min(targetZoom, 17));

      // Look center is center of diorama in tabletop mode
      lookCenterLocal = { x: 0, z: 0 };
      radiusMeters = (frustumHeightM * 0.6);
    }

    this.currentTargetZoom = targetZoom;

    // If target zoom equals baseZoom, refinement patches are not needed (base texture is sufficient)
    if (targetZoom <= this.baseZoom) {
      if (this.activePatches.size > 0) {
        this.clearPatches();
      }
      return;
    }

    // 2. Identify visible geographic bounds around lookCenter
    const centerGeo = localMetersToGeo(lookCenterLocal.x, lookCenterLocal.z, this.centerLat, this.centerLon);

    // Approximate radius in degrees lat/lon
    const latDelta = (radiusMeters / 111320);
    const lonDelta = (radiusMeters / (111320 * Math.cos(degToRad(centerGeo.lat))));

    const minLat = Math.max(this.bounds.minLat, centerGeo.lat - latDelta);
    const maxLat = Math.min(this.bounds.maxLat, centerGeo.lat + latDelta);
    const minLon = Math.max(this.bounds.minLon, centerGeo.lon - lonDelta);
    const maxLon = Math.min(this.bounds.maxLon, centerGeo.lon + lonDelta);

    if (minLat >= maxLat || minLon >= maxLon) return;

    // 3. Determine Slippy Map tiles covering this region at targetZoom
    const nwTile = latLonToTile(maxLat, minLon, targetZoom);
    const seTile = latLonToTile(minLat, maxLon, targetZoom);

    const tileXMin = Math.min(nwTile.x, seTile.x);
    const tileXMax = Math.max(nwTile.x, seTile.x);
    const tileYMin = Math.min(nwTile.y, seTile.y);
    const tileYMax = Math.max(nwTile.y, seTile.y);

    // Calculate center tile coordinates for distance sorting
    const centerTile = latLonToTile(centerGeo.lat, centerGeo.lon, targetZoom);

    const candidateTiles: Array<{ x: number; y: number; distSq: number }> = [];
    for (let ty = tileYMin; ty <= tileYMax; ty++) {
      for (let tx = tileXMin; tx <= tileXMax; tx++) {
        const dx = tx - centerTile.x;
        const dy = ty - centerTile.y;
        candidateTiles.push({ x: tx, y: ty, distSq: dx * dx + dy * dy });
      }
    }

    // Sort tiles closest to gaze/center first
    candidateTiles.sort((a, b) => a.distSq - b.distSq);

    // Limit to maxPatches budget
    const neededTiles = candidateTiles.slice(0, this.maxPatches);
    const neededKeys = new Set(neededTiles.map((t) => `${this.currentStyle}:${targetZoom}:${t.x}:${t.y}`));

    // 4. Evict patches that are no longer needed
    for (const [key, patch] of this.activePatches.entries()) {
      if (!neededKeys.has(key)) {
        patch.dispose();
        this.activePatches.delete(key);
      }
    }

    // 5. Fetch and instantiate newly needed patches
    const provider = this.getProviderForStyle(this.currentStyle);

    for (const t of neededTiles) {
      const key = `${this.currentStyle}:${targetZoom}:${t.x}:${t.y}`;
      if (this.activePatches.has(key)) continue;

      this.scheduler.schedule(
        key,
        t.distSq,
        async () => {
          return await this.loadCompositeTile(provider, targetZoom, t.x, t.y);
        },
        this.abortController.signal
      )
        .then((img) => {
          if (this.isDisposed || this.abortController.signal.aborted) return;
          if (this.currentTargetZoom !== targetZoom) return;

          const texture = new THREE.CanvasTexture(img);
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;

          const patch = new ImageryPatch(
            targetZoom,
            t.x,
            t.y,
            this.centerLat,
            this.centerLon,
            this.terrainBaseElevation,
            this.elevationSampler,
            this.currentExaggeration,
            texture
          );

          this.activePatches.set(key, patch);
          this.group.add(patch.mesh);
        })
        .catch(() => {
          // Graceful fallback: base terrain texture remains visible
        });
    }
  }

  private getProviderForStyle(style: TextureStyle): ImageryProvider {
    switch (style) {
      case 'satellite':
        return TextureProvider.getActiveSatelliteProvider();
      case 'hybrid':
        return TextureProvider.getActiveSatelliteProvider();
      case 'topo':
        return ImageryLODManager.usgsTopoProvider;
      default:
        return ImageryLODManager.esriSatelliteProvider;
    }
  }

  private async loadCompositeTile(
    provider: ImageryProvider,
    zoom: number,
    x: number,
    y: number
  ): Promise<HTMLImageElement> {
    const baseImg = await TileImageCache.loadTile(
      provider,
      zoom,
      x,
      y,
      4000,
      this.abortController.signal
    );

    if (this.currentStyle !== 'hybrid') {
      return baseImg;
    }

    // For hybrid mode: composite reference overlay labels over satellite tile
    try {
      const labelImg = await TileImageCache.loadTile(
        ImageryLODManager.esriOverlayProvider,
        zoom,
        x,
        y,
        3500,
        this.abortController.signal
      );

      const canvas = document.createElement('canvas');
      canvas.width = baseImg.width || 256;
      canvas.height = baseImg.height || 256;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(baseImg, 0, 0);
        ctx.drawImage(labelImg, 0, 0);
        const compositeImg = new Image();
        compositeImg.src = canvas.toDataURL();
        return compositeImg;
      }
    } catch {
      // Fallback to base satellite tile if overlay fails
    }

    return baseImg;
  }

  private scheduleDebouncedUpdate(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = (setTimeout(() => {
      this.debounceTimer = null;
      // Triggered on next update frame
    }, 250) as unknown) as number;
  }

  private clearPatches(): void {
    for (const patch of this.activePatches.values()) {
      patch.dispose();
    }
    this.activePatches.clear();
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
  }

  public getLODStats(): {
    activePatches: number;
    targetZoom: number;
    baseZoom: number;
    memoryBytes: number;
    inFlight: number;
    queued: number;
  } {
    const schedStats = this.scheduler.getStats();
    return {
      activePatches: this.activePatches.size,
      targetZoom: this.currentTargetZoom,
      baseZoom: this.baseZoom,
      memoryBytes: TileImageCache.getMemoryBytes(),
      inFlight: schedStats.inFlight,
      queued: schedStats.queued,
    };
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.abortController.abort();
    this.scheduler.clear();
    this.clearPatches();
    disposeObject3D(this.group);
  }
}
