import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run with Node --experimental-transform-types; adapt Vite's bare JSON imports
// without changing production modules or starting a dependency scanner/server.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const out = process.env.TREK_PUBLICATION_BENCHMARK_OUT ?? '.review-cache/terrain-retention/publication-benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const reference = path.resolve(path.dirname(out), 'publication-reference.ts');
const original = path.resolve('src/terrain/LocalTerrainChunk.ts');
const previousSource = execFileSync('git', ['show', '35a7f1a:src/terrain/LocalTerrainChunk.ts'], { encoding: 'utf8' })
  .replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, relative) =>
    `from '${path.relative(path.dirname(reference), path.resolve(path.dirname(original), relative)).replaceAll('\\', '/')}'`);
fs.writeFileSync(reference, previousSource);
const { LocalTerrainChunk } = await import('../src/terrain/LocalTerrainChunk.ts');
const { LocalTerrainChunk: PreviousChunk } = await import(pathToFileURL(reference).href);
const options = { localGrid: { width: 256, height: 256, zoom: 0, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0,
  numTilesX: 1, numTilesY: 1, data: new Float32Array(65536).fill(125), tileValidity: new Uint8Array([1]),
  minElevation: 125, maxElevation: 125, isRealDEM: true },
  centerLat: 46, centerLon: -120, terrainBaseElevation: 100, radiusMeters: 377, segments: 152 };
const source = new LocalTerrainChunk(options), data = source.getBuildData();
const preparedOptions = { ...options, preparedData: data };
const previous = new PreviousChunk(preparedOptions), current = new LocalTerrainChunk(preparedOptions);
for (const attribute of ['position', 'normal', 'uv'])
  assert.deepEqual(current.geometry.attributes[attribute].array, previous.geometry.attributes[attribute].array);
assert.deepEqual(current.geometry.index.array, previous.geometry.index.array);
assert.deepEqual(current.geometry.boundingBox, previous.geometry.boundingBox);
assert.deepEqual(current.geometry.boundingSphere, previous.geometry.boundingSphere);
assert.equal(current.sampleLocalSurfaceY(12, 23), previous.sampleLocalSurfaceY(12, 23));
previous.dispose(); current.dispose();
const iterations = 200, passes = [];
const run = (name, Chunk) => {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) new Chunk(preparedOptions).dispose();
  return { name, iterations, elapsedMs: performance.now() - start };
};
// Warm both paths, then alternate order to expose rather than hide run variation.
for (let i = 0; i < 20; i++) { new PreviousChunk(preparedOptions).dispose(); new LocalTerrainChunk(preparedOptions).dispose(); }
for (let i = 0; i < 3; i++) {
  const pair = i % 2 ? [['adopt-buffers', LocalTerrainChunk], ['previous', PreviousChunk]]
    : [['previous', PreviousChunk], ['adopt-buffers', LocalTerrainChunk]];
  for (const [name, Chunk] of pair) passes.push(run(name, Chunk));
}
const result = { condition: 'Isolated Node desktop prepared-chunk construction/disposal. Identical 23,409-vertex worker result, full arrays/index/bounds/sample parity. Excludes worker construction, transfer, GPU upload and full frames; not native headset timing.',
  reference: '35a7f1a', node: process.version, vertices: source.totalVertices,
  adoptedBufferBytes: data.positions.byteLength + data.normals.byteLength + data.uvs.byteLength + data.indices.byteLength + data.heights.byteLength,
  parity: true, passes };
source.dispose();
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
