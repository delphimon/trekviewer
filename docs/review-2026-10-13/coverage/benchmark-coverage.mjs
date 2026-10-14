import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const THREE = await import(pathToFileURL(path.resolve('node_modules/three/build/three.module.js')));
const { BaseTerrainCoverage } = await import(pathToFileURL(path.resolve('src/terrain/BaseTerrainCoverage.ts')));
const out = path.resolve('.review-cache/coverage'); fs.mkdirSync(out, { recursive: true });
const { setup } = JSON.parse(fs.readFileSync(path.join(out, 'browser.json'), 'utf8'));
const grids = [setup.grid, { width: 26001.71, depth: 27379.43, segmentsX: 439, segmentsZ: 451 }];
const results = [];
for (const grid of grids) {
  const geometry = new THREE.PlaneGeometry(grid.width, grid.depth, grid.segmentsX, grid.segmentsZ);
  const original = geometry.index.array.slice(), oldTarget = original.slice(), target = original.slice();
  const coverage = new BaseTerrainCoverage(grid, original), holes = [];
  const sizeX = grid.width / grid.segmentsX, sizeZ = grid.depth / grid.segmentsZ;
  for (let z = 0; z < 4; z++) for (let x = 0; x < 6; x++) {
    const minX = (Math.floor(grid.segmentsX / 3) + x * 8) * sizeX - grid.width / 2;
    const minZ = (Math.floor(grid.segmentsZ / 3) + z * 8) * sizeZ - grid.depth / 2;
    holes.push({ minX, maxX: minX + 8 * sizeX, minZ, maxZ: minZ + 8 * sizeZ });
  }
  function previous() {
    let count = 0;
    for (let z = 0; z < grid.segmentsZ; z++) for (let x = 0; x < grid.segmentsX; x++) {
      const cx = (x + 0.5) * grid.width / grid.segmentsX - grid.width / 2;
      const cz = (z + 0.5) * grid.depth / grid.segmentsZ - grid.depth / 2;
      if (holes.some(b => cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ)) continue;
      const offset = (z * grid.segmentsX + x) * 6;
      for (let i = 0; i < 6; i++) oldTarget[count++] = original[offset + i];
    }
    return count;
  }
  const expected = previous(), actual = coverage.update(holes, target);
  assert.equal(actual, expected); assert.deepEqual(target.subarray(0, actual), oldTarget.subarray(0, expected));
  const oldSamples = [], newSamples = [];
  for (let i = 0; i < 240; i++) {
    let start = performance.now(); previous(); const oldMs = performance.now() - start;
    start = performance.now(); coverage.update(holes, target); const newMs = performance.now() - start;
    if (i >= 40) { oldSamples.push(oldMs); newSamples.push(newMs); }
  }
  const stats = samples => { samples.sort((a,b) => a-b); return { medianMs: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.floor(samples.length * .95)], samples: samples.length }; };
  results.push({ grid, holes: holes.length, cells: grid.segmentsX * grid.segmentsZ, maskBytes: grid.segmentsX * grid.segmentsZ, indexBytes: original.byteLength, drawnIndices: actual, exactMatch: true, previous: stats(oldSamples), current: stats(newSamples) });
  geometry.dispose();
}
fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify({ runtime: process.version, measurement: 'isolated-cpu-coverage-update', results }, null, 2));
console.log(JSON.stringify(results));
