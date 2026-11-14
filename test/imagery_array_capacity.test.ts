import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryBatchRenderer, IMAGERY_BATCH_LIMITS, imageryArrayCapacity } from '../src/terrain/ImageryBatchRenderer.ts';
import { ImageryLODManager, type ImageryPatch } from '../src/terrain/ImageryLODManager.ts';
import { QUALITY_PROFILES } from '../src/terrain/QualityProfile.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 5000, depthMeters: 5000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function stubCanvas() {
  let image: any;
  vi.stubGlobal('document', { createElement: () => ({ width: 2, height: 2, getContext: () => ({
    setTransform: () => {}, drawImage: (next: any) => { image = next; },
    getImageData: () => ({ data: image.pixels ?? new Uint8ClampedArray(image.width * image.height * 4) }),
  }) }) });
}

function image(size = 2) {
  return { width: size, height: size, pixels: new Uint8ClampedArray(size * size * 4).fill(255) } as unknown as HTMLCanvasElement;
}

function patch(key: string, zoom = 19): ImageryPatch {
  const texture = new THREE.CanvasTexture(image() as any);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -(1 + (zoom - 13) / 8), polygonOffsetUnits: -(1 + (zoom - 13) / 8) });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  return { key, zoom, x: 0, y: 0, mesh, texture, isFading: false, creationTime: 0, fadeDurationMs: 150,
    centerDist: 0, lastUsed: 0, dispose: () => { mesh.geometry.dispose(); material.dispose(); texture.dispose(); } };
}

function terrainGrid() {
  const nw = latLonToTile(bounds.maxLat, bounds.minLon, 13), se = latLonToTile(bounds.minLat, bounds.maxLon, 13);
  return { zoom: 13, tileXMin: nw.x, tileXMax: se.x, tileYMin: nw.y, tileYMax: se.y,
    numTilesX: se.x - nw.x + 1, numTilesY: se.y - nw.y + 1 };
}

function stubRenderer() {
  return { getContext: () => ({ texImage3D: () => {}, getParameter: () => 2048, MAX_ARRAY_TEXTURE_LAYERS: 0 }),
    capabilities: { maxTextures: 16, maxTextureSize: 16384 }, extensions: { has: () => true } } as unknown as THREE.WebGLRenderer;
}

function manager(terrainShader: boolean) {
  const geometry = new THREE.PlaneGeometry(5000, 5000, 16, 16); geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); mesh.name = 'BaseTerrainMesh';
  const root = new THREE.Group(); root.scale.setScalar(0.0001); root.add(mesh); root.updateMatrixWorld(true);
  const lod = new ImageryLODManager({ terrainMesh: mesh, terrainBaseElevation: 0, elevationSampler: () => 0,
    terrainGeoBounds: bounds, qualityProfile: QUALITY_PROFILES['quest-high'], enableFadeIn: false,
    experimentalTerrainImagery: terrainShader, terrainTileGrid: terrainShader ? terrainGrid() : undefined });
  root.add(lod.group);
  return { lod, root, dispose: () => { lod.dispose(); geometry.dispose(); mesh.material.dispose(); } };
}

it('reports texture-array capacity as layers times pages', () => {
  expect(imageryArrayCapacity(3)).toBe(IMAGERY_BATCH_LIMITS.layers * 3);
  expect(imageryArrayCapacity()).toBeLessThan(QUALITY_PROFILES['quest-high'].tabletopPatches);
});

it('clamps the quest-high tile budget to the texture-array capacity only in terrain-shader mode', () => {
  const shader = manager(true), patches = manager(false);
  try {
    const capacity = imageryArrayCapacity();
    expect(shader.lod.getDiagnostics().patchBudget).toBe(capacity - 32);
    shader.lod.setViewMode('first-person');
    expect(shader.lod.getDiagnostics().patchBudget).toBe(capacity - 32);
    shader.lod.setQualityProfile(QUALITY_PROFILES['quest-balanced']);
    expect(shader.lod.getDiagnostics().patchBudget).toBe(QUALITY_PROFILES['quest-balanced'].firstPersonPatches);
    expect(patches.lod.getDiagnostics().patchBudget).toBe(QUALITY_PROFILES['quest-high'].tabletopPatches);
  } finally { shader.dispose(); patches.dispose(); }
});

it('selects no more tiles than the arrays hold and never draws a proxy patch in terrain-shader mode', async () => {
  stubCanvas();
  vi.spyOn(ImageryLODManager, 'loadPatchImage').mockImplementation(async () => image());
  const { lod, root, dispose } = manager(true);
  const camera = new THREE.PerspectiveCamera(60, 1, 1e-7, 10);
  camera.position.set(0, 0.02, 0.02); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const renderer = stubRenderer();
  try {
    let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    for (let frame = 0; frame < 20; frame++) {
      lod.update(camera, root, false, undefined, renderer);
      lod.syncRenderer(renderer);
      await flush(); now += 500;
      lod.syncRenderer(renderer);
      const drawn = lod.group.children.filter(child => child.name.startsWith('ImageryPatch_')
        && child.visible && child.layers.mask !== 0 && (child as THREE.Mesh<any, THREE.Material>).material.visible);
      expect(drawn).toHaveLength(0);
    }
    expect(lod.getBatchDiagnostics().mode).toBe('terrain');
    const diagnostics = lod.getDiagnostics();
    expect(diagnostics.activePatchesCount).toBeGreaterThan(0);
    expect(diagnostics.requestedCount).toBeLessThanOrEqual(imageryArrayCapacity());
    expect(diagnostics.activePatchesCount).toBeLessThanOrEqual(imageryArrayCapacity());
  } finally { dispose(); }
});

it('gives a visible tile the slot of a hidden tile when every array is full', () => {
  stubCanvas();
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const renderer = new ImageryBatchRenderer(1);
  const patches = new Map(Array.from({ length: IMAGERY_BATCH_LIMITS.layers }, (_, i) => {
    const p = patch(String(i)); return [p.key, p] as const;
  }));
  for (let i = 0; i < IMAGERY_BATCH_LIMITS.layers; i++) renderer.sync(patches);
  expect(renderer.getDiagnostics().patches).toBe(IMAGERY_BATCH_LIMITS.layers);
  const hidden = patches.get('3')!; hidden.mesh.visible = false;
  const incoming = patch('new'); patches.set(incoming.key, incoming);
  renderer.sync(patches);
  expect(renderer.owns('new')).toBe(true);
  expect(renderer.owns('3')).toBe(false);
  expect(renderer.getDiagnostics().patches).toBe(IMAGERY_BATCH_LIMITS.layers);
  renderer.clear(); for (const p of patches.values()) p.dispose();
});
