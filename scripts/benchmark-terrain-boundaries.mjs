import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { TerrainRaycast } from '../src/terrain/TerrainRaycast.ts';

const out = process.env.TREK_BOUNDARY_BENCHMARK_OUT ?? '.review-cache/terrain-boundaries/benchmark.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
const referenceFile = path.resolve(path.dirname(out), 'picker-reference.ts');
const maskURL = pathToFileURL(path.resolve('src/terrain/TerrainCellMask.ts')).href;
fs.writeFileSync(referenceFile, execFileSync('git', ['show', '5f993f3:src/terrain/TerrainRaycast.ts'], { encoding: 'utf8' })
  .replace("'./TerrainCellMask.ts'", JSON.stringify(maskURL)));
const { TerrainRaycast: Previous } = await import(pathToFileURL(referenceFile).href);
const previous = new Previous(), current = new TerrainRaycast();
let comparisons = 0, previousMismatches = 0;
const sameHit = (hit, native) => (hit === null) === (native === null) && (!hit || hit.point.distanceTo(native.point) < 1e-8);
for (const relief of [false, true]) {
  const geometry = new THREE.PlaneGeometry(8, 8, 260, 260); geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position, index = geometry.index, original = index.array.slice();
  if (relief) for (let i = 0; i < positions.count; i++) positions.setY(i, 0.15 * Math.sin(positions.getX(i)) + 0.08 * Math.cos(positions.getZ(i)));
  positions.needsUpdate = true; geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const points = [[3.2, -2.3], [-4, 0.137], [4, 0.137], [0.173, -4], [0.173, 4], [-4, -4], [4, 4]];
  for (const column of [1, 86, 259]) {
    const x = positions.getX(column), z = positions.getZ(column * 261);
    for (const epsilon of [-1e-10, 0, 1e-10]) points.push([x + epsilon, 0.137], [0.173, z + epsilon], [x + epsilon, z + epsilon]);
  }
  for (const miniature of [false, true]) {
    mesh.position.set(0.3, 0.5, -0.1); mesh.rotation.set(0.1, 0.2, 0.05);
    mesh.scale.set(0.8, 0.7, 1.1).multiplyScalar(miniature ? 0.00002 : 1); mesh.updateMatrixWorld(true);
    for (const holes of [false, true]) {
      let count = 0;
      for (let z = 0; z < 260; z++) for (let x = 0; x < 260; x++) {
        if (holes && (x + z) % 2 === 0) continue;
        const offset = (z * 260 + x) * 6;
        for (let i = 0; i < 6; i++) index.setX(count++, original[offset + i]);
      }
      index.needsUpdate = true; geometry.setDrawRange(0, count);
      for (const [x, z] of points) for (const [dx, dz] of [[0, 0], [0.7, -0.5], [-0.7, 0.5]]) {
        const origin = mesh.localToWorld(new THREE.Vector3(x + dx, 10, z + dz));
        const target = mesh.localToWorld(new THREE.Vector3(x, 0, z));
        const ray = new THREE.Raycaster(origin, target.sub(origin).normalize());
        const native = ray.intersectObject(mesh)[0] ?? null;
        const before = previous.closest(ray, [mesh]), after = current.closest(ray, [mesh]);
        previousMismatches += sameHit(before, native) ? 0 : 1;
        assert.ok(sameHit(after, native), JSON.stringify({ relief, miniature, holes, x, z, dx, dz, native: native?.point, after: after?.point }));
        comparisons++;
      }
    }
  }
  geometry.dispose(); mesh.material.dispose();
}

// Ordinary oblique rays on a large relief grid, away from designed boundaries.
// Both pickers must agree here; the speed comparison excludes known wrong hits.
const geometry = new THREE.PlaneGeometry(40900, 26900, 434, 286); geometry.rotateX(-Math.PI / 2);
const positions = geometry.attributes.position;
for (let i = 0; i < positions.count; i++) positions.setY(i, 1500 + 900 * Math.sin(positions.getX(i) / 7000) * Math.cos(positions.getZ(i) / 5000));
positions.needsUpdate = true; geometry.computeBoundingSphere();
const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
mesh.rotation.set(0.1, 0.2, 0.05); mesh.scale.set(0.00002, 0.000017, 0.000022); mesh.updateMatrixWorld(true);
const rays = Array.from({ length: 128 }, (_, i) => {
  const x = -17000 + (i * 1937.13) % 34000, z = -10000 + (i * 1543.17) % 20000;
  const origin = mesh.localToWorld(new THREE.Vector3(x, 9000, z));
  const target = mesh.localToWorld(new THREE.Vector3(x + 2300, 1200, z - 1700));
  return new THREE.Raycaster(origin, target.sub(origin).normalize());
});
for (const ray of rays) {
  const before = previous.closest(ray, [mesh]), after = current.closest(ray, [mesh]);
  assert.ok(before && after && before.point.distanceTo(after.point) < 1e-8);
}
const countTriangles = picker => {
  const original = THREE.Ray.prototype.intersectTriangle; let count = 0;
  THREE.Ray.prototype.intersectTriangle = function (...args) { count++; return original.apply(this, args); };
  try { for (const ray of rays) picker.closest(ray, [mesh]); } finally { THREE.Ray.prototype.intersectTriangle = original; }
  return count;
};
const previousTriangles = countTriangles(previous), currentTriangles = countTriangles(current);
for (let i = 0; i < 64; i++) for (const picker of [previous, current]) for (const ray of rays) picker.closest(ray, [mesh]);
const passes = [], iterations = 128;
const run = (name, picker) => {
  const start = performance.now(); let hits = 0;
  for (let i = 0; i < iterations; i++) for (const ray of rays) if (picker.closest(ray, [mesh])) hits++;
  assert.equal(hits, iterations * rays.length);
  passes.push({ name, queries: hits, elapsedMs: performance.now() - start });
};
for (let i = 0; i < 3; i++) for (const [name, picker] of i % 2
  ? [['current', current], ['previous', previous]] : [['previous', previous], ['current', current]]) run(name, picker);
geometry.dispose(); mesh.material.dispose();
const result = {
  condition: 'Isolated desktop regular-grid picking. Boundary comparisons include flat/relief, holes, transformed miniature grids and outer edges. Timed oblique rays agree between implementations and exclude masks, publication, frames, workers and GPU.',
  reference: '5f993f3', node: process.version, boundaryComparisons: comparisons, previousMismatches, currentMismatches: 0,
  timedFixtureRays: rays.length, previousTriangles, currentTriangles, passes,
};
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
