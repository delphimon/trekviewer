import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${fs.readFileSync(new URL(url), 'utf8')};`, shortCircuit: true };
  return nextLoad(url, context);
} });
const { ImageryLODManager } = await import(pathToFileURL(path.resolve('src/terrain/ImageryLODManager.ts')));
const { PublicImageryProvider } = await import(pathToFileURL(path.resolve('src/terrain/providers/PublicImageryProvider.ts')));
const { TileImageCache } = await import(pathToFileURL(path.resolve('src/terrain/TileImageCache.ts')));
const out = path.resolve('.review-cache/requests'); fs.mkdirSync(out, { recursive: true });
const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 6000, depthMeters: 9000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
const candidates = Array.from({ length: 12 }, (_, group) => Array.from({ length: 16 }, (_, i) => ({
  x: 84000 + group * 4 + i % 4, y: 184000 + Math.floor(i / 4), zoom: 19, dist: 10 + group * 16 + i,
}))).flat();
const flush = async () => { for (let i = 0; i < 1000; i++) await Promise.resolve(); };
async function run(grouped) {
  let time = 0, sourceRequests = 0, maxConcurrentSources = 0, maxConcurrentConsumers = 0, peakSourceBytes = 0;
  const provider = new PublicImageryProvider(), sources = new Map(), cache = new Map(), mounted = [];
  const sourceGroup = provider.getTileRequestGroup.bind(provider);
  // Disabling only the scheduler hint reproduces the previous tile-slot policy;
  // both runs use identical shared-source deduplication and four-source retention.
  if (!grouped) provider.getTileRequestGroup = undefined;
  const original = ImageryLODManager.loadPatchImage;
  ImageryLODManager.loadPatchImage = async (z, x, y) => {
    const key = sourceGroup(z, x, y);
    if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return {}; }
    let source = sources.get(key);
    if (!source) {
      let resolve; const promise = new Promise(r => { resolve = r; });
      source = { key, readyAt: time + 100, resolve, promise }; sources.set(key, source);
      sourceRequests++; maxConcurrentSources = Math.max(maxConcurrentSources, sources.size);
    }
    await source.promise; return {};
  };
  const manager = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0, maxConcurrency: 6 });
  manager.createAndMountPatch = key => mounted.push(key);
  try {
    manager.reconcileDesiredTiles(candidates, provider, 19);
    let steps = 0;
    while (manager.activeRequestCount || manager.requestQueue.length) {
      assert(++steps <= 100, 'scheduler must make progress');
      maxConcurrentConsumers = Math.max(maxConcurrentConsumers, manager.activeRequestCount);
      assert(sources.size, 'unfinished work must have an export to wake the queue');
      time = Math.min(...[...sources.values()].map(s => s.readyAt));
      for (const source of [...sources.values()].filter(s => s.readyAt === time)) {
        sources.delete(source.key); cache.set(source.key, true);
        while (cache.size > TileImageCache.MAX_SHARED_RASTERS) cache.delete(cache.keys().next().value);
        peakSourceBytes = Math.max(peakSourceBytes, cache.size * 1024 * 1024 * 4);
        source.resolve();
      }
      await flush();
    }
    assert.equal(mounted.length, candidates.length); assert.equal(new Set(mounted).size, candidates.length);
    assert(maxConcurrentConsumers <= 6); assert(peakSourceBytes <= 16 * 1024 * 1024);
    return { simulatedRefinementMs: time, sourceRequests, maxConcurrentSources, maxConcurrentConsumers, peakSourceBytes, mountedKeys: mounted.sort() };
  } finally { manager.dispose(); ImageryLODManager.loadPatchImage = original; }
}
const before = await run(false), after = await run(true);
assert.deepEqual(after.mountedKeys, before.mountedKeys);
assert.equal(after.sourceRequests, 12); assert(after.simulatedRefinementMs < before.simulatedRefinementMs);
assert(after.maxConcurrentSources <= TileImageCache.MAX_SHARED_RASTERS);
const result = { runtime: process.version, fixture: 'Production LOD scheduler; 192 selected tiles / twelve shared 1024px exports. Fixed simulated 100 ms source latency, shared deduplication, four-source LRU, no GPU or actual network.',
  unchangedTileKeys: true, before, after };
fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, before: { ...before, mountedKeys: before.mountedKeys.length }, after: { ...after, mountedKeys: after.mountedKeys.length } }));
