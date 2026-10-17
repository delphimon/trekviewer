import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager, getChildTileKeys, getTileKey, type ImageryPatch } from '../src/terrain/ImageryLODManager.ts';

const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 7600, depthMeters: 11100, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
function fixture() {
  const manager = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0, enableFadeIn: false });
  const state = manager as any;
  function add(zoom: number, x: number, y: number, visible = true, dist = 0): ImageryPatch {
    const key = getTileKey('satellite', zoom, x, y);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); mesh.visible = visible;
    const texture = new THREE.Texture();
    const patch: ImageryPatch = { key, zoom, x, y, mesh, texture, centerDist: dist, lastUsed: performance.now(), creationTime: 0,
      isFading: false, fadeDurationMs: 0, dispose: () => { mesh.geometry.dispose(); mesh.material.dispose(); texture.dispose(); } };
    state.patches.set(key, patch); return patch;
  }
  return { manager, state, add };
}
afterEach(() => vi.restoreAllMocks());

it('retains published fine imagery before a hidden unselected fallback even when the fallback has a higher distance/recency score', () => {
  const { manager, state, add } = fixture();
  try {
    const parent = add(18, 84800, 184800);
    const children = getChildTileKeys('satellite', 18, parent.x, parent.y).map(key => {
      const [, z, x, y] = key.split(':'); return add(+z, +x, +y, true, 100);
    });
    state.desiredTileKeys = new Set(children.map(p => p.key)); manager.updatePatchVisibility();
    state.desiredTileKeys.clear();
    expect(parent.mesh.visible).toBe(false);
    expect(manager.calculatePatchImportanceScore(parent, new Set(), performance.now()))
      .toBeGreaterThan(manager.calculatePatchImportanceScore(children[0], new Set(), performance.now()));
    state.maxPatches = 4; state.prunePatches(new Set());
    expect(state.patches.has(parent.key)).toBe(false);
    expect(children.every(p => state.patches.has(p.key) && p.mesh.visible)).toBe(true);
    expect(manager.getDiagnostics()).toMatchObject({ budgetEvictionsTotal: 1, visibleBudgetEvictionsTotal: 0, desiredBudgetEvictionsTotal: 0 });
  } finally { manager.dispose(); }
});

it('protects selected hidden work ahead of unselected visible imagery', () => {
  const { manager, state, add } = fixture();
  try {
    const selected = add(19, 100, 100, false, 100), warm = add(19, 200, 200, true);
    state.desiredTileKeys.add(selected.key);
    state.evictFurthestPatch();
    expect(state.patches.has(selected.key)).toBe(true); expect(state.patches.has(warm.key)).toBe(false);
    expect(manager.getDiagnostics()).toMatchObject({ visibleBudgetEvictionsTotal: 1, desiredBudgetEvictionsTotal: 0 });
  } finally { manager.dispose(); }
});

it('keeps an unselected loading fallback out of the obsolete-hidden tier', () => {
  const { manager, state, add } = fixture();
  try {
    const fallback = add(18, 100, 100, false, 100), obsolete = add(18, 200, 200, false);
    state.desiredTileKeys.add(getChildTileKeys('satellite', 18, fallback.x, fallback.y)[0]);
    expect(state.hasPendingChildren(fallback.key)).toBe(true);
    state.evictFurthestPatch();
    expect(state.patches.has(obsolete.key)).toBe(false); expect(state.patches.has(fallback.key)).toBe(true);
  } finally { manager.dispose(); }
});

it('scores only eligible warm victims and samples the route once for a 512-patch eviction', () => {
  const { manager, state, add } = fixture();
  const telemetry = vi.fn(() => ({ currentPoint: { lat: bounds.centerLat, lon: bounds.centerLon } }));
  state.routeGeometry = { getTelemetryAtProgress: telemetry }; state.viewMode = 'first-person';
  try {
    for (let i = 0; i < 480; i++) state.desiredTileKeys.add(add(19, 84000 + i, 184000).key);
    for (let i = 0; i < 32; i++) add(19, 85000 + i, 185000);
    const score = vi.spyOn(manager, 'calculatePatchImportanceScore');
    state.evictFurthestPatch(state.desiredTileKeys, false);
    expect(score).toHaveBeenCalledTimes(32); expect(telemetry).toHaveBeenCalledTimes(1);
    expect(state.patches.size).toBe(511);
    expect([...state.desiredTileKeys].every(key => state.patches.has(key))).toBe(true);
  } finally { manager.dispose(); }
});

it('enforces a budget smaller than the desired set and records the forced desired eviction', () => {
  const { manager, state, add } = fixture();
  try {
    for (let i = 0; i < 3; i++) state.desiredTileKeys.add(add(19, 100 + i, 100).key);
    state.maxPatches = 2; state.prunePatches(state.desiredTileKeys);
    expect(state.patches.size).toBe(2);
    expect(manager.getDiagnostics()).toMatchObject({ budgetEvictionsTotal: 1, desiredBudgetEvictionsTotal: 1 });
    manager.dispose();
    // Disposal/style cleanup is distinct from memory-pressure eviction.
    expect(manager.getDiagnostics()).toMatchObject({ budgetEvictionsTotal: 1, desiredBudgetEvictionsTotal: 1 });
  } finally { manager.dispose(); }
});
