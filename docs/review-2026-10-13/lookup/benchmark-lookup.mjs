import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const THREE = await import(pathToFileURL(path.resolve('node_modules/three/build/three.module.js')));
const { SurfaceVertexIndex: Previous } = await import(new URL('./SurfaceVertexIndex-before.ts', import.meta.url));
const { SurfaceVertexIndex: Current } = await import(pathToFileURL(path.resolve('src/visualization/SurfaceVertexIndex.ts')));
const { GPXParser } = await import(pathToFileURL(path.resolve('src/gpx/GPXParser.ts')));
const { TrailMesh } = await import(pathToFileURL(path.resolve('src/visualization/TrailMesh.ts')));
const out = path.resolve('.review-cache/lookup'); fs.mkdirSync(out, { recursive: true });
const fixtures = [];
for (const file of ['MountRainierViaEmmons.gpx', 'GlacierPeakTraverse2026.gpx']) {
  const track = GPXParser.parse(fs.readFileSync(path.join('public/routes', file), 'utf8'));
  const trail = TrailMesh.create(track, () => 0);
  fixtures.push({ name: file, geometry: trail.trailMesh.geometry, dispose: () => trail.dispose() });
}
const positions = new Float32Array(100002 * 3);
for (let i = 0; i < positions.length / 3; i++) {
  const station = Math.floor(i / 2), leg = Math.min(3, Math.floor(station / 12500));
  const along = station - leg * 12500;
  positions[i * 3] = (leg % 2 ? 12500 - along : along) * 8 - 50000;
  positions[i * 3 + 2] = leg * 500 + (i % 2 ? 4 : -4);
}
const synthetic = new THREE.BufferGeometry(); synthetic.setAttribute('position', new THREE.BufferAttribute(positions, 3));
fixtures.push({ name: '400km synthetic ribbon, 100km extent', geometry: synthetic, dispose: () => synthetic.dispose() });
const stats = samples => { samples.sort((a, b) => a - b); return { medianMs: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.floor(samples.length * .95)], samples: samples.length }; };
const results = [];
for (const fixture of fixtures) {
  const position = fixture.geometry.attributes.position;
  const previous = new Previous(fixture.geometry, 500, false), current = new Current(fixture.geometry, 500, false);
  const constructionOld = [], constructionNew = [];
  for (let i = 0; i < 60; i++) {
    let start = performance.now(); new Previous(fixture.geometry, 500, false); const oldMs = performance.now() - start;
    start = performance.now(); new Current(fixture.geometry, 500, false); const newMs = performance.now() - start;
    if (i >= 20) { constructionOld.push(oldMs); constructionNew.push(newMs); }
  }
  for (const radius of [150, 650, Infinity]) {
    const queries = Array.from({ length: 24 }, (_, i) => {
      const vertex = Math.floor(i * (position.count - 1) / 23), x = position.getX(vertex), z = position.getZ(vertex);
      return { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
    });
    for (const query of queries) assert.deepEqual(current.verticesIn(query), previous.verticesIn(query));
    const before = [], after = [];
    let selected = 0;
    for (const query of queries) selected += current.verticesIn(query).length;
    for (let i = 0; i < 240; i++) {
      let start = performance.now(); for (const query of queries) previous.verticesIn(query); const oldMs = (performance.now() - start) / queries.length;
      start = performance.now(); for (const query of queries) current.verticesIn(query); const newMs = (performance.now() - start) / queries.length;
      if (i >= 40) { before.push(oldMs); after.push(newMs); }
    }
    results.push({ fixture: fixture.name, vertices: position.count, footprint: Number.isFinite(radius) ? `${radius * 2}m square` : 'entire ribbon', meanSelected: selected / queries.length, identicalOrderedSelections: true, previous: stats(before), current: stats(after), constructionPrevious: stats(constructionOld), constructionCurrent: stats(constructionNew) });
  }
  fixture.dispose();
}
fs.writeFileSync(path.join(out, 'lookup-benchmark.json'), JSON.stringify({ runtime: process.version, queriesPerSample: 24, warmupSamples: 40, results }, null, 2));
console.log(JSON.stringify(results));
