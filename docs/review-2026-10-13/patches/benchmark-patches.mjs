import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const THREE = await import(pathToFileURL(path.resolve('node_modules/three/build/three.module.js')));
const { buildSurfacePatchGeometry: previous } = await import(new URL('./SurfacePatchGeometry-before.ts', import.meta.url));
const { buildSurfacePatchGeometry: current } = await import(pathToFileURL(path.resolve('src/terrain/SurfacePatchGeometry.ts')));
const out = path.resolve('.review-cache/patches'); fs.mkdirSync(out, { recursive: true });
const material = new THREE.MeshBasicMaterial();
const makeMesh = (width, depth, sx, sz, x = 0, y = 0, z = 0) => {
  const geometry = new THREE.PlaneGeometry(width, depth, sx, sz); geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, Math.sin(pos.getX(i) / 47) * 135 + Math.cos(pos.getZ(i) / 53) * 89);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); return mesh;
};
const base = makeMesh(1600, 1800, 128, 96), dense = makeMesh(8000, 8000, 446, 446);
const detail = makeMesh(600, 350, 49, 37, 175, -55, -90); detail.name = 'LocalHighResTerrainMesh';
const group = new THREE.Group(); group.add(base, detail);
base.geometry.userData.surfaceHoles = [{ minX: -125, maxX: 475, minZ: -265, maxZ: 85 }];
const uv = (x, z) => ({ u: (x + 12.37) / 2019.53, v: Math.atan(z / 2037.1) });
const fixtures = [
  { name: 'full-128x96-with-refinement', mesh: base, bounds: { minX: -800, maxX: 800, minZ: -900, maxZ: 900 } },
  { name: 'fractional-patch-with-refinement', mesh: base, bounds: { minX: -611.17, maxX: 497.63, minZ: -395.23, maxZ: 651.77 } },
  { name: 'small-patch-on-200k-base', mesh: dense, bounds: { minX: 153.71, maxX: 257.11, minZ: -710.19, maxZ: -505.31 } },
];
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length * .5)], p95Ms: values[Math.floor(values.length * .95)], samples: values.length }; };
const results = [];
try {
  for (const { name, mesh, bounds } of fixtures) {
    const before = previous(mesh, bounds, uv), after = current(mesh, bounds, uv);
    for (const attribute of ['position', 'normal', 'uv']) assert.deepEqual(after.attributes[attribute].array, before.attributes[attribute].array);
    assert.deepEqual(after.index.array, before.index.array); assert.deepEqual(after.boundingBox, before.boundingBox); assert.deepEqual(after.boundingSphere, before.boundingSphere);
    const vertices = after.attributes.position.count, triangles = after.index.count / 3;
    before.dispose(); after.dispose();
    const oldSamples = [], newSamples = [];
    const measure = build => { const start = performance.now(); const geometry = build(mesh, bounds, uv); const elapsed = performance.now() - start; geometry.dispose(); return elapsed; };
    for (let i = 0; i < 150; i++) {
      let oldMs, newMs;
      if (i % 2) { newMs = measure(current); oldMs = measure(previous); } else { oldMs = measure(previous); newMs = measure(current); }
      if (i >= 30) { oldSamples.push(oldMs); newSamples.push(newMs); }
    }
    results.push({ name, vertices, triangles, exactBuffersAndBounds: true, previous: stats(oldSamples), current: stats(newSamples) });
  }
  const result = { runtime: process.version, measurement: 'isolated synthetic CPU surface-patch construction, not app frame or GPU time; alternating order, 30 warmup batches', results };
  fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { for (const mesh of [base, dense, detail]) mesh.geometry.dispose(); material.dispose(); }
