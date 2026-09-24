import * as THREE from 'three';
import type { GeoBounds } from '../gpx/TrackTypes.ts';
import { latLonToTile } from '../gpx/Coordinates.ts';
import type { ImageryProvider } from './providers/ImageryProvider.ts';
import {
  EsriWorldImageryProvider,
  CesiumBingImageryProvider,
  USGSTopoProvider,
  EsriReferenceOverlayProvider,
} from './providers/ImageryProvider.ts';
import { TileImageCache } from './TileImageCache.ts';
import { TextureBudget } from './TextureBudget.ts';

export interface TileGridBounds {
  zoom: number;
  tileXMin: number;
  tileXMax: number;
  tileYMin: number;
  tileYMax: number;
  numTilesX: number;
  numTilesY: number;
}

export class TextureProvider {
  private static esriSatelliteProvider = new EsriWorldImageryProvider();
  private static usgsTopoProvider = new USGSTopoProvider();
  private static referenceOverlayProvider = new EsriReferenceOverlayProvider();
  private static cesiumProvider: CesiumBingImageryProvider | null = null;
  private static activeSatelliteProvider: ImageryProvider = TextureProvider.esriSatelliteProvider;
  private static maxAnisotropy: number = 4; // Bounded default for non-WebGL/test environments

  public static readonly UPLOAD_THROTTLE_MS: number = 600; // Req #26: Throttle whole-route composite canvas uploads (500-1000ms)
  public static readonly TILE_BATCH_THRESHOLD: number = 8; // Req #26: Or every N tiles, whichever happens first

  public static setMaxAnisotropy(anisotropy: number): void {
    if (typeof anisotropy === 'number' && !isNaN(anisotropy) && anisotropy >= 0) {
      this.maxAnisotropy = Math.max(1, Math.min(16, anisotropy));
    }
  }

  public static getMaxAnisotropy(): number {
    return this.maxAnisotropy;
  }

  static {
    // Check if Cesium token is configured in Vite environment
    const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    const cesiumToken = metaEnv ? (metaEnv.VITE_CESIUM_ION_TOKEN as string | undefined) : undefined;

    if (cesiumToken && cesiumToken.trim().length > 10) {
      this.cesiumProvider = new CesiumBingImageryProvider(cesiumToken.trim());
      this.cesiumProvider.init().then((success) => {
        if (success && this.cesiumProvider) {
          this.activeSatelliteProvider = this.cesiumProvider;
        }
      }).catch(() => {
        this.activeSatelliteProvider = this.esriSatelliteProvider;
      });
    } else {
      this.activeSatelliteProvider = this.esriSatelliteProvider;
    }
  }

  public static getActiveSatelliteProvider(): ImageryProvider {
    return this.activeSatelliteProvider;
  }

  public static getReferenceOverlayProvider(): ImageryProvider {
    return this.referenceOverlayProvider;
  }

  public static getProviderForStyle(style: string): ImageryProvider {
    switch (style) {
      case 'topo':
        return this.usgsTopoProvider;
      case 'satellite':
      case 'hybrid':
      default:
        return this.activeSatelliteProvider;
    }
  }

  public static getAttributionForStyle(style: string): string {
    switch (style) {
      case 'satellite':
        return this.activeSatelliteProvider.attribution;
      case 'hybrid':
        return `${this.activeSatelliteProvider.attribution} | ${this.referenceOverlayProvider.attribution}`;
      case 'topo':
        return this.usgsTopoProvider.attribution;
      default:
        return 'Map data: Esri, USGS, AWS Open Data';
    }
  }

  public static getTileGridForBounds(
    bounds: GeoBounds,
    marginRatio: number = 0.25
  ): TileGridBounds {
    const latMargin = (bounds.maxLat - bounds.minLat) * marginRatio;
    const lonMargin = (bounds.maxLon - bounds.minLon) * marginRatio;
    const minLat = bounds.minLat - latMargin;
    const maxLat = bounds.maxLat + latMargin;
    const minLon = bounds.minLon - lonMargin;
    const maxLon = bounds.maxLon + lonMargin;

    const latSpan = maxLat - minLat;
    let zoom = 15;
    if (latSpan < 0.08) zoom = 16;
    else if (latSpan > 0.35) zoom = 14;

    const minTile = latLonToTile(maxLat, minLon, zoom);
    const maxTile = latLonToTile(minLat, maxLon, zoom);

    let tileXMin = Math.min(minTile.x, maxTile.x);
    let tileXMax = Math.max(minTile.x, maxTile.x);
    let tileYMin = Math.min(minTile.y, maxTile.y);
    let tileYMax = Math.max(minTile.y, maxTile.y);

    let numTilesX = tileXMax - tileXMin + 1;
    let numTilesY = tileYMax - tileYMin + 1;

    const MAX_TILES = 120;
    while (numTilesX * numTilesY > MAX_TILES && zoom > 11) {
      zoom--;
      const minT = latLonToTile(maxLat, minLon, zoom);
      const maxT = latLonToTile(minLat, maxLon, zoom);
      tileXMin = Math.min(minT.x, maxT.x);
      tileXMax = Math.max(minT.x, maxT.x);
      tileYMin = Math.min(minT.y, maxT.y);
      tileYMax = Math.max(minT.y, maxT.y);
      numTilesX = tileXMax - tileXMin + 1;
      numTilesY = tileYMax - tileYMin + 1;
    }

    return { zoom, tileXMin, tileXMax, tileYMin, tileYMax, numTilesX, numTilesY };
  }

  /**
   * Calculates the exact UV coordinate on the composite tile canvas for any given lat/lon.
   * Uses exact Web Mercator projection so orthophoto drapes with zero distortion.
   */
  public static getUVForGeo(
    lat: number,
    lon: number,
    grid: TileGridBounds
  ): { u: number; v: number } {
    const n = 2 ** grid.zoom;
    const xGlobal = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yGlobal = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;

    const u = (xGlobal - grid.tileXMin) / grid.numTilesX;
    // In Three.js with flipY=true, v=1 is Top (North: yGlobal = tileYMin), v=0 is Bottom (South)
    const v = 1 - (yGlobal - grid.tileYMin) / grid.numTilesY;

    return {
      u: Math.max(0, Math.min(1, u)),
      v: Math.max(0, Math.min(1, v)),
    };
  }

  /**
   * Fetches high-resolution satellite imagery tiles covering the tile grid bounds.
   * Leverages TileImageCache and TextureBudget to stay within Quest GPU memory constraints.
   */
  public static async fetchSatelliteTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void,
    signal?: AbortSignal,
    isXR: boolean = false
  ): Promise<THREE.CanvasTexture | null> {
    try {
      const TILE_SIZE = 256;
      const { width, height } = TextureBudget.getAssembledTextureSize(
        grid.numTilesX,
        grid.numTilesY,
        isXR,
        TILE_SIZE
      );

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scaleX = canvas.width / (grid.numTilesX * TILE_SIZE);
      const scaleY = canvas.height / (grid.numTilesY * TILE_SIZE);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter; // Req #27: LinearFilter during intermediate progressive composition
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = this.maxAnisotropy;
      texture.generateMipmaps = false; // Req #27: Disable mipmap generation during intermediate compositing

      const provider = this.activeSatelliteProvider;
      const tasks: { tx: number; ty: number }[] = [];
      for (let tx = grid.tileXMin; tx <= grid.tileXMax; tx++) {
        for (let ty = grid.tileYMin; ty <= grid.tileYMax; ty++) {
          tasks.push({ tx, ty });
        }
      }

      const totalCount = tasks.length;
      let completedCount = 0;
      let successCount = 0;
      let tilesSinceLastUpload = 0;
      let lastUpdateTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      const worker = async () => {
        while (tasks.length > 0) {
          if (signal?.aborted) break;
          const task = tasks.shift();
          if (!task) break;
          const { tx, ty } = task;

          const x0 = Math.round((tx - grid.tileXMin) * TILE_SIZE * scaleX);
          const x1 = Math.round((tx - grid.tileXMin + 1) * TILE_SIZE * scaleX);
          const y0 = Math.round((ty - grid.tileYMin) * TILE_SIZE * scaleY);
          const y1 = Math.round((ty - grid.tileYMin + 1) * TILE_SIZE * scaleY);

          try {
            const img = await TileImageCache.loadTile(provider, grid.zoom, tx, ty, 4500, signal);
            ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
            successCount++;
          } catch {
            // Ignore single tile failure
          }

          completedCount++;
          tilesSinceLastUpload++;
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          // Req #26: Throttle whole-route composite canvas uploads (500-1000ms or every N tiles)
          if (
            completedCount < totalCount &&
            (tilesSinceLastUpload >= TextureProvider.TILE_BATCH_THRESHOLD ||
              now - lastUpdateTime >= TextureProvider.UPLOAD_THROTTLE_MS)
          ) {
            lastUpdateTime = now;
            tilesSinceLastUpload = 0;
            texture.needsUpdate = true;
            onProgressUpdate?.(texture, completedCount, totalCount);
          }
        }
      };

      const concurrency = Math.min(12, totalCount);
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);

      if (signal?.aborted) return null;
      if (successCount === 0) return null;

      // Req #27: Enable mipmap generation and LinearMipmapLinearFilter only on final completion
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.needsUpdate = true;
      onProgressUpdate?.(texture, completedCount, totalCount);
      return texture;
    } catch (e) {
      console.warn('Failed to fetch high-res satellite imagery:', e);
      return null;
    }
  }

  /**
   * Fetches high-resolution Hybrid texture (Satellite base + transparent Topographic labels).
   * REUSES previously fetched satellite tiles from TileImageCache so no duplicate imagery is downloaded!
   */
  public static async fetchHybridTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void,
    signal?: AbortSignal,
    isXR: boolean = false
  ): Promise<THREE.CanvasTexture | null> {
    try {
      const TILE_SIZE = 256;
      const { width, height } = TextureBudget.getAssembledTextureSize(
        grid.numTilesX,
        grid.numTilesY,
        isXR,
        TILE_SIZE
      );

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scaleX = canvas.width / (grid.numTilesX * TILE_SIZE);
      const scaleY = canvas.height / (grid.numTilesY * TILE_SIZE);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter; // Req #27: LinearFilter during intermediate progressive composition
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = this.maxAnisotropy;
      texture.generateMipmaps = false; // Req #27: Disable mipmap generation during intermediate compositing

      const satProvider = this.activeSatelliteProvider;
      const labelProvider = this.referenceOverlayProvider;

      const tasks: { tx: number; ty: number }[] = [];
      for (let tx = grid.tileXMin; tx <= grid.tileXMax; tx++) {
        for (let ty = grid.tileYMin; ty <= grid.tileYMax; ty++) {
          tasks.push({ tx, ty });
        }
      }

      const totalCount = tasks.length;
      let completedCount = 0;
      let successCount = 0;
      let tilesSinceLastUpload = 0;
      let lastUpdateTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      const worker = async () => {
        while (tasks.length > 0) {
          if (signal?.aborted) break;
          const task = tasks.shift();
          if (!task) break;
          const { tx, ty } = task;

          const x0 = Math.round((tx - grid.tileXMin) * TILE_SIZE * scaleX);
          const x1 = Math.round((tx - grid.tileXMin + 1) * TILE_SIZE * scaleX);
          const y0 = Math.round((ty - grid.tileYMin) * TILE_SIZE * scaleY);
          const y1 = Math.round((ty - grid.tileYMin + 1) * TILE_SIZE * scaleY);
          const dw = x1 - x0;
          const dh = y1 - y0;

          // 1. Draw base satellite tile (retrieved from cache if satellite was already loaded!)
          let baseDrawn = false;
          try {
            const satImg = await TileImageCache.loadTile(satProvider, grid.zoom, tx, ty, 4500, signal);
            ctx.drawImage(satImg, x0, y0, dw, dh);
            baseDrawn = true;
            successCount++;
          } catch {
            // Base tile load failed
          }

          // 2. Overlay transparent labels & reference data
          if (baseDrawn) {
            try {
              const labelImg = await TileImageCache.loadTile(labelProvider, grid.zoom, tx, ty, 3500, signal);
              ctx.drawImage(labelImg, x0, y0, dw, dh);
            } catch {
              // Ignore single label tile failure
            }
          }

          completedCount++;
          tilesSinceLastUpload++;
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          // Req #26: Throttle whole-route composite canvas uploads (500-1000ms or every N tiles)
          if (
            completedCount < totalCount &&
            (tilesSinceLastUpload >= TextureProvider.TILE_BATCH_THRESHOLD ||
              now - lastUpdateTime >= TextureProvider.UPLOAD_THROTTLE_MS)
          ) {
            lastUpdateTime = now;
            tilesSinceLastUpload = 0;
            texture.needsUpdate = true;
            onProgressUpdate?.(texture, completedCount, totalCount);
          }
        }
      };

      const concurrency = Math.min(12, totalCount);
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);

      if (signal?.aborted) return null;
      if (successCount === 0) return null;

      // Req #27: Enable mipmap generation and LinearMipmapLinearFilter only on final completion
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.needsUpdate = true;
      onProgressUpdate?.(texture, completedCount, totalCount);
      return texture;
    } catch (e) {
      console.warn('Failed to fetch hybrid texture:', e);
      return null;
    }
  }

  /**
   * Fetches authentic high-resolution topographic raster map tiles covering the tile grid bounds.
   */
  public static async fetchTopoTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void,
    signal?: AbortSignal,
    isXR: boolean = false
  ): Promise<THREE.CanvasTexture | null> {
    try {
      const TILE_SIZE = 256;
      const { width, height } = TextureBudget.getAssembledTextureSize(
        grid.numTilesX,
        grid.numTilesY,
        isXR,
        TILE_SIZE
      );

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const scaleX = canvas.width / (grid.numTilesX * TILE_SIZE);
      const scaleY = canvas.height / (grid.numTilesY * TILE_SIZE);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter; // Req #27: LinearFilter during intermediate progressive composition
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = this.maxAnisotropy;
      texture.generateMipmaps = false; // Req #27: Disable mipmap generation during intermediate compositing

      const provider = this.usgsTopoProvider;
      const tasks: { tx: number; ty: number }[] = [];
      for (let tx = grid.tileXMin; tx <= grid.tileXMax; tx++) {
        for (let ty = grid.tileYMin; ty <= grid.tileYMax; ty++) {
          tasks.push({ tx, ty });
        }
      }

      const totalCount = tasks.length;
      let completedCount = 0;
      let successCount = 0;
      let tilesSinceLastUpload = 0;
      let lastUpdateTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      const worker = async () => {
        while (tasks.length > 0) {
          if (signal?.aborted) break;
          const task = tasks.shift();
          if (!task) break;
          const { tx, ty } = task;

          const x0 = Math.round((tx - grid.tileXMin) * TILE_SIZE * scaleX);
          const x1 = Math.round((tx - grid.tileXMin + 1) * TILE_SIZE * scaleX);
          const y0 = Math.round((ty - grid.tileYMin) * TILE_SIZE * scaleY);
          const y1 = Math.round((ty - grid.tileYMin + 1) * TILE_SIZE * scaleY);

          try {
            const img = await TileImageCache.loadTile(provider, grid.zoom, tx, ty, 4000, signal);
            ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
            successCount++;
          } catch {
            // Ignore single tile error
          }

          completedCount++;
          tilesSinceLastUpload++;
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          // Req #26: Throttle whole-route composite canvas uploads (500-1000ms or every N tiles)
          if (
            completedCount < totalCount &&
            (tilesSinceLastUpload >= TextureProvider.TILE_BATCH_THRESHOLD ||
              now - lastUpdateTime >= TextureProvider.UPLOAD_THROTTLE_MS)
          ) {
            lastUpdateTime = now;
            tilesSinceLastUpload = 0;
            texture.needsUpdate = true;
            onProgressUpdate?.(texture, completedCount, totalCount);
          }
        }
      };

      const concurrency = Math.min(12, totalCount);
      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);

      if (signal?.aborted) return null;
      if (successCount === 0) return null;

      // Req #27: Enable mipmap generation and LinearMipmapLinearFilter only on final completion
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.needsUpdate = true;
      onProgressUpdate?.(texture, completedCount, totalCount);
      return texture;
    } catch (e) {
      console.warn('Failed to fetch high-res topographic map tiles:', e);
      return null;
    }
  }

  /**
   * Generates procedural Topographic texture aligned to the tile grid bounds.
   */
  public static generateTopoTexture(
    bounds: GeoBounds,
    grid: TileGridBounds,
    elevationSampler: (lat: number, lon: number) => number,
    width: number = 1024,
    height: number = 1024
  ): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    const minEle = bounds.minEle;
    const maxEle = bounds.maxEle;
    const eleSpan = Math.max(maxEle - minEle, 50);

    const n = 2 ** grid.zoom;

    for (let py = 0; py < height; py++) {
      const gy = grid.tileYMin + (py / height) * grid.numTilesY;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / n)));
      const lat = (latRad * 180) / Math.PI;

      for (let px = 0; px < width; px++) {
        const gx = grid.tileXMin + (px / width) * grid.numTilesX;
        const lon = (gx / n) * 360 - 180;

        const ele = elevationSampler(lat, lon);
        const normEle = Math.min(Math.max((ele - minEle) / eleSpan, 0), 1);

        let r = 0, g = 0, b = 0;
        if (normEle < 0.25) {
          const t = normEle / 0.25;
          r = 30 + t * 45;
          g = 68 + t * 40;
          b = 38 + t * 15;
        } else if (normEle < 0.5) {
          const t = (normEle - 0.25) / 0.25;
          r = 75 + t * 45;
          g = 108 + t * 15;
          b = 53 + t * 65;
        } else if (normEle < 0.75) {
          const t = (normEle - 0.5) / 0.25;
          r = 120 + t * 50;
          g = 123 + t * 50;
          b = 118 + t * 60;
        } else {
          const t = (normEle - 0.75) / 0.25;
          r = 170 + t * 80;
          g = 173 + t * 80;
          b = 178 + t * 77;
        }

        const contour100 = Math.abs((ele % 100) - 50);
        const contour500 = Math.abs((ele % 500) - 250);

        if (contour500 < 6) {
          r = Math.max(0, r - 35);
          g = Math.max(0, g - 35);
          b = Math.max(0, b - 35);
        } else if (contour100 < 3) {
          r = Math.max(0, r - 18);
          g = Math.max(0, g - 18);
          b = Math.max(0, b - 18);
        }

        const idx = (py * width + px) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = this.maxAnisotropy;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }
}
