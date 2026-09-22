import type { ImageryProvider } from './providers/ImageryProvider.ts';

export class TileImageCache {
  private static cache: Map<string, HTMLImageElement> = new Map();
  private static maxEntries: number = 400;

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
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldImg = this.cache.get(oldestKey);
        if (oldImg) oldImg.src = '';
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, img);
  }

  public static has(key: string): boolean {
    return this.cache.has(key);
  }

  public static clear(): void {
    for (const img of this.cache.values()) {
      img.src = '';
    }
    this.cache.clear();
  }

  public static size(): number {
    return this.cache.size;
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
