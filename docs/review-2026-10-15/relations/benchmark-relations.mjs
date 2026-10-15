import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${fs.readFileSync(new URL(url), 'utf8')};`, shortCircuit: true };
  return nextLoad(url, context);
} });
const baseline = '4b26935db4fc44e3a63348732c4730205fc3806f';
let old = stripTypeScriptTypes(execFileSync('git', ['show', `${baseline}:src/terrain/ImageryLODManager.ts`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }), { mode: 'transform' });
old = old.replace(/from '([^']+)'/g, (_, specifier) => `from '${pathToFileURL(path.resolve(specifier === 'three' ? 'node_modules/three/build/three.module.js' : path.resolve('src/terrain', specifier))).href}'`);
const previousModule = await import('data:text/javascript;base64,' + Buffer.from(old).toString('base64'));
const { ImageryLODManager: Previous } = previousModule;
const { ImageryLODManager: Current } = await import(pathToFileURL(path.resolve('src/terrain/ImageryLODManager.ts')));
const { computeBroadDetailTiles } = await import(pathToFileURL(path.resolve('src/terrain/BroadDetailSelection.ts')));
const { TilePriority } = await import(pathToFileURL(path.resolve('src/terrain/TileImageCache.ts')));
const out = path.resolve('.review-cache/relations'); fs.mkdirSync(out, { recursive: true });
const browserBaseline = `(()=>{const TilePriority=${JSON.stringify(TilePriority)};${['parseTileKey','getParentTileKey','getChildTileKeys','getTileKey'].map(name => `const ${name}=${previousModule[name].toString()};`).join('\n')}
window.visibilityBaseline=({${Previous.prototype.updatePatchVisibility.toString()}}).updatePatchVisibility;
window.sortBaseline=({${Previous.prototype.sortRequestQueue.toString()}}).sortRequestQueue;})();`;
fs.writeFileSync(path.join(out, 'baseline-browser.js'), browserBaseline);
const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 6000, depthMeters: 9000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
const state = manager => ({ visible: [...manager.patches].map(([key, p]) => [key, p.mesh.visible]),
  groups: [...manager.refinementGroups].map(([key, g]) => [key, g.state, [...g.readyChildren], g.requestStartTime !== undefined]),
  queue: manager.requestQueue.map(q => [q.key, q.priority]) });
const stats = samples => { samples.sort((a, b) => a - b); return { medianMs: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.floor(samples.length * .95)], samples: samples.length }; };
const results = [];
for (const budget of [512, 768]) {
  const points = [-.01, 0, .01].flatMap(lat => [-.015, 0, .015].map(lon => ({ lat: bounds.centerLat + lat, lon: bounds.centerLon + lon })));
  const candidates = computeBroadDetailTiles({ lat: bounds.centerLat, lon: bounds.centerLon }, 19, budget - 32, bounds, points);
  const keys = candidates.map(c => `satellite:${c.zoom}:${c.x}:${c.y}`);
  const before = new Previous({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0 });
  const after = new Current({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0 });
  const configure = (manager, loaded, desired, fading) => {
    manager.patches.clear(); manager.desiredTileKeys = new Set(desired);
    keys.slice(0, loaded).forEach((key, i) => manager.patches.set(key, { mesh: { visible: false }, isFading: fading && i % 4 === 0, dispose() {} }));
    manager.requestQueue = candidates.slice(loaded).map(c => ({ ...c, key: `satellite:${c.zoom}:${c.x}:${c.y}`, style: 'satellite' }));
    manager.updatePatchVisibility(); manager.sortRequestQueue(19);
  };
  try {
    let comparedStates = 0;
    for (const fraction of [.25, .5, .75, 1]) for (const fading of [true, false]) for (const selected of [keys, keys.slice(0, 40), []]) {
      const loaded = Math.floor(keys.length * fraction);
      configure(before, loaded, selected, fading); configure(after, loaded, selected, fading);
      assert.deepEqual(state(after), state(before)); comparedStates++;
    }
    configure(before, Math.floor(keys.length / 2), keys, false); configure(after, Math.floor(keys.length / 2), keys, false);
    const measure = manager => { const start = performance.now(); for (let i = 0; i < 10; i++) { manager.updatePatchVisibility(); manager.sortRequestQueue(19); } return (performance.now() - start) / 10; };
    const previous = [], current = [];
    for (let sample = 0; sample < 140; sample++) {
      let a, b;
      if (sample % 2) { b = measure(after); a = measure(before); } else { a = measure(before); b = measure(after); }
      if (sample >= 40) { previous.push(a); current.push(b); }
    }
    assert.deepEqual(state(after), state(before));
    results.push({ budget, selectedTiles: keys.length, loadedTiles: before.patches.size, queuedTiles: before.requestQueue.length,
      comparedStates, identicalVisibilityGroupsAndPriorities: true, previous: stats(previous), current: stats(current), cachedKeys: after.tileRelations.size });
  } finally { before.dispose(); after.dispose(); }
}
const result = { baseline, runtime: process.version, condition: 'Isolated production CPU visibility + queue sort, synthetic broad High tile selection; inert meshes, no rendering/network. Alternating order, 40 warmup batches, 100 measured batches of 10 operations. State comparisons cover partial/completed loading, fading, changing selection and warm tiles.', results };
fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
