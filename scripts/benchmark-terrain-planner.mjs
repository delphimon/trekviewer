import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { planTerrainTiles } from '../src/terrain/TerrainTileLayout.ts';

const out = process.env.TREK_PLANNER_BENCHMARK_OUT ?? '.review-cache/terrain-priority/planner-benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const referencePath = path.resolve(path.dirname(out), 'planner-reference.ts');
fs.writeFileSync(referencePath, execFileSync('git', ['show', '607d97b:src/terrain/TerrainTileLayout.ts']));
const { planTerrainTiles: previous } = await import(pathToFileURL(referencePath).href);
let seed = 48391;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const fixtures = Array.from({ length: 1000 }, (_, i) => {
  const width = 1000 + random() * 50000, depth = 1000 + random() * 50000;
  const spread = 0.2 + random() * 0.8;
  return { parent: { width, depth, segmentsX: Math.ceil(width / 94), segmentsZ: Math.ceil(depth / 94) },
    focusX: (random() - 0.5) * width, focusZ: (random() - 0.5) * depth,
    additionalFocus: Array.from({ length: i % 3 === 0 ? 0 : 25 }, () => ({ x: (random() - 0.5) * width * spread, z: (random() - 0.5) * depth * spread })),
    radiusM: 4000, targetCellM: 5, parentCellsPerTile: 8, maxTiles: 48, maxVertices: 600000 };
});
for (const fixture of fixtures) assert.deepEqual(planTerrainTiles(fixture), previous(fixture));
let checksum = 0;
const run = (name, plan) => {
  const start = performance.now();
  for (let i = 0; i < 1000; i++) checksum += plan(fixtures[i]).vertexCount;
  return { name, iterations: 1000, elapsedMs: performance.now() - start };
};
const passes = [];
for (let i = 0; i < 3; i++) { passes.push(run('previous', previous)); passes.push(run('per-anchor-radius', planTerrainTiles)); }
const result = { condition: 'Isolated Node desktop planner benchmark against committed 607d97b. Exact complete plan equality over 1000 seeded parent/focus layouts, including single and broad 25-anchor views, unchanged radius/spacing/coverage/tile/vertex limits. This is not full-frame or native timing.', node: process.version, matchedFixtures: fixtures.length, passes, checksum };
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
