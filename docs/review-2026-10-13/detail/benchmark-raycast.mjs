import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const THREE = await import(pathToFileURL(path.resolve('node_modules/three/build/three.module.js')));
const { TerrainRaycast: Previous } = await import(new URL('./TerrainRaycast-before.ts', import.meta.url));
const { TerrainRaycast: Current } = await import(pathToFileURL(path.resolve('src/terrain/TerrainRaycast.ts')));
const out = path.resolve('.review-cache/detail'); fs.mkdirSync(out, { recursive: true });
const results = [];
for (const segments of [128, 446]) {
  const geometry = new THREE.PlaneGeometry(400, 400, segments, segments); geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position; pos.setY(0, 1000); pos.setY(pos.count - 1, -1000); pos.needsUpdate = true;
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld(true);
  const rays = Array.from({ length: 24 }, (_, i) => new THREE.Raycaster(new THREE.Vector3(-180 + i * 0.1, 30 + i * 0.1, 180 - i * 0.1), new THREE.Vector3(1, -.8, -1).normalize()));
  const previous = new Previous(), current = new Current();
  for (const ray of rays) {
    const native = ray.intersectObject(mesh)[0], before = previous.closest(ray, [mesh]), after = current.closest(ray, [mesh]);
    assert(native && before && after); assert(before.point.distanceTo(native.point) < 1e-8); assert(after.point.distanceTo(native.point) < 1e-8);
  }
  const original = THREE.Ray.prototype.intersectTriangle;
  let triangles = 0;
  THREE.Ray.prototype.intersectTriangle = function(...args) { triangles++; return original.apply(this, args); };
  previous.closest(rays[0], [mesh]); const previousTriangles = triangles; triangles = 0;
  current.closest(rays[0], [mesh]); const currentTriangles = triangles;
  THREE.Ray.prototype.intersectTriangle = original;
  const oldSamples = [], newSamples = [];
  for (let i = 0; i < 240; i++) {
    let start = performance.now(); for (const ray of rays) previous.closest(ray, [mesh]); const oldMs = (performance.now() - start) / rays.length;
    start = performance.now(); for (const ray of rays) current.closest(ray, [mesh]); const newMs = (performance.now() - start) / rays.length;
    if (i >= 40) { oldSamples.push(oldMs); newSamples.push(newMs); }
  }
  const stats = samples => { samples.sort((a,b) => a-b); return { medianMsPerRay: samples[Math.floor(samples.length * .5)], p95MsPerRay: samples[Math.floor(samples.length * .95)], samples: samples.length, raysPerSample: rays.length }; };
  results.push({ segments, vertices: pos.count, measurement: 'synthetic-grid-cpu-raycast', exactNativeHits: true, previousTriangles, currentTriangles, previous: stats(oldSamples), current: stats(newSamples) });
  geometry.dispose(); mesh.material.dispose();
}
fs.writeFileSync(path.join(out, 'raycast-benchmark.json'), JSON.stringify({ runtime: process.version, fixture: '400m square grid, flat interior, two remote corner height extremes; diagonal near-surface rays', results }, null, 2));
console.log(JSON.stringify(results));
