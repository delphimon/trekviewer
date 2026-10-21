import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run on Node 24 with --experimental-transform-types. Production uses Vite's JSON loader.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const out = process.env.TREK_PROJECTION_BENCHMARK_OUT ?? '.review-cache/elevation-projection/benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const reference = path.resolve(path.dirname(out), 'elevation-reference.ts'), source = path.resolve('src/terrain/ElevationTiles.ts');
fs.writeFileSync(reference, execFileSync('git', ['show', '83721f9:src/terrain/ElevationTiles.ts'], { encoding: 'utf8' })
  .replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, relative) =>
    `from '${path.relative(path.dirname(reference), path.resolve(path.dirname(source), relative)).replaceAll('\\', '/')}'`));
const { ElevationTileService: Before } = await import(pathToFileURL(reference).href);
const { ElevationTileService: After } = await import('../src/terrain/ElevationTiles.ts');
const { localMetersToGeo, latLonToTile } = await import('../src/gpx/Coordinates.ts');
const { LocalTerrainChunk } = await import('../src/terrain/LocalTerrainChunk.ts');
const lat = 46.8, lon = -123.8, tile = latLonToTile(lat, lon, 15);
const data = Float32Array.from({ length: 1024 ** 2 }, (_, i) => 1500 + 400 * Math.sin(i % 1024 / 80) * Math.cos(Math.floor(i / 1024) / 130));
const x = lon * Math.PI * 6378137 / 180, y = Math.asinh(Math.tan(lat * Math.PI / 180)) * 6378137;
const raster = { width: 1024, height: 1024, zoom: 0, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0,
  numTilesX: 1, numTilesY: 1, data, tileValidity: new Uint8Array([1]), minElevation: 1100, maxElevation: 1900, isRealDEM: true,
  sampleSpacingMeters: 1, rasterBounds: { west: x - 700, east: x + 700, south: y - 700, north: y + 700 } };
const missing = { ...raster, data: data.slice() };
for (let i = 0; i < missing.data.length; i += 37) missing.data[i] = NaN;
for (let i = 0; i < missing.data.length; i += 113) missing.data[i] = Infinity;
const xyz = { ...raster, width: 512, height: 512, zoom: 15, numTilesX: 2, numTilesY: 2,
  tileXMin: tile.x - 1, tileXMax: tile.x, tileYMin: tile.y - 1, tileYMax: tile.y, rasterBounds: undefined,
  data: data.slice(0, 512 ** 2), tileValidity: new Uint8Array([1, 0, 1, 1]) };
const rows = Array.from({ length: 153 ** 2 }, (_, i) => localMetersToGeo((i % 153 / 152 - 0.5) * 754,
  (Math.floor(i / 153) / 152 - 0.5) * 754, lat, lon));
let seed = 10393;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const scattered = rows.map(() => localMetersToGeo((random() - 0.5) * 1800, (random() - 0.5) * 1800, lat, lon));
const extremes = [-Infinity, -90, -85, -0, 0, 85, 90, Infinity, NaN].map(lat => ({ lat, lon: 0 }));
let matchedSamples = 0;
for (const grid of [raster, missing, xyz, { ...raster, tileValidity: new Uint8Array([0]) }])
  for (const point of [...rows, ...scattered, ...extremes]) {
    assert.deepEqual(After.sampleElevation(grid, point.lat, point.lon), Before.sampleElevation(grid, point.lat, point.lon)); matchedSamples++;
  }
const options = { localGrid: missing, centerLat: lat, centerLon: lon, terrainBaseElevation: 1000, radiusMeters: 377,
  segments: 152, initialExaggeration: 1.6, baseElevationSampler: (x, z) => 500 + x / 100 + z / 100 };
const currentSample = After.sampleElevation;
After.sampleElevation = Before.sampleElevation;
const oldChunk = new LocalTerrainChunk(options);
After.sampleElevation = currentSample;
const newChunk = new LocalTerrainChunk(options);
assert.deepEqual(newChunk.getBuildData(), oldChunk.getBuildData()); oldChunk.dispose(); newChunk.dispose();
let checksum = 0;
const runSamples = (name, sample, points) => {
  const start = performance.now();
  for (let pass = 0; pass < 20; pass++) for (const point of points) {
    const result = sample(raster, point.lat, point.lon); if (result.isValid) checksum += result.elevation;
  }
  return { name, samples: points.length * 20, elapsedMs: performance.now() - start };
};
const runChunks = (name, sample) => {
  After.sampleElevation = sample; const start = performance.now();
  try { for (let i = 0; i < 50; i++) new LocalTerrainChunk(options).dispose(); }
  finally { After.sampleElevation = currentSample; }
  return { name, chunks: 50, elapsedMs: performance.now() - start };
};
for (let i = 0; i < 2; i++) { runSamples('warmup', Before.sampleElevation, rows); runSamples('warmup', currentSample, rows); }
const passes = [];
for (let pass = 0; pass < 3; pass++) {
  const pair = pass % 2 ? [['reuse-projection', currentSample], ['previous', Before.sampleElevation]]
    : [['previous', Before.sampleElevation], ['reuse-projection', currentSample]];
  for (const [name, sample] of pair) passes.push({ name, rowSamples: runSamples(name, sample, rows),
    scatteredSamples: runSamples(name, sample, scattered), fullChunk: runChunks(name, sample) });
}
const result = { condition: 'Isolated Node desktop DEM sampling and complete chunk construction, not message transport, main-thread publication, GPU or native frame timing. Alternating passes, unchanged inputs and full build-data parity.',
  node: process.version, reference: '83721f9', matchedSamples, chunkParity: true, passes, checksum };
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
