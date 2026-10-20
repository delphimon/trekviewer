import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryBatchRenderer, IMAGERY_BATCH_LIMITS } from '../src/terrain/ImageryBatchRenderer.ts';
import type { ImageryPatch } from '../src/terrain/ImageryLODManager.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(maxPages = 2) {
  let image: any;
  vi.stubGlobal('document', { createElement: () => ({ width: 2, height: 2, getContext: () => ({
    setTransform: () => {}, drawImage: (next: any) => { image = next; },
    getImageData: () => ({ data: image.pixels }),
  }) }) });
  return new ImageryBatchRenderer(maxPages);
}

function patch(key: string, zoom = 19, size = 2): ImageryPatch {
  const image = { width: size, height: size, pixels: new Uint8ClampedArray(size * size * 4).fill(255) };
  const texture = new THREE.CanvasTexture(image as any);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -(1 + (zoom - 13) / 8), polygonOffsetUnits: -(1 + (zoom - 13) / 8) });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 2, 2), material);
  mesh.renderOrder = 1 + (zoom - 13) / 8;
  return { key, zoom, x: 0, y: 0, mesh, texture, isFading: false, creationTime: 0,
    fadeDurationMs: 150, centerDist: 0, lastUsed: 0,
    dispose: () => { mesh.geometry.dispose(); material.dispose(); texture.dispose(); } };
}

it('copies exact positions, normals, UVs and topology while keeping source geometry and visibility for terrain logic', () => {
  const renderer = fixture(), p = patch('a');
  const geometry = p.mesh.geometry;
  const input = Object.fromEntries(Object.entries(geometry.attributes).map(([key, attribute]) => [key, Array.from(attribute.array)]));
  const indices = Array.from(geometry.index!.array);
  renderer.sync(new Map([[p.key, p]]));
  expect(renderer.getDiagnostics().patches).toBe(1);
  const entry = (renderer as any).entries.get(p.key);
  const range = entry.page.mesh.getGeometryRangeAt(entry.geometryId);
  for (const [key, values] of Object.entries(input)) {
    const attribute = entry.page.mesh.geometry.getAttribute(key);
    expect(Array.from(attribute.array.slice(range.vertexStart * attribute.itemSize, (range.vertexStart + range.vertexCount) * attribute.itemSize))).toEqual(values);
  }
  const copied = Array.from(entry.page.mesh.geometry.index.array.slice(range.indexStart, range.indexStart + range.indexCount)) as number[];
  expect(copied.map(i => i - range.vertexStart)).toEqual(indices);
  expect(p.mesh.geometry).toBe(geometry); expect(p.mesh.visible).toBe(true);
  expect((p.mesh.material as THREE.Material).visible).toBe(false);
  renderer.clear(); expect((p.mesh.material as THREE.Material).visible).toBe(true);
  expect(Array.from(geometry.attributes.position.array)).toEqual(input.position);
  p.dispose();
});

it('releases all stale copies before its bounded uploads so terrain promotion cannot leave an old rendered surface', () => {
  const renderer = fixture();
  const patches = new Map(Array.from({ length: 4 }, (_, i) => { const p = patch(String(i)); return [p.key, p] as const; }));
  renderer.sync(patches); expect(renderer.getDiagnostics().patches).toBe(2);
  renderer.sync(patches); expect(renderer.getDiagnostics().patches).toBe(4);
  for (const p of patches.values()) {
    p.mesh.geometry.attributes.position.setY(0, 25);
    p.mesh.geometry.attributes.position.needsUpdate = true;
    p.mesh.geometry.computeBoundingSphere();
  }
  renderer.sync(patches);
  expect(renderer.getDiagnostics().patches).toBe(2);
  expect([...patches.values()].filter(p => (p.mesh.material as THREE.Material).visible)).toHaveLength(2);
  for (const entry of (renderer as any).entries.values()) {
    const range = entry.page.mesh.getGeometryRangeAt(entry.geometryId);
    expect(entry.page.mesh.geometry.attributes.position.getY(range.vertexStart)).toBe(25);
  }
  renderer.clear(); for (const p of patches.values()) p.dispose();
});

it('keeps fades on the source renderer and preserves hidden members and local transforms', () => {
  const renderer = fixture(), p = patch('a'), patches = new Map([[p.key, p]]);
  p.isFading = true; (p.mesh.material as THREE.Material).opacity = 0.4;
  renderer.sync(patches); expect(renderer.getDiagnostics().patches).toBe(0);
  expect((p.mesh.material as THREE.Material).visible).toBe(true);
  p.isFading = false; (p.mesh.material as THREE.Material).opacity = 1;
  renderer.sync(patches);
  p.mesh.visible = false; p.mesh.position.set(2, 3, 4); renderer.sync(patches);
  const entry = (renderer as any).entries.get(p.key);
  expect(entry.page.mesh.getVisibleAt(entry.instanceId)).toBe(false);
  const matrix = new THREE.Matrix4(); entry.page.mesh.getMatrixAt(entry.instanceId, matrix);
  expect(matrix.elements).toEqual(p.mesh.matrix.elements);
  expect(renderer.getDiagnostics().uploads).toBe(1);
  renderer.clear(); p.dispose();
});

it('bounds pages and memory without hiding tiles that cannot fit', () => {
  const renderer = fixture(1), a = patch('a', 18), b = patch('b', 19), patches = new Map([[a.key, a], [b.key, b]]);
  renderer.sync(patches);
  expect(renderer.getDiagnostics().pages).toBe(1); expect(renderer.getDiagnostics().patches).toBe(1);
  expect((b.mesh.material as THREE.Material).visible).toBe(true);
  expect(renderer.getDiagnostics().arrayBytes).toBeLessThanOrEqual(IMAGERY_BATCH_LIMITS.arrayBytes);
  expect(renderer.getDiagnostics().geometryBytes).toBeLessThanOrEqual(IMAGERY_BATCH_LIMITS.geometryBytes);
  patches.delete(a.key); renderer.sync(patches); renderer.sync(patches);
  expect(renderer.getDiagnostics().patches).toBe(1);
  expect((b.mesh.material as THREE.Material).visible).toBe(false);
  renderer.clear(); a.dispose(); b.dispose();
});

it('falls back after unreadable imagery and releases page resources without closing source images', () => {
  const renderer = fixture(), p = patch('a');
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => { throw new Error('Unreadable image'); } }) });
  renderer.sync(new Map([[p.key, p]]));
  expect(renderer.getDiagnostics().patches).toBe(0); expect(renderer.getDiagnostics().pages).toBe(0);
  expect(renderer.getDiagnostics().failures).toBe(1); expect((p.mesh.material as THREE.Material).visible).toBe(true);
  renderer.clear(); expect((p.texture.image as HTMLCanvasElement).width).toBe(2); p.dispose();
});

it('requires actual multi-draw and array capability before enabling the prototype', () => {
  const renderer: any = { extensions: { has: () => true }, getContext: () => ({ texImage3D() {}, getParameter: () => 256 }) };
  expect(ImageryBatchRenderer.supported(renderer)).toBe(true);
  renderer.extensions.has = () => false;
  expect(ImageryBatchRenderer.supported(renderer)).toBe(false);
  renderer.getContext = () => ({});
  expect(ImageryBatchRenderer.supported(renderer)).toBe(false);
});
