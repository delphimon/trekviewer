import type { ImageryProvider } from './providers/ImageryProvider.ts';
import { TextureBudget } from './TextureBudget.ts';

export class TileImageCache {
  private static cache: Map<string, HTMLImageElement> = new Map();
  private static maxEntries: number = 400;
  private static currentMemoryBytes: number = 0;
  // Default: 96MB on Quest (384 standard 256x256 RGBA tiles), 192MB on desktop (768 tiles)
  private static maxMemoryBytes: number = (typeof navigator !== 'undefined' && TextureBudget.isQuestHeadset())
    ? 96 * 1024 * 1024
    : 192 * 1024 * 1024;

  public static getTileKey(providerId: string, zoom: number, x: number, y: number): string {
    return `${providerId}:${zoom}:${x}:${y}`;
  }

  private static estimateImageBytes(img: HTMLImageElement): number {
    const w = img.naturalWidth || img.width || 256;
    const h = img.naturalHeight || img.height || 256;
    return w * h * 4;
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
    const existing = this.cache.get(key);
    if (existing) {
      this.currentMemoryBytes -= this.estimateImageBytes(existing);
      this.cache.delete(key);
    }

    const itemBytes = this.estimateImageBytes(img);

    // Evict oldest entries while over capacity (by entry count or byte budget)
    while (
      (this.cache.size >= this.maxEntries || (this.currentMemoryBytes + itemBytes > this.maxMemoryBytes)) &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldImg = this.cache.get(oldestKey);
      if (oldImg) {
        this.currentMemoryBytes -= this.estimateImageBytes(oldImg);
        oldImg.src = '';
      }
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, img);
    this.currentMemoryBytes += itemBytes;
  }

  public static has(key: string): boolean {
    return this.cache.has(key);
  }

  public static clear(): void {
    for (const img of this.cache.values()) {
      img.src = '';
    }
    this.cache.clear();
    this.currentMemoryBytes = 0;
  }

  public static size(): number {
    return this.cache.size;
  }

  public static getMemoryBytes(): number {
    return this.currentMemoryBytes;
  }

  public static getMaxMemoryBytes(): number {
    return this.maxMemoryBytes;
  }

  public static setMaxEntries(entries: number): void {
    this.maxEntries = Math.max(1, entries);
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldImg = this.cache.get(oldestKey);
      if (oldImg) {
        this.currentMemoryBytes -= this.estimateImageBytes(oldImg);
        oldImg.src = '';
      }
      this.cache.delete(oldestKey);
    }
  }

  public static setMaxMemoryBytes(bytes: number): void {
    this.maxMemoryBytes = Math.max(256 * 1024, bytes);
    while (this.currentMemoryBytes > this.maxMemoryBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldImg = this.cache.get(oldestKey);
      if (oldImg) {
        this.currentMemoryBytes -= this.estimateImageBytes(oldImg);
        oldImg.src = '';
      }
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Loads a tile from cache or network, trying fallback URLs.
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

    const urls = provider.getTileUrls(zoom, x, y);
    let lastError: any = null;

    for (const url of urls) {
      if (signal?.aborted) break;
      try {
        const img = await this.loadImageWithTimeout(url, timeoutMs, signal);
        this.set(key, img);
        return img;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error(`Failed to load tile ${zoom}/${x}/${y} from ${provider.displayName}`);
  }

  private static loadImageWithTimeout(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';

      let timer: number | null = window.setTimeout(() => {
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
