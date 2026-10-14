import * as THREE from 'three';
import { TileImageCache, TilePriority } from './TileImageCache.ts';
import { TextureBudget } from './TextureBudget.ts';
import type { ImageryProvider } from './providers/ImageryProvider.ts';
import type { TileGridBounds } from './TextureProvider.ts';

export const MAX_COMPOSITE_TILES = 120;

const releasedTextures = new WeakSet<THREE.CanvasTexture>();
/** End CPU/GPU ownership once; context recovery uses texture.dispose() directly to retain the image. */
export function disposeOwnedCanvasTexture(texture: THREE.CanvasTexture): void {
  if (releasedTextures.has(texture)) return;
  releasedTextures.add(texture);
  try { texture.dispose(); }
  finally {
    const image = texture.image;
    if (image && typeof image.getContext === 'function') { image.width = 1; image.height = 1; }
  }
}

export interface CompositeImageryOptions {
  grid: TileGridBounds;
  provider: ImageryProvider;
  timeoutMs: number;
  overlay?: ImageryProvider;
  signal?: AbortSignal;
  isXR: boolean;
  fallbackImage?: CanvasImageSource | null;
  anisotropy: number;
  uploadIntervalMs: number;
  uploadBatchSize: number;
  onProgress?: (texture: THREE.CanvasTexture, completed: number, total: number) => void;
}

/** Compose bounded route imagery; failed tiles keep the complete fallback image. */
export async function composeImagery(options: CompositeImageryOptions): Promise<THREE.CanvasTexture | null> {
  let canvas: HTMLCanvasElement | null = null;
  let texture: THREE.CanvasTexture | null = null;
  let retained = false, stopped = false;
  const { grid, signal } = options;
  try {
    if (signal?.aborted) return null;
    const columns = grid.tileXMax - grid.tileXMin + 1;
    const rows = grid.tileYMax - grid.tileYMin + 1;
    if (![grid.zoom, grid.tileXMin, grid.tileXMax, grid.tileYMin, grid.tileYMax, grid.numTilesX, grid.numTilesY].every(Number.isInteger) ||
        grid.zoom < 0 || grid.zoom > options.provider.maxZoom || columns < 1 || rows < 1 ||
        columns !== grid.numTilesX || rows !== grid.numTilesY || columns * rows > MAX_COMPOSITE_TILES) {
      throw new RangeError('Invalid or oversized route imagery grid');
    }
    const { width, height } = TextureBudget.getAssembledTextureSize(grid.numTilesX, grid.numTilesY, options.isXR);
    canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#6b7280';
    ctx.fillRect(0, 0, width, height);
    if (options.fallbackImage) {
      try { ctx.drawImage(options.fallbackImage, 0, 0, width, height); }
      catch { /* The opaque fallback remains valid. */ }
    }
    const composite = texture = new THREE.CanvasTexture(canvas);
    composite.colorSpace = THREE.SRGBColorSpace;
    composite.wrapS = composite.wrapT = THREE.ClampToEdgeWrapping;
    composite.minFilter = composite.magFilter = THREE.LinearFilter;
    composite.anisotropy = options.anisotropy;
    composite.generateMipmaps = false;

    const tasks: { x: number; y: number }[] = [];
    for (let x = grid.tileXMin; x <= grid.tileXMax; x++) {
      for (let y = grid.tileYMin; y <= grid.tileYMax; y++) tasks.push({ x, y });
    }
    let cursor = 0, completed = 0, successes = 0, dirtyTiles = 0;
    let lastUpload = performance.now();
    const canceled = () => stopped || !!signal?.aborted;
    const worker = async () => {
      while (cursor < tasks.length && !canceled()) {
        const { x, y } = tasks[cursor++];
        const x0 = Math.round((x - grid.tileXMin) * width / grid.numTilesX);
        const x1 = Math.round((x - grid.tileXMin + 1) * width / grid.numTilesX);
        const y0 = Math.round((y - grid.tileYMin) * height / grid.numTilesY);
        const y1 = Math.round((y - grid.tileYMin + 1) * height / grid.numTilesY);
        let baseDrawn = false;
        try {
          const image = await TileImageCache.loadTile(options.provider, grid.zoom, x, y, options.timeoutMs, signal, TilePriority.OVERVIEW);
          if (canceled()) return;
          ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0);
          baseDrawn = true; successes++; dirtyTiles++;
        } catch { /* Keep the fallback for missing imagery. */ }
        if (canceled()) return;
        if (baseDrawn && options.overlay) {
          try {
            const labels = await TileImageCache.loadTile(options.overlay, grid.zoom, x, y, 3500, signal, TilePriority.OVERVIEW);
            if (canceled()) return;
            ctx.drawImage(labels, x0, y0, x1 - x0, y1 - y0);
          } catch { /* Satellite imagery remains usable without labels. */ }
        }
        if (canceled()) return;
        completed++;
        const now = performance.now();
        if (completed < tasks.length && dirtyTiles > 0 &&
            (dirtyTiles >= options.uploadBatchSize || now - lastUpload >= options.uploadIntervalMs)) {
          lastUpload = now; dirtyTiles = 0;
          composite.needsUpdate = true;
          options.onProgress?.(composite, completed, tasks.length);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, tasks.length) }, () => worker()));
    if (canceled() || successes === 0) return null;
    composite.generateMipmaps = true;
    composite.minFilter = THREE.LinearMipmapLinearFilter;
    composite.needsUpdate = true;
    options.onProgress?.(composite, completed, tasks.length);
    if (canceled()) return null;
    retained = true;
    return composite;
  } finally {
    stopped = true;
    if (!retained) {
      if (texture) disposeOwnedCanvasTexture(texture);
      else if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }
}
