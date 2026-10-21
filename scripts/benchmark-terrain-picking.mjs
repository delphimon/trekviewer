import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { TerrainRaycast } from '../src/terrain/TerrainRaycast.ts';
import { BaseTerrainCoverage } from '../src/terrain/BaseTerrainCoverage.ts';
import { publishTerrainCellMask } from '../src/terrain/TerrainCellMask.ts';

const out = process.env.TREK_PICKING_BENCHMARK_OUT ?? '.review-cache/terrain-picking/benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const reference = path.resolve(path.dirname(out), 'picker-reference.ts');
fs.writeFileSync(reference, execFileSync('git', ['show', 'aa7c9ec:src/terrain/TerrainRaycast.ts']));
const { TerrainRaycast: Previous } = await import(pathToFileURL(reference).href);
const grid = { width: 40900, depth: 26900, segmentsX: 434, segmentsZ: 286 };
const geometry = new THREE.PlaneGeometry(grid.width, grid.depth, grid.segmentsX, grid.segmentsZ);
const index = geometry.index, original = index.array.slice(), coverage = new BaseTerrainCoverage(grid, original);
const oldPickers = [new Previous(), new Previous()], currentPickers = [new TerrainRaycast(), new TerrainRaycast()];
const fixtures = Array.from({ length: 30 }, (_, step) => Array.from({ length: 34 }, (_, i) => {
  const x = ((i * 37 + step) % 50 - 25) * 750, z = ((i * 23 + step) % 34 - 17) * 750;
  return { minX: x, maxX: x + 750, minZ: z, maxZ: z + 750 };
}));
fixtures.push([], [{ minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }]);
const publish = holes => {
  geometry.setDrawRange(0, coverage.update(holes, index.array)); index.needsUpdate = true;
  return publishTerrainCellMask(geometry, grid.segmentsX, grid.segmentsZ, coverage.hiddenCells, true);
};
let matchedCells = 0;
for (const holes of fixtures) {
  publish(holes);
  const before = oldPickers[0].getCellMask(geometry, grid.segmentsX, grid.segmentsZ);
  const after = currentPickers[0].getCellMask(geometry, grid.segmentsX, grid.segmentsZ);
  for (let cell = 0; cell < grid.segmentsX * grid.segmentsZ; cell++) {
    assert.equal(after ? (after.hidden ? !after.cells[cell] : !!after.cells[cell]) : true, before ? !!before[cell] : true);
    matchedCells++;
  }
}
const iterations = 300, passes = [];
const run = (name, pickers) => {
  let elapsedMs = 0;
  for (let i = 0; i < iterations; i++) {
    publish(fixtures[i % 30]);
    const start = performance.now();
    for (const picker of pickers) picker.getCellMask(geometry, grid.segmentsX, grid.segmentsZ);
    elapsedMs += performance.now() - start;
  }
  return { name, revisions: iterations, pickers: pickers.length, elapsedMs };
};
for (let i = 0; i < 3; i++) for (const [name, pickers] of (i % 2
  ? [['borrow-coverage', currentPickers], ['previous', oldPickers]] : [['previous', oldPickers], ['borrow-coverage', currentPickers]])) passes.push(run(name, pickers));
geometry.dispose();
const result = { condition: 'Isolated desktop mask acquisition after coverage/index publication on a 434x286-cell base grid, two independent pickers. Excludes coverage generation, triangle intersection, frames, GPU and native headset timing.',
  reference: 'aa7c9ec', node: process.version, matchedCells, borrowedMaskBytes: coverage.hiddenCells.byteLength,
  previousMaskBytesPerRevision: coverage.hiddenCells.byteLength * 2, extraMaskBytesPerRevision: 0, passes };
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
