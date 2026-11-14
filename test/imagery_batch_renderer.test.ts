import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryBatchRenderer, IMAGERY_BATCH_LIMITS } from '../src/terrain/ImageryBatchRenderer.ts';
import type { ImageryPatch } from '../src/terrain/ImageryLODManager.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(maxPages = 2) {
  vi.spyOn(performance, 'now').mockReturnValue(0);
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

it('keeps fades on the source renderer and preserves hidden members', () => {
  const renderer = fixture(), p = patch('a'), patches = new Map([[p.key, p]]);
  p.isFading = true; (p.mesh.material as THREE.Material).opacity = 0.4;
  renderer.sync(patches); expect(renderer.getDiagnostics().patches).toBe(0);
  expect((p.mesh.material as THREE.Material).visible).toBe(true);
  p.isFading = false; (p.mesh.material as THREE.Material).opacity = 1;
  renderer.sync(patches);
  p.mesh.visible = false; renderer.sync(patches);
  // A hidden member keeps its layer; the terrain shader reads its logical visibility.
  expect(renderer.getTextureBindings().entries[0].patch.mesh.visible).toBe(false);
  expect(renderer.getDiagnostics().uploads).toBe(1);
  renderer.clear(); p.dispose();
});

it('bounds pages and memory without hiding tiles that cannot fit', () => {
  const renderer = fixture(1);
  const patches = new Map(Array.from({ length: IMAGERY_BATCH_LIMITS.layers + 1 }, (_, i) => { const p = patch(String(i), 18 + (i % 2)); return [p.key, p] as const; }));
  for (let i = 0; i < 40; i++) renderer.sync(patches);
  expect(renderer.getDiagnostics().pages).toBe(1);
  expect(renderer.getDiagnostics().patches).toBe(IMAGERY_BATCH_LIMITS.layers); // both zooms share the page
  expect(renderer.getDiagnostics().arrayBytes).toBeLessThanOrEqual(IMAGERY_BATCH_LIMITS.arrayBytes);
  const overflow = [...patches.values()].filter(p => !renderer.owns(p.key));
  expect(overflow).toHaveLength(1);
  expect((overflow[0].mesh.material as THREE.Material).visible).toBe(true); // still drawn by its own mesh
  renderer.clear(); for (const p of patches.values()) p.dispose();
});

it('falls back after unreadable imagery and releases page resources without closing source images', () => {
  const renderer = fixture(), p = patch('a');
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => { throw new Error('Unreadable image'); } }) });
  renderer.sync(new Map([[p.key, p]]));
  expect(renderer.getDiagnostics().patches).toBe(0); expect(renderer.getDiagnostics().pages).toBe(0);
  expect(renderer.getDiagnostics().failures).toBe(1); expect((p.mesh.material as THREE.Material).visible).toBe(true);
  renderer.clear(); expect((p.texture.image as HTMLCanvasElement).width).toBe(2); p.dispose();
});

it('defers a second expensive transfer but still releases every stale copy in the frame', () => {
  const renderer = fixture(), a = patch('a'), b = patch('b'), patches = new Map([[a.key, a], [b.key, b]]);
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const read = vi.fn(() => { clock += 3; return { data: new Uint8ClampedArray(16).fill(255) }; });
  vi.stubGlobal('document', { createElement: () => ({ width: 2, height: 2, getContext: () => ({
    setTransform() {}, drawImage() {}, getImageData: read,
  }) }) });
  renderer.sync(patches);
  expect(renderer.getDiagnostics().patches).toBe(1); expect(read).toHaveBeenCalledTimes(1);
  renderer.sync(patches); expect(renderer.getDiagnostics().patches).toBe(2);
  for (const p of patches.values()) p.texture.needsUpdate = true; // new imagery for both tiles
  renderer.sync(patches);
  expect(renderer.getDiagnostics().patches).toBe(1);
  expect([...patches.values()].filter(p => (p.mesh.material as THREE.Material).visible)).toHaveLength(1);
  expect(renderer.getDiagnostics().lastPreparationMs).toBe(3);
  expect(renderer.getDiagnostics().maxPreparationMs).toBe(3);
  renderer.clear(); a.dispose(); b.dispose();
});

it('retains direct-surface imagery through terrain replacement without allocating or recopying patch geometry', () => {
  const renderer = fixture(2), p = patch('direct'), patches = new Map([[p.key, p]]);
  renderer.sync(patches);
  const replacement = p.mesh.geometry.clone();
  p.mesh.geometry.dispose(); p.mesh.geometry = replacement;
  renderer.sync(patches);
  expect(renderer.getDiagnostics().uploads).toBe(1);
  expect(renderer.getTextureBindings().entries).toHaveLength(1);
  expect(renderer.group.children.every(child => !child.visible)).toBe(true);
  p.mesh.visible = false; renderer.sync(patches);
  expect(renderer.getTextureBindings().entries[0].patch.mesh.visible).toBe(false);
  renderer.clear(); expect((p.mesh.material as THREE.Material).visible).toBe(true); p.dispose();
});
