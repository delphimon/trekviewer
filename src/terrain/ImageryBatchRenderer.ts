import * as THREE from 'three';
import type { ImageryPatch } from './ImageryLODManager.ts';

export const IMAGERY_BATCH_LIMITS = {
  layers: 32, arrayBytes: 128 * 1024 * 1024, uploadsPerFrame: 2, preparationMsPerFrame: 2,
} as const;
/** Texture-array pages (32 tiles each); bounded again by arrayBytes for large tiles. */
const DEFAULT_MAX_PAGES = 11;

/** Tiles the texture arrays can hold at once (layers per page × page limit). */
export function imageryArrayCapacity(maxPages = DEFAULT_MAX_PAGES): number {
  return IMAGERY_BATCH_LIMITS.layers * maxPages;
}

interface Page {
  width: number; height: number; texture: THREE.DataArrayTexture;
  arrayBytes: number; slots: Set<number>;
}
interface Entry {
  patch: ImageryPatch; page: Page; instanceId: number;
  material: THREE.MeshStandardMaterial; textureVersion: number; layersMask: number;
}

/** Bounded texture-array cache read by the terrain imagery shader.
 * Source meshes and images stay with their patches for fallback and recovery. */
export class ImageryBatchRenderer {
  public readonly group = new THREE.Group();
  private readonly pages: Page[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly unreadable = new WeakSet<object>();
  private canvas?: HTMLCanvasElement;
  private uploads = 0;
  private failures = 0;
  private lastPreparationMs = 0;
  private totalPreparationMs = 0;
  private maxPreparationMs = 0;

  constructor(private readonly maxPages = DEFAULT_MAX_PAGES) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > DEFAULT_MAX_PAGES) throw new RangeError('Invalid imagery page limit');
    this.group.name = 'TerrainImageryCache';
  }

  public getDiagnostics() {
    return { pages: this.pages.length, patches: this.entries.size, uploads: this.uploads, failures: this.failures,
      lastPreparationMs: this.lastPreparationMs, totalPreparationMs: this.totalPreparationMs, maxPreparationMs: this.maxPreparationMs,
      arrayBytes: this.pages.reduce((n, page) => n + page.arrayBytes, 0) };
  }

  public getTextureBindings() {
    return { pages: this.pages.map(page => page.texture), entries: [...this.entries.values()].map(entry => ({
      patch: entry.patch, page: this.pages.indexOf(entry.page), layer: entry.instanceId,
    })) };
  }

  public owns(key: string): boolean { return this.entries.has(key); }

  /** Returns false while uploads were deferred by the per-frame budget (call again next frame). */
  public sync(patches: ReadonlyMap<string, ImageryPatch>): boolean {
    const started = performance.now();
    let deferred = false;
    // First release every stale copy, regardless of the upload budget. Changed
    // terrain must render its new source geometry in this very frame.
    for (const [key, entry] of this.entries) {
      const patch = patches.get(key);
      if (patch !== entry.patch || !this.eligible(entry.patch)
        || patch.mesh.material !== entry.material || patch.texture.version !== entry.textureVersion) {
        this.remove(key, entry);
      }
    }
    let remaining = IMAGERY_BATCH_LIMITS.uploadsPerFrame;
    for (const [key, patch] of patches) {
      if (this.entries.has(key) || !patch.mesh.visible || !this.eligible(patch)) continue;
      if (remaining <= 0) { deferred = true; break; }
      if (this.add(key, patch)) remaining--;
      // A tile-count limit alone still permits two expensive readbacks/copies
      // in one frame. Keep making progress, but defer the next successful copy
      // after the CPU preparation allowance is consumed. One operation and
      // stale-copy cleanup are indivisible and can exceed this soft allowance.
      if (remaining < IMAGERY_BATCH_LIMITS.uploadsPerFrame
        && performance.now() - started >= IMAGERY_BATCH_LIMITS.preparationMsPerFrame) { deferred = true; break; }
    }
    for (let i = this.pages.length - 1; i >= 0; i--) if (this.pages[i].slots.size === 0) {
      this.destroyPage(this.pages[i]); this.pages.splice(i, 1);
    }
    this.lastPreparationMs = performance.now() - started;
    this.totalPreparationMs += this.lastPreparationMs;
    this.maxPreparationMs = Math.max(this.maxPreparationMs, this.lastPreparationMs);
    return !deferred;
  }

  public clear(): void {
    for (const [key, entry] of this.entries) this.remove(key, entry);
    for (const page of this.pages) this.destroyPage(page);
    this.pages.length = 0;
    // Source images stay owned by the existing tile cache/patch lifecycle.
    if (this.canvas) { this.canvas.width = this.canvas.height = 1; this.canvas = undefined; }
  }

  private eligible(patch: ImageryPatch): boolean {
    const material = patch.mesh.material;
    return material instanceof THREE.MeshStandardMaterial && !patch.isFading && !material.transparent
      && material.opacity === 1 && material.map === patch.texture
      && patch.texture.colorSpace === THREE.SRGBColorSpace && patch.texture.generateMipmaps
      && patch.texture.minFilter === THREE.LinearMipmapLinearFilter && patch.texture.magFilter === THREE.LinearFilter
      && patch.texture.offset.lengthSq() === 0 && patch.texture.repeat.x === 1 && patch.texture.repeat.y === 1
      && patch.texture.rotation === 0 && !patch.texture.premultiplyAlpha;
  }

  private add(key: string, patch: ImageryPatch): boolean {
    const image = patch.texture.image as HTMLCanvasElement | HTMLImageElement | undefined;
    if (!image || this.unreadable.has(image)) return false;
    const width = image.width, height = image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return false;
    let page = this.pages.find(p => p.width === width && p.height === height
      && p.texture.anisotropy === patch.texture.anisotropy && p.slots.size < IMAGERY_BATCH_LIMITS.layers);
    if (!page) {
      const arrayBytes = this.mipBytes(width, height) * IMAGERY_BATCH_LIMITS.layers;
      if (this.pages.length >= this.maxPages || this.getDiagnostics().arrayBytes + arrayBytes > IMAGERY_BATCH_LIMITS.arrayBytes) {
        // Full: a visible tile takes the slot of a hidden (warm or covered) one.
        page = this.evictHidden(patch, width, height);
        if (!page) return false;
      } else {
        // Allocation failure leaves the source visible, like any other unsupported case.
        try { page = this.createPage(patch, width, height, arrayBytes); }
        catch { this.failures++; return false; }
      }
    }
    try {
      this.canvas ??= document.createElement('canvas');
      this.canvas.width = width; this.canvas.height = height;
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.setTransform(1, 0, 0, patch.texture.flipY ? -1 : 1, 0, patch.texture.flipY ? height : 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      let instanceId = 0; while (page.slots.has(instanceId)) instanceId++;
      (page.texture.image.data as Uint8Array).set(pixels, instanceId * width * height * 4);
      page.texture.addLayerUpdate(instanceId); page.texture.needsUpdate = true;
      page.slots.add(instanceId);
      const material = patch.mesh.material as THREE.MeshStandardMaterial;
      this.entries.set(key, { patch, page, instanceId, material, textureVersion: patch.texture.version, layersMask: patch.mesh.layers.mask });
      material.visible = false;
      // Exclude this draw object from every camera while retaining logical
      // visibility for coverage, selection and debug-bound children.
      patch.mesh.layers.mask = 0;
      // Preserve CPU data, release redundant GPU handles from the fade/fallback.
      patch.mesh.geometry.dispose(); material.dispose(); patch.texture.dispose();
      this.uploads++;
      return true;
    } catch {
      this.unreadable.add(image); this.failures++;
      return false;
    }
  }

  private evictHidden(patch: ImageryPatch, width: number, height: number): Page | undefined {
    for (const [key, entry] of this.entries) {
      const page = entry.page;
      if (entry.patch.mesh.visible || page.width !== width || page.height !== height
        || page.texture.anisotropy !== patch.texture.anisotropy) continue;
      this.remove(key, entry);
      return page;
    }
    return undefined;
  }

  private remove(key: string, entry: Entry): void {
    entry.page.slots.delete(entry.instanceId);
    entry.material.visible = true; entry.material.needsUpdate = true;
    entry.patch.mesh.layers.mask = entry.layersMask;
    entry.patch.texture.needsUpdate = true;
    this.entries.delete(key);
  }

  private mipBytes(width: number, height: number): number {
    let bytes = 0;
    while (true) {
      bytes += width * height * 4;
      if (width === 1 && height === 1) return bytes;
      width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
    }
  }

  private createPage(patch: ImageryPatch, width: number, height: number, arrayBytes: number): Page {
    const texture = new THREE.DataArrayTexture(new Uint8Array(width * height * IMAGERY_BATCH_LIMITS.layers * 4), width, height, IMAGERY_BATCH_LIMITS.layers);
    texture.colorSpace = THREE.SRGBColorSpace; texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = true; texture.anisotropy = patch.texture.anisotropy;
    const page: Page = { width, height, texture, arrayBytes, slots: new Set() };
    this.pages.push(page);
    return page;
  }

  private destroyPage(page: Page): void {
    page.texture.dispose();
  }
}
