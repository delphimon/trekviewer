import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const THREE = await import(pathToFileURL(path.resolve('node_modules/three/build/three.module.js')));
const baseline = '24acdf8310873db1930c5ecfc2eb934b899fc2df';
let old = stripTypeScriptTypes(execFileSync('git', ['show', `${baseline}:src/terrain/SurfacePromotion.ts`], { encoding: 'utf8' }), { mode: 'transform' });
old = old.replace(/from '([^']+)'/g, (_, specifier) => `from '${pathToFileURL(path.resolve(specifier === 'three' ? 'node_modules/three/build/three.module.js' : path.resolve('src/terrain', specifier))).href}'`);
const { buildPromotedSurfacePatches: previous } = await import('data:text/javascript;base64,' + Buffer.from(old).toString('base64'));
const { buildPromotedSurfacePatches: current, snapshotSurfaceMesh } = await import(pathToFileURL(path.resolve('src/terrain/SurfacePromotion.ts')));
const { latLonToTile } = await import(pathToFileURL(path.resolve('src/gpx/Coordinates.ts')));
const out = path.resolve('.review-cache/projection'); fs.mkdirSync(out, { recursive: true });
const material = new THREE.MeshBasicMaterial();
const mesh = (size, segments, offsetX = 0, offsetZ = 0) => {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments); geometry.rotateX(-Math.PI / 2);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, Math.sin(p.getX(i) / 47) * 135 + Math.cos(p.getZ(i) / 53) * 89);
  geometry.computeVertexNormals();
  const result = new THREE.Mesh(geometry, material); result.position.set(offsetX, 0, offsetZ); return result;
};
const base = mesh(2000, 32), local = mesh(1000, 200);
base.geometry.userData.surfaceHoles = [{ minX: -500, maxX: 500, minZ: -500, maxZ: 500 }];
const stats = values => { values.sort((a, b) => a - b); return { medianMs: values[Math.floor(values.length * .5)], p95Ms: values[Math.floor(values.length * .95)], samples: values.length }; };
const results = [];
try {
  for (const [zoom, side] of [[16, 2], [18, 3], [19, 4]]) {
    const centerLat = 46.85, centerLon = -121.75, tile = latLonToTile(centerLat, centerLon, zoom);
    const tiles = Array.from({ length: side * side }, (_, i) => ({ key: `${i}`, zoom, x: tile.x + i % side - Math.floor(side / 2), y: tile.y + Math.floor(i / side) - Math.floor(side / 2) }));
    const input = { sources: [snapshotSurfaceMesh(base), snapshotSurfaceMesh(local)], centerLat, centerLon, tiles };
    const before = previous(input), after = current(input);
    assert.deepEqual(after, before);
    const vertices = after.reduce((n, p) => n + p.positions.length / 3, 0), triangles = after.reduce((n, p) => n + p.indices.length / 3, 0);
    const oldSamples = [], newSamples = [];
    const measure = build => { const start = performance.now(); build(input); return performance.now() - start; };
    for (let i = 0; i < 160; i++) {
      let a, b; if (i % 2) { b = measure(current); a = measure(previous); } else { a = measure(previous); b = measure(current); }
      if (i >= 40) { oldSamples.push(a); newSamples.push(b); }
    }
    results.push({ zoom, patches: tiles.length, vertices, triangles, exactPositionsNormalsUVsAndIndices: true, previous: stats(oldSamples), current: stats(newSamples) });
  }
} finally { base.geometry.dispose(); local.geometry.dispose(); material.dispose(); }
const result = { baseline, runtime: process.version, condition: 'Isolated worker surface-patch CPU build; synthetic 5 m detail and 62.5 m base. Actual production before/after builders, alternating order, 40 warmups, 120 measured batches. No network, worker messaging, GPU or app FPS.', results };
fs.writeFileSync(path.join(out, 'benchmark.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
