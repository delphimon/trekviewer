import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const THREE = await import(pathToFileURL(path.resolve('node_modules/three/build/three.module.js')));
const { TerrainRaycast: Previous } = await import(new URL('./TerrainRaycast-before.ts', import.meta.url));
const { TerrainRaycast: Current } = await import(pathToFileURL(path.resolve('src/terrain/TerrainRaycast.ts')));
const out = path.resolve('.review-cache/picking'); fs.mkdirSync(out, { recursive: true });
const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const makeSurface = (width, segments, x, y, z) => {
  const geometry = new THREE.PlaneGeometry(width, width, segments, segments);
  geometry.rotateX(-Math.PI / 2); geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.updateMatrixWorld(true);
  return mesh;
};
const base = makeSurface(2000, 446, 0, 0, 0);
const tiles = [];
for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) tiles.push(makeSurface(400, 49, x * 400, 1, z * 400));
const rays = Array.from({ length: 24 }, (_, i) => new THREE.Raycaster(
  new THREE.Vector3(-900 + ((i * 173) % 1800), 300, -900 + ((i * 337) % 1800)),
  new THREE.Vector3(Math.sin(i) * .2, -1, Math.cos(i) * .2).normalize()));
rays.push(new THREE.Raycaster(new THREE.Vector3(2500, 300, 2500), new THREE.Vector3(0, -1, 0)));
rays.push(new THREE.Raycaster(new THREE.Vector3(0, 300, 0), new THREE.Vector3(0, 1, 0)));
const stats = samples => {
  samples.sort((a, b) => a - b);
  return { medianMsPerQuery: samples[Math.floor(samples.length * .5)], p95MsPerQuery: samples[Math.floor(samples.length * .95)], samples: samples.length, queriesPerSample: rays.length };
};
const results = [];
try {
  for (const [fixture, surfaces] of [['base', [base]], ['base-and-25-detail-tiles', [base, ...tiles]]]) {
    const previous = new Previous(), current = new Current();
    let hits = 0, misses = 0;
    for (const ray of rays) {
      const expected = ray.intersectObjects(surfaces, false)[0] ?? null;
      const before = previous.closest(ray, surfaces), after = current.closest(ray, surfaces);
      assert.equal(before === null, expected === null); assert.equal(after === null, expected === null);
      if (expected) {
        hits++;
        for (const hit of [before, after]) {
          assert.equal(hit.mesh, expected.object); assert(hit.point.distanceTo(expected.point) < 1e-8);
          assert(Math.abs(hit.distance - expected.distance) < 1e-8);
        }
        assert.deepEqual(after.point.toArray(), before.point.toArray()); assert.equal(after.distance, before.distance);
      } else misses++;
    }
    const cloneCounts = picker => {
      const counts = { ray: 0, matrix: 0, vector: 0 };
      const methods = [[THREE.Ray.prototype, 'ray'], [THREE.Matrix4.prototype, 'matrix'], [THREE.Vector3.prototype, 'vector']];
      const originals = methods.map(([prototype]) => prototype.clone);
      methods.forEach(([prototype, name], i) => { prototype.clone = function (...args) { counts[name]++; return originals[i].apply(this, args); }; });
      try { for (const ray of rays) picker.closest(ray, surfaces); }
      finally { methods.forEach(([prototype], i) => { prototype.clone = originals[i]; }); }
      return counts;
    };
    const previousClones = cloneCounts(previous), currentClones = cloneCounts(current);
    assert.equal(currentClones.ray, 0); assert.equal(currentClones.matrix, 0);
    const oldSamples = [], newSamples = [];
    const measure = picker => { const start = performance.now(); for (const ray of rays) picker.closest(ray, surfaces); return (performance.now() - start) / rays.length; };
    for (let i = 0; i < 600; i++) {
      let before, after;
      if (i % 2) { after = measure(current); before = measure(previous); }
      else { before = measure(previous); after = measure(current); }
      if (i >= 100) { oldSamples.push(before); newSamples.push(after); }
    }
    results.push({ fixture, surfaces: surfaces.length, vertices: surfaces.reduce((n, mesh) => n + mesh.geometry.attributes.position.count, 0), hits, misses, exactPreviousHits: true, nativeHitTolerance: 1e-8, previousClones, currentClones, previous: stats(oldSamples), current: stats(newSamples) });
  }
  const report = { runtime: process.version, measurement: 'isolated synthetic CPU terrain-picking queries; unchanged grids and ray traversal; not frame time or GPU duration', results };
  fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { for (const mesh of [base, ...tiles]) mesh.geometry.dispose(); material.dispose(); }
