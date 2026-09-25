import type { ImageryProvider } from './providers/ImageryProvider.ts';
import { type QualityProfile, QualityProfileManager } from './QualityProfile.ts';

export enum TilePriority {
  CRITICAL = 0, // Missing 4th tile of 3/4 group, visible 1:1 user center, tabletop gaze focus
  HIGH = 1,     // Route ahead, 2/4 group missing sibling, visible DEM
  NORMAL = 2,   // Speculative warm tiles, adjacent z18
  OVERVIEW = 3, // Whole-route background composite tiles
}

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
  private static cache: Map<string, HTMLImageElement> = new Map();
  private static entryBytes: Map<string, number> = new Map();
  private static inFlight: Map<string, Promise<HTMLImageElement>> = new Map();
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

  // Desktop defaults (96MB / 360 tiles in desktop-high)
  private static maxEntries: number = 360;
  private static maxDecodedBytes: number = 96 * 1024 * 1024;
  private static totalDecodedBytes: number = 0;

  /**
   * Configures cache limits based on target device and quality profile (Stage W).
   * Quest profile defaults to 'quest-high': 240 entries, 64MB max (scalable to 320 / 80MB)
   * Desktop profile defaults to 'desktop-high': 360 entries, 96MB max
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
    return this.totalDecodedBytes;
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
      decodedBytes: this.totalDecodedBytes,
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

  private static calculateImageBytes(img: HTMLImageElement): number {
    const width = img.naturalWidth || img.width || 256;
    const height = img.naturalHeight || img.height || 256;
    // 4 bytes per RGBA pixel
    return width * height * 4;
  }

  public static getTileKey(providerId: string, zoom: number, x: number, y: number): string {
    return `${providerId}:${zoom}:${x}:${y}`;
  }

  public static get(key: string): HTMLImageElement | undefined {
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

  public static set(key: string, img: HTMLImageElement): void {
    const incomingBytes = this.calculateImageBytes(img);

    // If already in cache, deduct previous size first
    if (this.cache.has(key)) {
      const oldBytes = this.entryBytes.get(key) ?? 0;
      this.totalDecodedBytes -= oldBytes;
      this.cache.delete(key);
      this.entryBytes.delete(key);
    }

    // Evict oldest entries until within both entry count and byte capacity
    while (
      this.cache.size > 0 &&
      (this.cache.size >= this.maxEntries ||
        this.totalDecodedBytes + incomingBytes > this.maxDecodedBytes)
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
    const oldImg = this.cache.get(oldestKey);
    if (oldImg) {
      oldImg.src = '';
    }
    const bytes = this.entryBytes.get(oldestKey) ?? 0;
    this.totalDecodedBytes = Math.max(0, this.totalDecodedBytes - bytes);
    this.cache.delete(oldestKey);
    this.entryBytes.delete(oldestKey);
  }

  private static enforceLimits(): void {
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
    for (const img of this.cache.values()) {
      img.src = '';
    }
    this.cache.clear();
    this.entryBytes.clear();
    this.inFlight.clear();
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
  ): Promise<HTMLImageElement> {
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
      while (this.hasActiveHighPriorityRequests() && !signal?.aborted) {
        this.overviewWaitingCount++;
        try {
          await this.waitForHighPriorityDrain(signal);
        } finally {
          this.overviewWaitingCount = Math.max(0, this.overviewWaitingCount - 1);
        }
      }
      if (signal?.aborted) {
        throw new Error('Tile load aborted');
      }
    }

    // In-flight request deduplication (Requirement #77 & Section 15)
    let loadPromise = this.inFlight.get(key);
    if (!loadPromise) {
      loadPromise = (async () => {
        this.activeByPriority[priority]++;
        try {
          const urls = provider.getTileUrls(zoom, x, y);
          let lastError: any = null;

          for (const url of urls) {
            try {
              // Shared network request executes with internal timeout to populate cache
              const img = await this.loadImageWithTimeout(url, timeoutMs);
              this.set(key, img);
              return img;
            } catch (err) {
              lastError = err;
            }
          }

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
          this.activeByPriority[priority] = Math.max(0, this.activeByPriority[priority] - 1);
          if (priority === TilePriority.CRITICAL || priority === TilePriority.HIGH) {
            this.notifyHighPriorityDrained();
          }
        }
      })();

      this.inFlight.set(key, loadPromise);
      loadPromise
        .finally(() => {
          this.inFlight.delete(key);
        })
        .catch(() => {});
    }

    // Individual consumer await with signal listener
    if (!signal) {
      return loadPromise;
    }

    return new Promise<HTMLImageElement>((resolve, reject) => {
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

  private static loadImageWithTimeout(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<HTMLImageElement> {
    if (typeof Image === 'undefined') {
      return Promise.reject(new Error('Image is not defined in this environment'));
    }

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
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
}
