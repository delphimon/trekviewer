import type { ImageryProvider } from './providers/ImageryProvider.ts';
import { recordImagerySource } from './ImagerySource.ts';
import { PersistentResourceCache, persistentResourceAllowed, readBoundedBlob } from './PersistentResourceCache.ts';
import { isSwissImageryURL, isCompleteSwissImage } from './providers/SwissImagery.ts';
import { type QualityProfile, QualityProfileManager } from './QualityProfile.ts';

export enum TilePriority {
  CRITICAL = 0, // Missing 4th tile of 3/4 group, visible 1:1 user center, tabletop gaze focus
  HIGH = 1,     // Route ahead, 2/4 group missing sibling, visible DEM
  NORMAL = 2,   // Speculative warm tiles, adjacent z18
  OVERVIEW = 3, // Whole-route background composite tiles
}

export type TileImageSource = HTMLImageElement | HTMLCanvasElement;

export interface ActiveRequestsByClass {
  critical: number;
  high: number;
  normal: number;
  overview: number;
}

export interface FailedTileEntry {
  timestamp: number;
  retryAfterMs: number;
  reason?: string;
}

export interface TileCacheStats {
  entries: number;
  maxEntries: number;
  decodedBytes: number;
  maxDecodedBytes: number;
  inFlight: number;
  failureCount: number;
  negativeCacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  highPriorityQueueLength: number;
  overviewQueueLength: number;
  activeRequestsByClass: ActiveRequestsByClass;
}

export class TileImageCache {
  public static readonly MAX_SHARED_RASTERS = 4;
  private static generation = 0;
  private static cache: Map<string, TileImageSource> = new Map();
  private static entryBytes: Map<string, number> = new Map();
  private static inFlight: Map<string, Promise<TileImageSource>> = new Map();
  private static rasterSources = new Map<string, HTMLImageElement>();
  private static rasterLoads = new Map<string, Promise<HTMLImageElement>>();
  private static rasterFailures = new Map<string, number>();
  private static rasterServiceFailures = new Map<string, number>();
  private static rasterSourceBytes = 0;
  private static negativeCache: Map<string, FailedTileEntry> = new Map();
  private static failureCount: number = 0;
  private static cacheHits: number = 0;
  private static cacheMisses: number = 0;

  private static activeByPriority: Record<TilePriority, number> = {
    [TilePriority.CRITICAL]: 0,
    [TilePriority.HIGH]: 0,
    [TilePriority.NORMAL]: 0,
    [TilePriority.OVERVIEW]: 0,
  };
  private static overviewWaitingCount: number = 0;
  private static highPriorityDrainResolvers: (() => void)[] = [];

  // Match the active High profile even before the first explicit device update.
  private static maxEntries: number = QualityProfileManager.getDefaultProfile(false).tileCacheEntries;
  private static maxDecodedBytes: number = QualityProfileManager.getDefaultProfile(false).tileCacheBytes;
  private static totalDecodedBytes: number = 0;

  /**
   * Configures cache limits based on target device and quality profile (Stage W).
   * Use the current device profile's explicit decoded image bounds.
   */
  public static setTargetDevice(isQuest: boolean): void {
    const profile = QualityProfileManager.getDefaultProfile(isQuest);
    this.applyProfile(profile);
  }

  public static applyProfile(profile: QualityProfile): void {
    this.setLimits(profile.tileCacheEntries, profile.tileCacheBytes);
  }

  public static setLimits(maxEntries: number, maxDecodedBytes: number): void {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxDecodedBytes = Math.max(1024, maxDecodedBytes);
    this.enforceLimits();
  }

  public static getMaxEntries(): number {
    return this.maxEntries;
  }

  public static getMaxDecodedBytes(): number {
    return this.maxDecodedBytes;
  }

  public static getEstimatedDecodedBytes(): number {
    return this.totalDecodedBytes + this.rasterSourceBytes;
  }

  public static getFailureCount(): number {
    return this.failureCount;
  }

  public static getStats(): TileCacheStats {
    const totalRequests = this.cacheHits + this.cacheMisses;
    const hitRate = totalRequests > 0 ? (this.cacheHits / totalRequests) * 100 : 0;
    return {
      entries: this.cache.size,
      maxEntries: this.maxEntries,
      decodedBytes: this.totalDecodedBytes + this.rasterSourceBytes,
      maxDecodedBytes: this.maxDecodedBytes,
      inFlight: this.inFlight.size,
      failureCount: this.failureCount,
      negativeCacheSize: this.negativeCache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: Math.round(hitRate * 10) / 10,
      highPriorityQueueLength:
        this.activeByPriority[TilePriority.CRITICAL] +
        this.activeByPriority[TilePriority.HIGH],
      overviewQueueLength:
        this.overviewWaitingCount + this.activeByPriority[TilePriority.OVERVIEW],
      activeRequestsByClass: {
        critical: this.activeByPriority[TilePriority.CRITICAL],
        high: this.activeByPriority[TilePriority.HIGH],
        normal: this.activeByPriority[TilePriority.NORMAL],
        overview: this.activeByPriority[TilePriority.OVERVIEW],
      },
    };
  }

  public static getNegativeCacheSize(): number {
    return this.negativeCache.size;
  }

  public static getRetryDelayMs(providerId: string, zoom: number, x: number, y: number): number {
    const entry = this.negativeCache.get(this.getTileKey(providerId, zoom, x, y));
    if (!entry) return 0;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return Math.max(0, entry.timestamp + entry.retryAfterMs - now);
  }

  public static isNegativelyCached(providerIdOrKey: string, zoom?: number, x?: number, y?: number): boolean {
    const key =
      zoom !== undefined && x !== undefined && y !== undefined
        ? this.getTileKey(providerIdOrKey, zoom, x, y)
        : providerIdOrKey;
    const entry = this.negativeCache.get(key);
    if (!entry) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - entry.timestamp < entry.retryAfterMs) {
      return true;
    }
    this.negativeCache.delete(key);
    return false;
  }

  private static calculateImageBytes(img: TileImageSource): number {
    const width = ('naturalWidth' in img ? img.naturalWidth : 0) || img.width || 256;
    const height = ('naturalHeight' in img ? img.naturalHeight : 0) || img.height || 256;
    // 4 bytes per RGBA pixel
    return width * height * 4;
  }

  public static getTileKey(providerId: string, zoom: number, x: number, y: number): string {
    return `${providerId}:${zoom}:${x}:${y}`;
  }

  public static get(key: string): TileImageSource | undefined {
    const item = this.cache.get(key);
    if (item) {
      // Refresh LRU order: remove and re-insert
      this.cache.delete(key);
      this.cache.set(key, item);
      this.cacheHits++;
      return item;
    }
    this.cacheMisses++;
    return undefined;
  }

  public static set(key: string, img: TileImageSource): void {
    const incomingBytes = this.calculateImageBytes(img);
    // Oversized images can still be used by the caller without displacing the cache.
    if (incomingBytes > this.maxDecodedBytes) return;

    // If already in cache, deduct previous size first
    if (this.cache.has(key)) {
      const oldBytes = this.entryBytes.get(key) ?? 0;
      this.totalDecodedBytes -= oldBytes;
      this.cache.delete(key);
      this.entryBytes.delete(key);
    }

    while (this.rasterSources.size && this.totalDecodedBytes + this.rasterSourceBytes + incomingBytes > this.maxDecodedBytes) this.evictRasterSource();
    // Evict oldest entries until within both entry count and byte capacity
    while (
      this.cache.size > 0 &&
      (this.cache.size >= this.maxEntries ||
        this.totalDecodedBytes + this.rasterSourceBytes + incomingBytes > this.maxDecodedBytes)
    ) {
      this.evictOldest();
    }

    this.cache.set(key, img);
    this.entryBytes.set(key, incomingBytes);
    this.totalDecodedBytes += incomingBytes;
  }

  private static evictOldest(): void {
    const oldestKey = this.cache.keys().next().value;
    if (!oldestKey) return;
    // Textures and compositors may still borrow this decoded image. Release the
    // cache reference, never mutate its source; GC frees it after its last owner.
    const bytes = this.entryBytes.get(oldestKey) ?? 0;
    this.totalDecodedBytes = Math.max(0, this.totalDecodedBytes - bytes);
    this.cache.delete(oldestKey);
    this.entryBytes.delete(oldestKey);
  }

  private static enforceLimits(): void {
    while (this.rasterSources.size && this.totalDecodedBytes + this.rasterSourceBytes > this.maxDecodedBytes) this.evictRasterSource();
    while (
      this.cache.size > 0 &&
      (this.cache.size > this.maxEntries || this.totalDecodedBytes > this.maxDecodedBytes)
    ) {
      this.evictOldest();
    }
  }

  public static has(key: string): boolean {
    return this.cache.has(key);
  }

  public static clear(): void {
    this.generation++;
    this.cache.clear();
    this.entryBytes.clear();
    this.inFlight.clear();
    this.rasterSources.clear(); this.rasterLoads.clear(); this.rasterFailures.clear(); this.rasterServiceFailures.clear(); this.rasterSourceBytes = 0;
    this.negativeCache.clear();
    this.totalDecodedBytes = 0;
    this.failureCount = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.activeByPriority = {
      [TilePriority.CRITICAL]: 0,
      [TilePriority.HIGH]: 0,
      [TilePriority.NORMAL]: 0,
      [TilePriority.OVERVIEW]: 0,
    };
    this.overviewWaitingCount = 0;
    while (this.highPriorityDrainResolvers.length > 0) {
      const res = this.highPriorityDrainResolvers.shift();
      res?.();
    }
  }

  public static hasActiveHighPriorityRequests(): boolean {
    return (
      this.activeByPriority[TilePriority.CRITICAL] > 0 ||
      this.activeByPriority[TilePriority.HIGH] > 0
    );
  }

  private static waitForHighPriorityDrain(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timer: any = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const idx = this.highPriorityDrainResolvers.indexOf(done);
        if (idx !== -1) this.highPriorityDrainResolvers.splice(idx, 1);
        resolve();
      };
      const onAbort = () => done();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.highPriorityDrainResolvers.push(done);
      timer = setTimeout(done, 250);
    });
  }

  private static notifyHighPriorityDrained(): void {
    if (
      this.activeByPriority[TilePriority.CRITICAL] === 0 &&
      this.activeByPriority[TilePriority.HIGH] === 0
    ) {
      while (this.highPriorityDrainResolvers.length > 0) {
        const resolve = this.highPriorityDrainResolvers.shift();
        resolve?.();
      }
    }
  }

  public static size(): number {
    return this.cache.size;
  }

  public static getInFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Loads a tile from cache or network, with in-flight deduplication and fallback URLs.
   */
  public static async loadTile(
    provider: ImageryProvider,
    zoom: number,
    x: number,
    y: number,
    timeoutMs: number = 4500,
    signal?: AbortSignal,
    priority: TilePriority = TilePriority.NORMAL
  ): Promise<TileImageSource> {
    const generation = this.generation;
    const key = this.getTileKey(provider.id, zoom, x, y);
    const cached = this.get(key);
    if (cached) {
      return cached;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const negEntry = this.negativeCache.get(key);
    if (negEntry) {
      if (now - negEntry.timestamp < negEntry.retryAfterMs) {
        throw new Error(`Tile ${key} in negative cache: ${negEntry.reason ?? 'load failed'}`);
      }
      this.negativeCache.delete(key);
    }

    if (signal?.aborted) {
      throw new Error('Tile load aborted');
    }

    // Coordinated network prioritization (Stage X7 / Section 11):
    // Low-priority overview requests yield while high-priority visible LOD requests are in-flight.
    if (priority === TilePriority.OVERVIEW) {
      while (generation === this.generation && this.hasActiveHighPriorityRequests() && !signal?.aborted) {
        this.overviewWaitingCount++;
        try {
          await this.waitForHighPriorityDrain(signal);
        } finally {
          if (generation === this.generation) this.overviewWaitingCount = Math.max(0, this.overviewWaitingCount - 1);
        }
      }
      if (signal?.aborted) {
        throw new Error('Tile load aborted');
      }
    }

    if (generation !== this.generation) throw new Error('Tile cache cleared');

    // In-flight request deduplication (Requirement #77 & Section 15)
    let loadPromise = this.inFlight.get(key);
    if (!loadPromise) {
      loadPromise = (async () => {
        this.activeByPriority[priority]++;
        try {
          const region = provider.getTileImageRegion?.(zoom, x, y);
          const urls = [...provider.getTileUrls(zoom, x, y)];
          const configuredFirstURL = urls[0];
          if (region) {
            // A source outage affects many exports, not just one tile URL. Try
            // healthy configured mirrors first instead of repeating the same
            // timeout for every new group. Cached preferred rasters still win.
            const now = Date.now();
            const coolingDown = (url: string) => !this.rasterSources.has(`${provider.id}:${url}`)
              && (this.rasterServiceFailures.get(this.rasterServiceKey(provider.id, url)) ?? 0) > now;
            urls.sort((a, b) => Number(coolingDown(a)) - Number(coolingDown(b)));
          }
          let lastError: any = null;

          for (const url of urls) {
            try {
              // Shared network request executes with internal timeout to populate cache
              let img: TileImageSource = region
                ? await this.loadRasterSource(`${provider.id}:${url}`, url, provider.requestTimeoutMs ?? timeoutMs, generation, provider.id)
                : await this.loadImageWithTimeout(url, provider.requestTimeoutMs ?? timeoutMs);
              if (region) {
                if (region.x + region.width > img.width || region.y + region.height > img.height) throw new Error('Incomplete source raster dimensions');
                const canvas = document.createElement('canvas'); canvas.width = region.width; canvas.height = region.height;
                const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Cannot crop imagery raster');
                ctx.drawImage(img, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
                if (canvas.dataset) canvas.dataset.sourceUrl = url;
                img = canvas;
              }
              if (provider.isTileUsable && !provider.isTileUsable(img, url)) throw new Error('Imagery has incomplete source coverage');
              recordImagerySource(img, url, configuredFirstURL);
              if (generation === this.generation) this.set(key, img);
              return img;
            } catch (err) {
              lastError = err;
            }
          }

          if (generation !== this.generation) throw lastError;
          this.failureCount++;
          const errMsg = lastError?.message ?? `Failed to load tile ${zoom}/${x}/${y} from ${provider.displayName}`;
          const retryAfterMs = errMsg.includes('timeout') ? 15000 : 60000;
          this.negativeCache.set(key, {
            timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            retryAfterMs,
            reason: errMsg,
          });
          throw lastError || new Error(errMsg);
        } finally {
          if (generation === this.generation) {
            this.activeByPriority[priority] = Math.max(0, this.activeByPriority[priority] - 1);
            if (priority === TilePriority.CRITICAL || priority === TilePriority.HIGH) this.notifyHighPriorityDrained();
          }
        }
      })();

      this.inFlight.set(key, loadPromise);
      loadPromise
        .finally(() => {
          if (this.inFlight.get(key) === loadPromise) this.inFlight.delete(key);
        })
        .catch(() => {});
    }

    // Individual consumer await with signal listener
    if (!signal) {
      return loadPromise;
    }

    return new Promise<TileImageSource>((resolve, reject) => {
      if (signal.aborted) {
        return reject(new Error('Tile load aborted'));
      }

      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Tile load aborted'));
      };
      signal.addEventListener('abort', onAbort);

      loadPromise!
        .then((img) => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) {
            reject(new Error('Tile load aborted'));
          } else {
            resolve(img);
          }
        })
        .catch((err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        });
    });
  }

  private static evictRasterSource(): void {
    const key = this.rasterSources.keys().next().value;
    if (!key) return;
    this.rasterSourceBytes -= this.calculateImageBytes(this.rasterSources.get(key)!);
    this.rasterSources.delete(key);
  }

  private static rasterServiceKey(providerId: string, url: string): string {
    // Scope failures to an export service, keeping DEM, labels, overview and
    // other services on the same host independent. Query bounds vary per tile.
    return `${providerId}:${url.split('?')[0]}`;
  }

  /** Sixteen fine tiles share one 1024px export; source rasters count toward the
   * same decoded-byte limit and retain at most four entries (16 MiB). */
  private static loadRasterSource(key: string, url: string, timeout: number, generation: number, providerId: string): Promise<HTMLImageElement> {
    const cached = this.rasterSources.get(key);
    if (cached) { this.rasterSources.delete(key); this.rasterSources.set(key, cached); return Promise.resolve(cached); }
    const pending = this.rasterLoads.get(key); if (pending) return pending;
    if ((this.rasterFailures.get(key) ?? 0) > Date.now()) return Promise.reject(new Error('Source raster temporarily unavailable'));
    const serviceKey = this.rasterServiceKey(providerId, url);
    const request = this.loadImageWithTimeout(url, timeout).then(image => {
      const bytes = this.calculateImageBytes(image);
      if (generation === this.generation) this.rasterServiceFailures.delete(serviceKey);
      if (generation === this.generation && bytes <= this.maxDecodedBytes) {
        while (this.rasterSources.size && (this.rasterSources.size >= this.MAX_SHARED_RASTERS || this.totalDecodedBytes + this.rasterSourceBytes + bytes > this.maxDecodedBytes)) this.evictRasterSource();
        if (this.totalDecodedBytes + this.rasterSourceBytes + bytes <= this.maxDecodedBytes) {
          this.rasterSources.set(key, image); this.rasterSourceBytes += bytes;
        }
      }
      return image;
    }).catch(error => {
      if (generation === this.generation) {
        this.rasterServiceFailures.delete(serviceKey);
        this.rasterServiceFailures.set(serviceKey, Date.now() + 5 * 60_000);
        while (this.rasterServiceFailures.size > 128) this.rasterServiceFailures.delete(this.rasterServiceFailures.keys().next().value!);
        this.rasterFailures.delete(key); this.rasterFailures.set(key, Date.now() + 60_000);
        while (this.rasterFailures.size > 128) this.rasterFailures.delete(this.rasterFailures.keys().next().value!);
      }
      throw error;
    });
    this.rasterLoads.set(key, request);
    void request.finally(() => { if (this.rasterLoads.get(key) === request) this.rasterLoads.delete(key); }).catch(() => {});
    return request;
  }

  private static loadImageWithTimeout(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<HTMLImageElement> {
    if (typeof Image === 'undefined') {
      return Promise.reject(new Error('Image is not defined in this environment'));
    }

    if (PersistentResourceCache.isAvailable() && PersistentResourceCache.isEnabled() && persistentResourceAllowed(url)) {
      return this.loadPersistedImage(url, timeoutMs, signal);
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted')); return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';

      let timer: any = setTimeout(() => {
        timer = null;
        cleanup();
        img.src = '';
        reject(new Error(`Timeout loading tile: ${url}`));
      }, timeoutMs);

      const abortHandler = () => {
        cleanup();
        img.src = '';
        reject(new Error('Aborted'));
      };

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener('abort', abortHandler);
        img.onload = null;
        img.onerror = null;
      };

      signal?.addEventListener('abort', abortHandler);

      img.onload = () => {
        cleanup();
        resolve(img);
      };

      img.onerror = (e) => {
        cleanup();
        reject(e);
      };

      img.src = url;
    });
  }

  private static async loadPersistedImage(url: string, timeoutMs: number, signal?: AbortSignal): Promise<HTMLImageElement> {
    const generation = PersistentResourceCache.getGeneration();
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const started = performance.now();
    const timer = setTimeout(abort, timeoutMs);
    const decode = async (blob: Blob) => {
      const objectURL = URL.createObjectURL(blob);
      try {
        const image = await this.loadImageWithTimeout(objectURL, Math.max(1, timeoutMs - (performance.now() - started)), controller.signal);
        if (isSwissImageryURL(url) && !isCompleteSwissImage(image)) throw new Error('Incomplete Swiss imagery coverage');
        return image;
      }
      finally { URL.revokeObjectURL(objectURL); }
    };
    try {
      const cached = await PersistentResourceCache.read(url);
      if (controller.signal.aborted) throw new Error('Image load aborted');
      if (cached) {
        try { return await decode(cached); }
        catch (error) { void PersistentResourceCache.remove(url); if (controller.signal.aborted) throw error; }
      }
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
      const blob = await readBoundedBlob(response, 8 * 1024 * 1024);
      const image = await decode(blob);
      PersistentResourceCache.write(url, blob, generation);
      return image;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
