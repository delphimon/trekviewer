import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { BaseTerrainIndex } from '../src/terrain/BaseTerrainIndex.ts';

const out = process.env.TREK_INDEX_BENCHMARK_OUT ?? '.review-cache/terrain-index/benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const referenceFile = path.resolve(path.dirname(out), 'coverage-reference.ts');
fs.writeFileSync(referenceFile, execFileSync('git', ['show', 'f47ed33:src/terrain/BaseTerrainCoverage.ts']));
const { BaseTerrainCoverage } = await import(pathToFileURL(referenceFile).href);
const grid = { width: 40900, depth: 26900, segmentsX: 434, segmentsZ: 286 };
const geometry = new THREE.PlaneGeometry(grid.width, grid.depth, grid.segmentsX, grid.segmentsZ);
const original = geometry.index.array.slice(), ordered = original.slice(), target = original.slice();
const reference = new BaseTerrainCoverage(grid, original), incremental = new BaseTerrainIndex(grid, original);
const footprint = i => {
  const x = (i * 13 % 51) * 8, z = (i * 17 % 33) * 8;
  return { minX: x * grid.width / grid.segmentsX - grid.width / 2, maxX: (x + 8) * grid.width / grid.segmentsX - grid.width / 2,
    minZ: z * grid.depth / grid.segmentsZ - grid.depth / 2, maxZ: (z + 8) * grid.depth / grid.segmentsZ - grid.depth / 2 };
};
const fixtures = Array.from({ length: 1000 }, (_, step) => Array.from({ length: 34 }, (_, i) => footprint(step + i)));
let visibilityDecisions = 0, orderedBytes = 0, incrementalBytes = 0, incrementalRanges = 0;
for (const holes of fixtures) {
  const count = incremental.update(holes, target), expected = reference.update(holes, ordered);
  assert.equal(count, expected); assert.deepEqual(incremental.hiddenCells, reference.hiddenCells);
  visibilityDecisions += incremental.hiddenCells.length;
  orderedBytes += expected * original.BYTES_PER_ELEMENT;
  incrementalBytes += incremental.dirtyRanges.reduce((n, range) => n + range.count * original.BYTES_PER_ELEMENT, 0);
  incrementalRanges += incremental.dirtyRanges.length;
}
const passes = [];
const run = (name, coverage, array) => {
  const start = performance.now();
  for (const holes of fixtures) coverage.update(holes, array);
  passes.push({ name, updates: fixtures.length, elapsedMs: performance.now() - start });
};
for (let i = 0; i < 3; i++) for (const [name, coverage, array] of i % 2
  ? [['incremental', incremental, target], ['ordered', reference, ordered]]
  : [['ordered', reference, ordered], ['incremental', incremental, target]]) run(name, coverage, array);
const result = { condition: 'Isolated coverage/index update on a 434x286-cell base grid. Sliding set of 34 aligned child footprints, 1,000 changes per pass. Upload bytes are requested index-element ranges before renderer merging, not measured GPU timing. Excludes geometry construction, rendering, frames and native XR.',
  reference: 'f47ed33', node: process.version, visibilityDecisions, orderedBytes, incrementalBytes, incrementalRanges,
  extraIndexStateBytes: incremental.cellSlots.byteLength + incremental.slotCells.byteLength + incremental.dirtyBlocks.byteLength + incremental.previousHidden.byteLength,
  passes };
geometry.dispose(); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
