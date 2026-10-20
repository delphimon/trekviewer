import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { selectTerrainFocus } from '../src/terrain/TerrainTileLayout.ts';

// Previous production algorithm, retained as the benchmark/fidelity reference.
function previous(points, focus) {
  const candidates = [...points], selected = [];
  while (candidates.length && selected.length < 25) {
    let farthest = 0, distance = -1;
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      let nearest = Math.hypot(p.x - focus.x, p.z - focus.z);
      for (const anchor of selected) nearest = Math.min(nearest, Math.hypot(p.x - anchor.x, p.z - anchor.z));
      if (nearest > distance) { distance = nearest; farthest = i; }
    }
    if (distance < 60) break;
    selected.push(candidates.splice(farthest, 1)[0]);
  }
  return selected;
}
let seed = 48391;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const fixtures = Array.from({ length: 1000 }, () => ({
  focus: { x: random() * 4000 - 2000, z: random() * 4000 - 2000 },
  points: Array.from({ length: 64 }, (_, id) => ({ id, x: random() * 20000 - 10000, z: random() * 20000 - 10000 })),
}));
for (const { points, focus } of fixtures) assert.deepEqual(selectTerrainFocus(points, focus), previous(points, focus));
let checksum = 0;
const time = (name, select) => {
  const started = performance.now();
  for (let i = 0; i < 2000; i++) { const fixture = fixtures[i % fixtures.length]; checksum += select(fixture.points, fixture.focus).length; }
  return { name, iterations: 2000, elapsedMs: performance.now() - started };
};
for (let i = 0; i < 100; i++) { const f = fixtures[i]; previous(f.points, f.focus); selectTerrainFocus(f.points, f.focus); }
const passes = [];
for (let i = 0; i < 3; i++) { passes.push(time('previous', previous)); passes.push(time('cached-nearest-distance', selectTerrainFocus)); }
const result = { condition: 'Node desktop isolated anchor-selection benchmark, 64 candidates, up to 25 anchors, identical 60 m spacing/count policy. Exact ordered point identity agrees across 1000 seeded geographic-scale point clouds. This is not full-frame or native timing.', node: process.version, matchedFixtures: fixtures.length, passes, checksum };
const out = process.env.TREK_FOCUS_BENCHMARK_OUT ?? '.review-cache/terrain-priority/focus-benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
