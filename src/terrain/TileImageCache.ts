import type { ImageryProvider } from './providers/ImageryProvider.ts';

export interface TileCacheStats {
  entries: number;
  maxEntries: number;
  decodedBytes: number;
  maxDecodedBytes: number;
  inFlight: number;
}

export class TileImageCache {
  private static cache: Map<string, HTMLImageElement> = new Map();
  private static entryBytes: Map<string, number> = new Map();
  private static inFlight: Map<string, Promise<HTMLImageElement>> = new Map();

  // Desktop defaults (80MB / 300 tiles)
  private static maxEntries: number = 300;
  private static maxDecodedBytes: number = 80 * 1024 * 1024; // 83,886,080 bytes
  private static totalDecodedBytes: number = 0;

  /**
   * Configures cache limits based on target device (Requirement #105).
   * Quest profile: 120 entries, 32MB max
   * Desktop profile: 300 entries, 80MB max
   */
  public static setTargetDevice(isQuest: boolean): void {
    if (isQuest) {
      this.setLimits(120, 32 * 1024 * 1024);
    } else {
      this.setLimits(300, 80 * 1024 * 1024);
    }
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

  public static getStats(): TileCacheStats {
    return {
      entries: this.cache.size,
      maxEntries: this.maxEntries,
      decodedBytes: this.totalDecodedBytes,
      maxDecodedBytes: this.maxDecodedBytes,
      inFlight: this.inFlight.size,
    };
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
    }
    return item;
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
    this.totalDecodedBytes = 0;
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
    signal?: AbortSignal
  ): Promise<HTMLImageElement> {
    const key = this.getTileKey(provider.id, zoom, x, y);
    const cached = this.get(key);
    if (cached) {
      return cached;
    }

    if (signal?.aborted) {
      throw new Error('Tile load aborted');
    }

    // In-flight request deduplication (Requirement #77 & Section 15)
    let loadPromise = this.inFlight.get(key);
    if (!loadPromise) {
      loadPromise = (async () => {
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

        throw lastError || new Error(`Failed to load tile ${zoom}/${x}/${y} from ${provider.displayName}`);
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
