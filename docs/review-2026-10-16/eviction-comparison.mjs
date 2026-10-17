// Deterministic residency comparison, not a rendering/FPS benchmark. Exercises
// the current manager and the previous checkpoint's actual eviction method.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }) };
  return next(url, context);
} });
const THREE = await import('three');
const { ImageryLODManager, getTileKey, getChildTileKeys } = await import('../../src/terrain/ImageryLODManager.ts');
const { computeBroadDetailTiles } = await import('../../src/terrain/BroadDetailSelection.ts');
const { latLonToTile } = await import('../../src/gpx/Coordinates.ts');
const baseline = '6c1b71e';
const source = execFileSync('git', ['show', `${baseline}:src/terrain/ImageryLODManager.ts`], { encoding: 'utf8', windowsHide: true });
const start = source.indexOf('  private evictFurthestPatch('), end = source.indexOf('  private clearAllPatches()', start);
assert(start >= 0 && end > start);
const legacy = new Function(`${stripTypeScriptTypes(`class Legacy { ${source.slice(start, end)} }`)}; return Legacy.prototype.evictFurthestPatch;`)();
const center = { lat: 46.85, lon: -121.75 };
const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.85, maxLon: -121.65, centerLat: center.lat, centerLon: center.lon,
  widthMeters: 15000, depthMeters: 11000, minEle: 0, maxEle: 4000, elevationSpan: 4000 };

function compare(useLegacy) {
  const manager = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0,
    maxPatches: 512, enableFadeIn: false, viewMode: 'first-person' });
  if (useLegacy) manager.evictFurthestPatch = legacy;
  const now = performance.now(), tile = latLonToTile(center.lat, center.lon, 19), parent = latLonToTile(center.lat, center.lon, 18);
  const add = (zoom, x, y, recent = true) => {
    const key = getTileKey('satellite', zoom, x, y), mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()), texture = new THREE.Texture();
    const patch = { key, zoom, x, y, mesh, texture, lastUsed: recent ? now : now - 120000, centerDist: 0, creationTime: now,
      isFading: false, fadeDurationMs: 0, dispose: () => { mesh.geometry.dispose(); mesh.material.dispose(); texture.dispose(); } };
    manager.patches.set(key, patch); return patch;
  };
  const current = computeBroadDetailTiles(center, 19, 480, bounds);
  const selected = current.map(t => add(t.zoom, t.x, t.y).key);
  // Fill the controlled scene to 512, including 32 hidden, fully covered warm
  // fallbacks and their 128 published fine children from an older inspected view.
  for (let i = 0; i < 59; i++) selected.push(add(19, tile.x - 70 + i, tile.y - 70).key);
  const warm = [], hidden = [];
  for (let i = 0; i < 32; i++) {
    const p = add(18, parent.x + 20 + i % 8, parent.y + 20 + Math.floor(i / 8)); hidden.push(p.key);
    for (const key of getChildTileKeys('satellite', 18, p.x, p.y)) {
      const [, z, x, y] = key.split(':'); warm.push(add(+z, +x, +y, false).key);
    }
  }
  manager.desiredTileKeys = new Set([...selected, ...warm, ...hidden]); manager.updatePatchVisibility();
  manager.desiredTileKeys = new Set(selected); manager.updatePatchVisibility();
  assert.equal(manager.patches.size, 512); assert(hidden.every(key => !manager.patches.get(key).mesh.visible));
  assert(warm.every(key => manager.patches.get(key).mesh.visible));
  let scoreCalls = 0, routeQueries = 0;
  manager.routeGeometry = { getTelemetryAtProgress() { routeQueries++; return { currentPoint: center }; } };
  const score = manager.calculatePatchImportanceScore.bind(manager);
  manager.calculatePatchImportanceScore = (...args) => { scoreCalls++; return score(...args); };
  const arriving = Array.from({ length: 16 }, (_, i) => ({ x: tile.x + 80 + i % 4, y: tile.y - 80 + Math.floor(i / 4) }));
  for (const t of arriving) manager.desiredTileKeys.add(getTileKey('satellite', 19, t.x, t.y));
  try {
    for (const t of arriving) manager.createAndMountPatch(getTileKey('satellite', 19, t.x, t.y), 19, t.x, t.y, { width: 256, height: 256 }, 0, now);
    const result = { residentBudget: 512, residents: manager.patches.size, arrivingFineTiles: arriving.length,
      retainedPriorFineTiles: warm.filter(key => manager.patches.has(key)).length,
      priorFineRevisitMisses: warm.filter(key => !manager.patches.has(key)).length,
      obsoleteHiddenFallbacksRemoved: hidden.filter(key => !manager.patches.has(key)).length,
      allCurrentSelectedTilesResident: [...manager.desiredTileKeys].every(key => manager.patches.has(key)), scoreCalls, routeQueries };
    assert.equal(result.residents, 512); assert(result.allCurrentSelectedTilesResident); return result;
  } finally { manager.dispose(); }
}
const before = compare(true), after = compare(false);
assert.equal(before.priorFineRevisitMisses, 16); assert.equal(after.priorFineRevisitMisses, 0);
assert.equal(after.obsoleteHiddenFallbacksRemoved, 16); assert.equal(after.routeQueries, 16);
assert(after.scoreCalls < before.scoreCalls);
const result = { baseline, condition: 'Synthetic bounded-residency scenario using the actual manager and prior eviction implementation. Same 512-slot limit and selected tiles. No network, native MR, rendering or elapsed-time claim.', before, after };
const out = path.resolve('.review-cache/eviction-comparison'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
