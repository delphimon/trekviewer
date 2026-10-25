import * as THREE from 'three';
import type { TextureStyle } from '../gpx/TrackTypes.ts';
import { disposeOwnedCanvasTexture } from './CompositeImagery.ts';

type Progress = (texture: THREE.CanvasTexture, completed: number, total: number) => void;
type Loader = (style: TextureStyle, progress: Progress, signal: AbortSignal, fallback: CanvasImageSource) => Promise<THREE.CanvasTexture | null>;
interface Entry { texture: THREE.CanvasTexture | null; request: Promise<THREE.CanvasTexture | null>; }

/** A terrain owns at most one pending composition per style, including inactive partial textures. */
export class TerrainImagery {
  private readonly lifetime = new AbortController();
  private readonly entries = new Map<TextureStyle, Entry>();
  private readonly textures = new Set<THREE.CanvasTexture>();
  private disposed = false;
  private readonly parentAbort = () => this.lifetime.abort();

  constructor(private readonly load: Loader, private readonly onProgress: (style: TextureStyle, texture: THREE.CanvasTexture, completed: number, total: number) => void, private readonly parentSignal?: AbortSignal) {
    if (parentSignal?.aborted) this.lifetime.abort();
    else parentSignal?.addEventListener('abort', this.parentAbort, { once: true });
  }

  public peek(style: TextureStyle): THREE.CanvasTexture | null { return this.entries.get(style)?.texture ?? null; }

  public invalidateStyle(style: TextureStyle): void {
    const entry = this.entries.get(style);
    if (entry) {
      this.entries.delete(style);
      if (entry.texture) this.release(entry.texture);
    }
  }

  public acquire(style: TextureStyle, fallback: CanvasImageSource): Promise<THREE.CanvasTexture | null> {
    if (this.disposed || this.lifetime.signal.aborted) return Promise.resolve(null);
    const existing = this.entries.get(style);
    if (existing) return existing.request;
    const entry: Entry = { texture: null, request: Promise.resolve(null) };
    this.entries.set(style, entry);
    // Defer invocation until the entry/request is installed, even with synchronous progress callbacks.
    entry.request = Promise.resolve().then(() => {
      if (this.disposed || this.lifetime.signal.aborted) return null;
      return this.load(style, (texture, completed, total) => {
        if (this.disposed || this.lifetime.signal.aborted) { this.release(texture); return; }
        entry.texture = texture; this.textures.add(texture);
        this.onProgress(style, texture, completed, total);
      }, this.lifetime.signal, fallback);
    }).then(texture => {
      if (texture) {
        if (this.disposed || this.lifetime.signal.aborted) {
          this.release(texture); return null;
        }
        entry.texture = texture; this.textures.add(texture);
      } else {
        this.entries.delete(style);
        if (entry.texture) this.release(entry.texture);
      }
      return texture;
    }).catch(error => {
      this.entries.delete(style);
      if (entry.texture) this.release(entry.texture);
      if (!this.disposed && !this.lifetime.signal.aborted) throw error;
      return null;
    });
    return entry.request;
  }

  public getGraphicsResources(): THREE.CanvasTexture[] { return [...this.textures]; }

  /** Once committed, the terrain owns cancellation until its replacement is ready. */
  public detachLoadSignal(): void {
    this.parentSignal?.removeEventListener('abort', this.parentAbort);
  }

  private release(texture: THREE.CanvasTexture): void {
    this.textures.delete(texture);
    disposeOwnedCanvasTexture(texture);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.detachLoadSignal();
    for (const texture of this.textures) this.release(texture);
    this.entries.clear();
  }
}
