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
import { composeImagery, MAX_COMPOSITE_TILES } from './CompositeImagery.ts';
import { PublicImageryProvider, USGSReferenceProvider } from './providers/PublicImageryProvider.ts';

export interface TileGridBounds {
  zoom: number;
  tileXMin: number;
  tileXMax: number;
  tileYMin: number;
  tileYMax: number;
  numTilesX: number;
  numTilesY: number;
}

export interface ProviderInitState {
  requestedProvider: 'auto' | 'esri' | 'cesium-bing';
  activeProvider: string; // e.g. 'cesium-bing' or 'esri-satellite'
  initialized: boolean;
  fallbackReason?: string;
  displayName: string;
  maxZoom: number;
  attribution: string;
}

export class TextureProvider {
  private static esriSatelliteProvider = new EsriWorldImageryProvider();
  private static publicSatelliteProvider = new PublicImageryProvider();
  private static publicReferenceProvider = new USGSReferenceProvider();
  private static usgsTopoProvider = new USGSTopoProvider();
  private static referenceOverlayProvider = new EsriReferenceOverlayProvider();
  private static cesiumProvider: CesiumBingImageryProvider | null = null;
  private static activeSatelliteProvider: ImageryProvider = TextureProvider.publicSatelliteProvider;
  private static maxAnisotropy: number = 4; // Bounded default for non-WebGL/test environments

  private static initialized: boolean = false;
  private static fallbackReason: string | undefined = undefined;
  private static initPromise: Promise<boolean> | null = null;

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

  private static satelliteProviderSetting: 'auto' | 'esri' | 'cesium-bing' = 'auto';

  public static getSatelliteProviderSetting(): 'auto' | 'esri' | 'cesium-bing' {
    return this.satelliteProviderSetting;
  }

  /** Private launch configuration, supplied in browser memory before startup.
   * Unlike build-time VITE variables, this need not put an account token into
   * a hosted asset. A token alone never opts the public default into Bing. */
  private static getRuntimeProviderConfig(): { provider: 'cesium-bing'; ionToken?: string } | undefined {
    const config = (globalThis as typeof globalThis & {
      __TREK_VIEWER_PROVIDERS__?: { provider?: unknown; ionToken?: unknown };
    }).__TREK_VIEWER_PROVIDERS__;
    if (config?.provider !== 'cesium-bing') return undefined;
    const token = typeof config.ionToken === 'string' ? config.ionToken.trim() : '';
    return { provider: 'cesium-bing', ionToken: token.length > 10 && token.length <= 8192 ? token : undefined };
  }

  public static getEnvToken(): string | undefined {
    const runtime = this.getRuntimeProviderConfig();
    if (runtime) return runtime.ionToken;
    const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    const procEnv = typeof globalThis !== 'undefined' ? (globalThis as any).process?.env : undefined;
    return (
      (metaEnv?.VITE_CESIUM_ION_TOKEN as string | undefined) ||
      (procEnv?.VITE_CESIUM_ION_TOKEN as string | undefined) ||
      (procEnv?.CESIUM_ION_TOKEN as string | undefined)
    );
  }

  public static getEnvProviderSetting(): 'auto' | 'esri' | 'cesium-bing' {
    if (this.getRuntimeProviderConfig()) return 'cesium-bing';
    const metaEnv = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    const procEnv = typeof globalThis !== 'undefined' ? (globalThis as any).process?.env : undefined;
    const raw = (
      (metaEnv?.VITE_SATELLITE_PROVIDER as string | undefined) ||
      (procEnv?.VITE_SATELLITE_PROVIDER as string | undefined) ||
      (procEnv?.SATELLITE_PROVIDER as string | undefined) ||
      'auto'
    ).toLowerCase().trim();

    if (raw === 'esri') return 'esri';
    if (raw === 'cesium-bing' || raw === 'cesium' || raw === 'bing') return 'cesium-bing';
    return 'auto';
  }

  /**
   * Explicitly initializes the satellite imagery provider from environment settings (Section 48).
   * Awaited before any route loading to eliminate the unawaited asynchronous race.
   */
  public static async initializeFromEnvironment(): Promise<boolean> {
    if (this.initPromise) {
      return this.initPromise;
    }
    const providerSetting = this.getEnvProviderSetting();
    const token = this.getEnvToken();
    this.initPromise = this.setSatelliteProvider(providerSetting, token);
    return this.initPromise;
  }

  /**
   * Ensures provider initialization has completed before route tiles are requested.
   */
  public static async waitForInitialization(): Promise<void> {
    await this.initializeFromEnvironment();
  }

  /**
   * Returns the current provider initialization and fallback state (Section 49).
   */
  public static getProviderInitState(): ProviderInitState {
    return {
      requestedProvider: this.satelliteProviderSetting,
      activeProvider: this.activeSatelliteProvider.id,
      initialized: this.initialized,
      fallbackReason: this.fallbackReason,
      displayName: this.activeSatelliteProvider.displayName,
      maxZoom: this.activeSatelliteProvider.maxZoom,
      attribution: this.activeSatelliteProvider.attribution,
    };
  }

  /**
   * Resets provider configuration and state (useful for deterministic unit tests).
   */
  public static resetForTesting(): void {
    this.satelliteProviderSetting = 'auto';
    this.activeSatelliteProvider = this.publicSatelliteProvider;
    this.cesiumProvider = null;
    this.initialized = false;
    this.fallbackReason = undefined;
    this.initPromise = null;
  }

  /**
   * Sets or switches the active satellite imagery provider at runtime (Sections 32, 33).
   * Auto selects public sources; Esri and Cesium/Bing require explicit opt-in.
   * Falls back to public sources if Cesium fails or its token is missing.
   */
  public static async setSatelliteProvider(
    providerType: 'auto' | 'esri' | 'cesium-bing',
    token?: string
  ): Promise<boolean> {
    this.satelliteProviderSetting = providerType;

    if (providerType === 'esri') {
      this.activeSatelliteProvider = this.esriSatelliteProvider;
      this.fallbackReason = undefined;
      this.initialized = true;
      return true;
    }

    // Auto is a no-paid-license policy. Merely having a token must not opt in to
    // a provider whose account, quotas and imagery rights have separate terms.
    if (providerType === 'auto') {
      this.activeSatelliteProvider = this.publicSatelliteProvider;
      this.fallbackReason = undefined; this.initialized = true;
      return true;
    }

    const resolvedToken = token !== undefined ? token : this.getEnvToken();
    if (!resolvedToken || resolvedToken.trim().length <= 10) {
      console.warn('[TextureProvider] Cesium Bing provider requested but no valid Cesium Ion token found. Falling back to public USGS imagery.');
      this.fallbackReason = 'Missing or invalid Cesium ion token';
      this.activeSatelliteProvider = this.publicSatelliteProvider;
      this.initialized = true;
      return false;
    }

    try {
      this.cesiumProvider = new CesiumBingImageryProvider(resolvedToken.trim());
      const success = await this.cesiumProvider.init();
      if (success) {
        this.activeSatelliteProvider = this.cesiumProvider;
        this.fallbackReason = undefined;
        this.initialized = true;
        return true;
      } else {
        console.warn('[TextureProvider] Cesium Bing provider metadata initialization failed. Falling back to public USGS imagery.');
        this.fallbackReason = this.cesiumProvider.failureReason ?? 'Cesium unavailable';
        this.activeSatelliteProvider = this.publicSatelliteProvider;
        this.initialized = true;
        return false;
      }
    } catch (err) {
      console.warn('[TextureProvider] Error initializing Cesium provider:', err);
      this.fallbackReason = 'Cesium unavailable';
      this.activeSatelliteProvider = this.publicSatelliteProvider;
      this.initialized = true;
      return false;
    }
  }

  public static getActiveSatelliteProvider(): ImageryProvider {
    return this.activeSatelliteProvider;
  }

  public static getReferenceOverlayProvider(): ImageryProvider {
    if (this.activeSatelliteProvider.id === 'public-naip') return this.publicReferenceProvider;
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

  public static getAttributionForStyle(style: string, bounds?: GeoBounds): string {
    if ((style === 'satellite' || style === 'hybrid') && this.activeSatelliteProvider.id === 'public-naip') {
      // Include a generous guard for the overview tiles surrounding the terrain.
      const allCONUS = bounds && bounds.minLat > 25 && bounds.maxLat < 49 && bounds.minLon > -124 && bounds.maxLon < -67;
      const credits = allCONUS ? 'USGS / USDA NAIP + HRO (public domain); USGS overview' : this.activeSatelliteProvider.attribution;
      return credits + (this.fallbackReason ? ` (${this.fallbackReason})` : '')
        + (style === 'hybrid' ? ` | ${this.publicReferenceProvider.attribution}` : '');
    }
    const fallbackSuffix = this.fallbackReason ? ` (fallback: ${this.fallbackReason})` : '';
    switch (style) {
      case 'satellite':
        if (this.activeSatelliteProvider.id === 'cesium-bing') {
          return `Bing Aerial via Cesium • up to Z${this.activeSatelliteProvider.maxZoom}`;
        } else {
          return `Esri World Imagery • up to Z${this.activeSatelliteProvider.maxZoom}${fallbackSuffix}`;
        }
      case 'hybrid':
        if (this.activeSatelliteProvider.id === 'cesium-bing') {
          return `Bing Aerial via Cesium • up to Z${this.activeSatelliteProvider.maxZoom} | ${this.referenceOverlayProvider.attribution}`;
        } else {
          return `Esri World Imagery • up to Z${this.activeSatelliteProvider.maxZoom}${fallbackSuffix} | ${this.referenceOverlayProvider.attribution}`;
        }
      case 'topo':
        return `${this.usgsTopoProvider.displayName} • up to Z${this.usgsTopoProvider.maxZoom}`;
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
    zoom = Math.min(zoom, this.activeSatelliteProvider.getMaxOverviewZoomForLocation?.(bounds.centerLat, bounds.centerLon)
      ?? this.activeSatelliteProvider.getMaxZoomForLocation?.(bounds.centerLat, bounds.centerLon) ?? this.activeSatelliteProvider.maxZoom);

    const minTile = latLonToTile(maxLat, minLon, zoom);
    const maxTile = latLonToTile(minLat, maxLon, zoom);

    let tileXMin = Math.min(minTile.x, maxTile.x);
    let tileXMax = Math.max(minTile.x, maxTile.x);
    let tileYMin = Math.min(minTile.y, maxTile.y);
    let tileYMax = Math.max(minTile.y, maxTile.y);

    let numTilesX = tileXMax - tileXMin + 1;
    let numTilesY = tileYMax - tileYMin + 1;

    // Mercator tiles cover less ground near the poles. Keep coarsening the
    // overview until it actually fits; local inspection tiles retain their own zoom.
    while (numTilesX * numTilesY > MAX_COMPOSITE_TILES && zoom > 0) {
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

  /** Streams a route composite with bounded uploads and complete fallback coverage. */
  public static fetchSatelliteTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void,
    signal?: AbortSignal,
    isXR: boolean = false,
    fallbackImage?: CanvasImageSource | null
  ): Promise<THREE.CanvasTexture | null> {
    return this.fetchComposite(grid, this.activeSatelliteProvider, 4500, onProgressUpdate, signal, isXR, fallbackImage);
  }

  /** Reuses decoded satellite tiles, adding transparent reference labels. */
  public static fetchHybridTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void,
    signal?: AbortSignal,
    isXR: boolean = false,
    fallbackImage?: CanvasImageSource | null
  ): Promise<THREE.CanvasTexture | null> {
    return this.fetchComposite(grid, this.activeSatelliteProvider, 4500, onProgressUpdate, signal, isXR, fallbackImage, this.getReferenceOverlayProvider());
  }

  public static fetchTopoTexture(
    grid: TileGridBounds,
    onProgressUpdate?: (texture: THREE.CanvasTexture, loadedCount: number, totalCount: number) => void,
    signal?: AbortSignal,
    isXR: boolean = false,
    fallbackImage?: CanvasImageSource | null
  ): Promise<THREE.CanvasTexture | null> {
    return this.fetchComposite(grid, this.usgsTopoProvider, 4000, onProgressUpdate, signal, isXR, fallbackImage);
  }

  private static async fetchComposite(
    grid: TileGridBounds, provider: ImageryProvider, timeoutMs: number,
    onProgress: ((texture: THREE.CanvasTexture, completed: number, total: number) => void) | undefined,
    signal: AbortSignal | undefined, isXR: boolean, fallbackImage?: CanvasImageSource | null, overlay?: ImageryProvider
  ): Promise<THREE.CanvasTexture | null> {
    try {
      return await composeImagery({ grid, provider, timeoutMs, overlay, signal, isXR, fallbackImage,
        anisotropy: this.maxAnisotropy, uploadIntervalMs: this.UPLOAD_THROTTLE_MS,
        uploadBatchSize: this.TILE_BATCH_THRESHOLD, onProgress });
    } catch (error) {
      if (!signal?.aborted) console.warn('Failed to compose route imagery:', error);
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
    const build = this.buildTopoTexture(bounds, grid, elevationSampler, width, height);
    let step = build.next();
    while (!step.done) step = build.next();
    return step.value;
  }

  public static async generateTopoTextureAsync(
    bounds: GeoBounds, grid: TileGridBounds,
    elevationSampler: (lat: number, lon: number) => number,
    width: number = 1024, height: number = 1024, signal?: AbortSignal
  ): Promise<THREE.CanvasTexture> {
    const build = this.buildTopoTexture(bounds, grid, elevationSampler, width, height);
    while (true) {
      if (signal?.aborted) throw new DOMException('Texture generation cancelled', 'AbortError');
      const step = build.next();
      if (step.done) return step.value;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  private static *buildTopoTexture(
    bounds: GeoBounds,
    grid: TileGridBounds,
    elevationSampler: (lat: number, lon: number) => number,
    width: number = 1024,
    height: number = 1024
  ): Generator<void, THREE.CanvasTexture, void> {
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
      if (py % 8 === 7) yield;
    }

    ctx.putImageData(imgData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
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
