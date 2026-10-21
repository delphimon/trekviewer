import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const out = process.env.TREK_CHUNK_PROJECTION_OUT ?? '.review-cache/terrain-plans/projection-benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const reference = path.resolve(path.dirname(out), 'chunk-reference.ts'), original = path.resolve('src/terrain/LocalTerrainChunk.ts');
fs.writeFileSync(reference, execFileSync('git', ['show', 'fa75d0b:src/terrain/LocalTerrainChunk.ts'], { encoding: 'utf8' })
  .replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, relative) =>
    `from '${path.relative(path.dirname(reference), path.resolve(path.dirname(original), relative)).replaceAll('\\', '/')}'`));
const { LocalTerrainChunk: Before } = await import(pathToFileURL(reference).href);
const { LocalTerrainChunk: After } = await import('../src/terrain/LocalTerrainChunk.ts');
const providerReference = path.resolve(path.dirname(out), 'texture-reference.ts'), providerSource = path.resolve('src/terrain/TextureProvider.ts');
fs.writeFileSync(providerReference, execFileSync('git', ['show', 'fa75d0b:src/terrain/TextureProvider.ts'], { encoding: 'utf8' })
  .replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, relative) =>
    `from '${path.relative(path.dirname(providerReference), path.resolve(path.dirname(providerSource), relative)).replaceAll('\\', '/')}'`));
const { TextureProvider: PreviousProvider } = await import(pathToFileURL(providerReference).href);
const { TextureProvider } = await import('../src/terrain/TextureProvider.ts');
const currentUV = TextureProvider.getUVForGeo;
const create = (Chunk, opts) => {
  TextureProvider.getUVForGeo = Chunk === Before ? PreviousProvider.getUVForGeo : currentUV;
  try { return new Chunk(opts); }
  finally { TextureProvider.getUVForGeo = currentUV; }
};
const { latLonToTile, localMetersToGeo } = await import('../src/gpx/Coordinates.ts');
const lat = 46.8, lon = -123.8, tile = latLonToTile(lat, lon, 15);
const x = lon * Math.PI * 6378137 / 180, y = Math.asinh(Math.tan(lat * Math.PI / 180)) * 6378137;
const options = { localGrid: { width: 1024, height: 1024, zoom: 0, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0,
  numTilesX: 1, numTilesY: 1, data: Float32Array.from({ length: 1024 ** 2 }, (_, i) => 1500 + 400 * Math.sin(i % 1024 / 80) * Math.cos(Math.floor(i / 1024) / 130)),
  tileValidity: new Uint8Array([1]), minElevation: 1100, maxElevation: 1900, isRealDEM: true,
  sampleSpacingMeters: 1, rasterBounds: { west: x - 700, east: x + 700, south: y - 700, north: y + 700 } },
  tileGrid: { zoom: 15, tileXMin: tile.x - 1, tileXMax: tile.x + 1, tileYMin: tile.y - 1, tileYMax: tile.y + 1, numTilesX: 3, numTilesY: 3 },
  centerLat: lat, centerLon: lon, terrainBaseElevation: 1000, radiusMeters: 377, segments: 152,
  initialExaggeration: 1.6, baseElevationSampler: (x, z) => 500 + x / 100 + z / 100 };
const previous = create(Before, options), current = create(After, options);
assert.deepEqual(current.getBuildData(), previous.getBuildData()); previous.dispose(); current.dispose();
for (let i = 0; i < 20; i++) { create(Before, options).dispose(); create(After, options).dispose(); }
const passes = [];
for (let pass = 0; pass < 5; pass++) for (const [name, Chunk] of (pass % 2
  ? [['reuse-coordinates', After], ['previous', Before]] : [['previous', Before], ['reuse-coordinates', After]])) {
  const start = performance.now();
  for (let i = 0; i < 60; i++) create(Chunk, options).dispose();
  passes.push({ name, chunks: 60, elapsedMs: performance.now() - start });
}
const median = name => passes.filter(row => row.name === name).map(row => row.elapsedMs).sort((a, b) => a - b)[2];
let seed = 7731, checksum = 0, matchedUVs = 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const rows = Array.from({ length: 153 ** 2 }, (_, i) => localMetersToGeo(i % 153 * 5, Math.floor(i / 153) * 5, lat, lon));
const scattered = rows.map(() => localMetersToGeo(random() * 2000, random() * 2000, lat, lon));
for (const point of [...rows, ...scattered]) {
  assert.deepEqual(TextureProvider.getUVForGeo(point.lat, point.lon, options.tileGrid), PreviousProvider.getUVForGeo(point.lat, point.lon, options.tileGrid)); matchedUVs++;
}
const uvPasses = [];
for (let pass = 0; pass < 3; pass++) for (const [name, fn] of (pass % 2
  ? [['reuse-coordinates', currentUV], ['previous', PreviousProvider.getUVForGeo]] : [['previous', PreviousProvider.getUVForGeo], ['reuse-coordinates', currentUV]])) {
  for (const [pattern, points] of [['rows', rows], ['scattered', scattered]]) {
    const start = performance.now();
    for (let repeat = 0; repeat < 20; repeat++) for (const p of points) {
      const uv = fn.call(TextureProvider, p.lat, p.lon, options.tileGrid); checksum += uv.u + uv.v;
    }
    uvPasses.push({ name, pattern, samples: points.length * 20, elapsedMs: performance.now() - start });
  }
}
const result = { condition: 'Isolated Node desktop complete 23,409-vertex DEM chunk construction with imagery UVs. Exact full build-data parity against fa75d0b. Five alternating passes after warmup; excludes transport, publication, GPU and native frames.',
  reference: 'fa75d0b', node: process.version, parity: true, passes, matchedUVs, uvPasses, checksum,
  medianMs: { previous: median('previous'), reuseCoordinates: median('reuse-coordinates') } };
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
