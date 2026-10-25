import * as THREE from 'three';
import type { ImageryPatch } from './ImageryLODManager.ts';

export const IMAGERY_BATCH_LIMITS = {
  layers: 32, verticesPerPage: 65_536, indicesPerPage: 196_608,
  arrayBytes: 128 * 1024 * 1024, geometryBytes: 32 * 1024 * 1024, uploadsPerFrame: 2,
  preparationMsPerFrame: 2,
} as const;
const PAGE_GEOMETRY_BYTES = IMAGERY_BATCH_LIMITS.verticesPerPage * 32 + IMAGERY_BATCH_LIMITS.indicesPerPage * 4;

interface Page {
  zoom: number; width: number; height: number;
  mesh?: THREE.BatchedMesh; texture: THREE.DataArrayTexture;
  arrayBytes: number; vertices: number; indices: number;
  slots: Set<number>;
}
interface Entry {
  patch: ImageryPatch; page: Page; geometryId: number; instanceId: number;
  geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial;
  textureVersion: number; versions: string; matrix: THREE.Matrix4;
  layersMask: number;
}

/** Bounded texture-array cache, with optional clipped-mesh batching.
 * Retain CPU source meshes and images for fallback. */
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

  public static supported(renderer: THREE.WebGLRenderer): boolean {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    return typeof gl.texImage3D === 'function' && renderer.extensions.has('WEBGL_multi_draw')
      && gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) >= IMAGERY_BATCH_LIMITS.layers;
  }

  constructor(private readonly maxPages = Math.floor(IMAGERY_BATCH_LIMITS.geometryBytes / PAGE_GEOMETRY_BYTES), private readonly directSurface = false,
    private readonly beforeRelease?: (patch: ImageryPatch) => void) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > Math.floor(IMAGERY_BATCH_LIMITS.geometryBytes / PAGE_GEOMETRY_BYTES)) throw new RangeError('Invalid imagery page limit');
    this.group.name = this.directSurface ? 'TerrainImageryCache' : 'ImageryBatchPrototype';
  }

  public getDiagnostics() {
    return { pages: this.pages.length, patches: this.entries.size, uploads: this.uploads, failures: this.failures,
      lastPreparationMs: this.lastPreparationMs, totalPreparationMs: this.totalPreparationMs, maxPreparationMs: this.maxPreparationMs,
      arrayBytes: this.pages.reduce((n, page) => n + page.arrayBytes, 0),
      geometryBytes: this.directSurface ? 0 : this.pages.length * PAGE_GEOMETRY_BYTES };
  }

  public getTextureBindings() {
    return { pages: this.pages.map(page => page.texture), entries: [...this.entries.values()].map(entry => ({
      patch: entry.patch, page: this.pages.indexOf(entry.page), layer: entry.instanceId,
    })) };
  }

  public owns(key: string): boolean { return this.entries.has(key); }

  public sync(patches: ReadonlyMap<string, ImageryPatch>): void {
    const started = performance.now();
    // First release every stale copy, regardless of the upload budget. Changed
    // terrain must render its new source geometry in this very frame.
    for (const [key, entry] of this.entries) {
      const patch = patches.get(key);
      if (patch !== entry.patch || !this.eligible(entry.patch)
        || (!this.directSurface && (patch.mesh.geometry !== entry.geometry || this.versions(entry.geometry) !== entry.versions))
        || patch.mesh.material !== entry.material || patch.texture.version !== entry.textureVersion) {
        this.remove(key, entry);
      } else {
        if (this.directSurface || !entry.page.mesh) continue;
        entry.page.mesh.setVisibleAt(entry.instanceId, patch.mesh.visible);
        patch.mesh.updateMatrix();
        if (!entry.matrix.equals(patch.mesh.matrix)) {
          entry.matrix.copy(patch.mesh.matrix);
          entry.page.mesh.setMatrixAt(entry.instanceId, entry.matrix);
        }
      }
    }
    let remaining = IMAGERY_BATCH_LIMITS.uploadsPerFrame;
    for (const [key, patch] of patches) {
      if (remaining <= 0) break;
      if (this.entries.has(key) || !patch.mesh.visible || !this.eligible(patch)) continue;
      if (this.add(key, patch)) remaining--;
      // A tile-count limit alone still permits two expensive readbacks/copies
      // in one frame. Keep making progress, but defer the next successful copy
      // after the CPU preparation allowance is consumed. One operation and
      // stale-copy cleanup are indivisible and can exceed this soft allowance.
      if (remaining < IMAGERY_BATCH_LIMITS.uploadsPerFrame
        && performance.now() - started >= IMAGERY_BATCH_LIMITS.preparationMsPerFrame) break;
    }
    for (let i = this.pages.length - 1; i >= 0; i--) if (this.pages[i].slots.size === 0) {
      this.destroyPage(this.pages[i]); this.pages.splice(i, 1);
    }
    this.lastPreparationMs = performance.now() - started;
    this.totalPreparationMs += this.lastPreparationMs;
    this.maxPreparationMs = Math.max(this.maxPreparationMs, this.lastPreparationMs);
  }

  public clear(): void {
    for (const [key, entry] of this.entries) this.remove(key, entry);
    for (const page of this.pages) this.destroyPage(page);
    this.pages.length = 0;
    // Source images stay owned by the existing tile cache/patch lifecycle.
    if (this.canvas) { this.canvas.width = this.canvas.height = 1; this.canvas = undefined; }
  }

  private versions(geometry: THREE.BufferGeometry): string {
    return `${(geometry.attributes.position as THREE.BufferAttribute).version}/${(geometry.attributes.normal as THREE.BufferAttribute).version}/${(geometry.attributes.uv as THREE.BufferAttribute).version}/${geometry.index?.version}`;
  }

  private eligible(patch: ImageryPatch): boolean {
    const material = patch.mesh.material;
    const geometry = patch.mesh.geometry;
    return material instanceof THREE.MeshStandardMaterial && !patch.isFading && !material.transparent
      && material.opacity === 1 && material.depthWrite && material.map === patch.texture
      && material.roughness === 0.9 && material.metalness === 0 && material.color.getHex() === 0xffffff
      && material.depthTest && material.side === THREE.FrontSide && material.polygonOffset
      && material.polygonOffsetFactor === -(1 + (patch.zoom - 13) / 8)
      && material.polygonOffsetUnits === material.polygonOffsetFactor
      && !material.normalMap && !material.alphaMap && !material.envMap && !material.aoMap && !material.lightMap
      && !material.roughnessMap && !material.metalnessMap && !material.bumpMap && !material.displacementMap
      && material.emissive.getHex() === 0 && !material.vertexColors && !material.flatShading
      && material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile
      && patch.texture.colorSpace === THREE.SRGBColorSpace && patch.texture.generateMipmaps
      && patch.texture.minFilter === THREE.LinearMipmapLinearFilter && patch.texture.magFilter === THREE.LinearFilter
      && patch.texture.offset.lengthSq() === 0 && patch.texture.repeat.x === 1 && patch.texture.repeat.y === 1
      && patch.texture.rotation === 0 && !patch.texture.premultiplyAlpha
      && (this.directSurface || (!!geometry.index && geometry.index.count > 0 && geometry.drawRange.start === 0
      && geometry.drawRange.count >= geometry.index.count
      && Object.keys(geometry.attributes).sort().join() === 'normal,position,uv'
      && Object.values(geometry.attributes).every(attribute => attribute instanceof THREE.BufferAttribute && !attribute.normalized && attribute.array instanceof Float32Array)
      && geometry.attributes.position.count <= IMAGERY_BATCH_LIMITS.verticesPerPage
      && geometry.index.count <= IMAGERY_BATCH_LIMITS.indicesPerPage));
  }

  private add(key: string, patch: ImageryPatch): boolean {
    const image = patch.texture.image as HTMLCanvasElement | HTMLImageElement | undefined;
    if (!image || this.unreadable.has(image)) return false;
    const width = image.width, height = image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return false;
    const geometry = patch.mesh.geometry, vertices = this.directSurface ? 0 : geometry.attributes.position.count, indices = this.directSurface ? 0 : geometry.index!.count;
    let page = this.pages.find(p => (this.directSurface || (p.zoom === patch.zoom && p.mesh?.renderOrder === patch.mesh.renderOrder))
      && p.width === width && p.height === height
      && p.texture.anisotropy === patch.texture.anisotropy && p.slots.size < IMAGERY_BATCH_LIMITS.layers
      && p.vertices + vertices <= IMAGERY_BATCH_LIMITS.verticesPerPage && p.indices + indices <= IMAGERY_BATCH_LIMITS.indicesPerPage);
    if (!page) {
      const diagnostics = this.getDiagnostics();
      const arrayBytes = this.mipBytes(width, height) * IMAGERY_BATCH_LIMITS.layers;
      if (this.pages.length >= this.maxPages || diagnostics.arrayBytes + arrayBytes > IMAGERY_BATCH_LIMITS.arrayBytes
        || (!this.directSurface && diagnostics.geometryBytes + PAGE_GEOMETRY_BYTES > IMAGERY_BATCH_LIMITS.geometryBytes)) return false;
      // Allocation failure must leave the source visible, like any other
      // unsupported case; never turn a rendering experiment into a blank tile.
      try { page = this.createPage(patch, width, height, arrayBytes); }
      catch { this.failures++; return false; }
    }
    let geometryId: number | undefined;
    try {
      this.canvas ??= document.createElement('canvas');
      this.canvas.width = width; this.canvas.height = height;
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.setTransform(1, 0, 0, patch.texture.flipY ? -1 : 1, 0, patch.texture.flipY ? height : 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      let instanceId: number;
      if (this.directSurface || !page.mesh) {
        instanceId = 0; while (page.slots.has(instanceId)) instanceId++;
        geometryId = -1;
      } else {
        if (page.mesh.unusedVertexCount < vertices || page.mesh.unusedIndexCount < indices) page.mesh.optimize();
        geometryId = page.mesh.addGeometry(geometry);
        instanceId = page.mesh.addInstance(geometryId);
      }
      (page.texture.image.data as Uint8Array).set(pixels, instanceId * width * height * 4);
      page.texture.addLayerUpdate(instanceId); page.texture.needsUpdate = true;
      patch.mesh.updateMatrix();
      if (!this.directSurface && page.mesh) { page.mesh.setMatrixAt(instanceId, patch.mesh.matrix); page.mesh.setVisibleAt(instanceId, patch.mesh.visible); }
      page.slots.add(instanceId);
      page.vertices += vertices; page.indices += indices;
      const material = patch.mesh.material as THREE.MeshStandardMaterial;
      this.entries.set(key, { patch, page, geometryId, instanceId, geometry, material,
        textureVersion: patch.texture.version, versions: this.versions(geometry), matrix: patch.mesh.matrix.clone(), layersMask: patch.mesh.layers.mask });
      material.visible = false;
      // Material visibility is checked after Three's object/buffer update.
      // Exclude this draw object from every camera while retaining logical
      // visibility for coverage, selection and debug-bound children.
      patch.mesh.layers.mask = 0;
      // Preserve CPU data, release redundant GPU handles from the fade/fallback.
      geometry.dispose(); material.dispose(); patch.texture.dispose();
      this.uploads++;
      return true;
    } catch {
      if (geometryId !== undefined && geometryId >= 0 && page.mesh) page.mesh.deleteGeometry(geometryId);
      this.unreadable.add(image); this.failures++;
      return false;
    }
  }

  private remove(key: string, entry: Entry): void {
    this.beforeRelease?.(entry.patch);
    if (!this.directSurface && entry.page.mesh) {
      entry.page.mesh.deleteGeometry(entry.geometryId);
      entry.page.vertices -= entry.geometry.attributes.position.count;
      entry.page.indices -= entry.geometry.index!.count;
    }
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
    let mesh: THREE.BatchedMesh | undefined;
    if (!this.directSurface) {
      const material = (patch.mesh.material as THREE.MeshStandardMaterial).clone();
      material.visible = true; material.map = texture;
      material.customProgramCacheKey = () => 'imagery-array-batch-v1';
      material.onBeforeCompile = shader => {
        shader.vertexShader = 'flat varying float vImageryLayer;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <batching_vertex>', '#include <batching_vertex>\nvImageryLayer = getIndirectIndex(gl_DrawID);');
        shader.fragmentShader = 'flat varying float vImageryLayer;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_pars_fragment>', 'uniform highp sampler2DArray map;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', 'diffuseColor *= texture(map, vec3(vMapUv, vImageryLayer));');
      };
      mesh = new THREE.BatchedMesh(IMAGERY_BATCH_LIMITS.layers, IMAGERY_BATCH_LIMITS.verticesPerPage, IMAGERY_BATCH_LIMITS.indicesPerPage, material);
      // Culling happens per member in BatchedMesh, including an ArrayCamera's eyes.
      mesh.frustumCulled = false; mesh.renderOrder = patch.mesh.renderOrder;
      mesh.visible = true;
      this.group.add(mesh);
    }
    const page: Page = { zoom: patch.zoom, width, height, mesh, texture, arrayBytes, vertices: 0, indices: 0, slots: new Set() };
    this.pages.push(page);
    return page;
  }

  private destroyPage(page: Page): void {
    if (page.mesh) {
      this.group.remove(page.mesh); page.mesh.dispose();
      (page.mesh.material as THREE.Material).dispose();
    }
    page.texture.dispose();
  }
}
