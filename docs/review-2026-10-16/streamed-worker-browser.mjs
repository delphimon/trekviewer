// Exercise the production worker in Edge. Compare SHA-256 digests against the
// synchronous clipping implementation; browser timings are not Quest FPS.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as THREE from 'three';
import { buildPromotedSurfacePatches, snapshotSurfaceMesh } from '../../src/terrain/SurfacePromotion.ts';
import { latLonToTile } from '../../src/gpx/Coordinates.ts';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_WORKER_OUT ?? '.review-cache/streamed-worker-browser');
fs.mkdirSync(out, { recursive: true });
const workerAsset = fs.readdirSync('dist/assets').find(name => /^TerrainWorker-.*\.js$/.test(name));
assert(workerAsset);
const centerLat = 46.85, centerLon = -121.75, group = new THREE.Group();
function mesh(width, segments, name) {
  const geo = new THREE.PlaneGeometry(width, width, segments, segments); geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, 500 + Math.sin(p.getX(i) / 60) * 30 + Math.cos(p.getZ(i) / 80) * 50);
  geo.computeVertexNormals(); const m = new THREE.Mesh(geo); m.name = name; group.add(m); return m;
}
const base = mesh(8000, 256, 'BaseTerrainMesh'), local = mesh(1600, 400, 'LocalHighResTerrainMesh');
base.geometry.userData.surfaceHoles = [{ minX: -800, maxX: 800, minZ: -800, maxZ: 800 }];
const snapshots = [snapshotSurfaceMesh(base), snapshotSurfaceMesh(local)];
const sources = snapshots.map(s => ({ ...s, positions: [...s.positions], normals: [...s.normals] }));
const center = latLonToTile(centerLat, centerLon, 17);
const tiles = Array.from({ length: 48 }, (_, i) => ({ key: `tile-${i}`, zoom: 17, x: center.x + i % 6 - 3, y: center.y + Math.floor(i / 6) - 4 }));
const input = { sources: snapshots, centerLat, centerLon, tiles };
const expected = buildPromotedSurfacePatches(input).map(p => ({ key: p.key,
  digests: ['positions', 'normals', 'uvs', 'indices'].map(key => createHash('sha256').update(new Uint8Array(p[key].buffer, p[key].byteOffset, p[key].byteLength)).digest('hex')),
  boundsMin: p.boundsMin, boundsMax: p.boundsMax, sphereCenter: p.sphereCenter, sphereRadius: p.sphereRadius }));
for (const m of [base, local]) { m.geometry.dispose(); m.material.dispose(); }
let server, browser, deadline;
const errors = [];
try {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4196', '--strictPort'], { stdio: 'pipe', windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Preview startup timed out')), 15000);
    server.stdout.on('data', data => { if (data.toString().includes('4196')) { clearTimeout(timer); resolve(); } });
    server.on('error', reject);
  });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/__worker_check', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Terrain worker check</title>' }));
  await page.goto('https://127.0.0.1:4196/__worker_check');
  const result = await Promise.race([page.evaluate(async ({ sources, tiles, centerLat, centerLon, workerAsset }) => {
    sources = sources.map(s => ({ ...s, positions: new Float32Array(s.positions), normals: new Float32Array(s.normals) }));
    const worker = new Worker(`/assets/${workerAsset}`, { type: 'module' });
    const prepared = []; let sourceSnapshotsSent = 0;
    const job = (tile, reuseSources) => new Promise((resolve, reject) => {
      worker.onmessage = event => event.data.error ? reject(Error(event.data.error.message)) : resolve(event.data.result[0]);
      worker.onerror = event => reject(Error(event.message));
      if (!reuseSources) sourceSnapshotsSent++;
      worker.postMessage({ kind: 'surface', input: { sources: reuseSources ? [] : sources, centerLat, centerLon, tiles: [tile] }, reuseSources });
    });
    await job(tiles[0], false); // Warm modules before timing repeated preparation.
    let last = performance.now(), gaps = [];
    const interval = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 4);
    const began = performance.now();
    for (const tile of tiles) prepared.push(await job(tile, true));
    const workerWallMs = performance.now() - began;
    clearInterval(interval); worker.terminate();
    const digest = async array => [...new Uint8Array(await crypto.subtle.digest('SHA-256', array))].map(b => b.toString(16).padStart(2, '0')).join('');
    const actual = await Promise.all(prepared.map(async p => ({ key: p.key,
      digests: await Promise.all(['positions', 'normals', 'uvs', 'indices'].map(key => digest(p[key]))),
      boundsMin: p.boundsMin, boundsMax: p.boundsMax, sphereCenter: p.sphereCenter, sphereRadius: p.sphereRadius })));
    return { condition: 'Synthetic Edge fixture, 4m refined cells, 48 Z17 tiles; production worker. No network, rendering or headset FPS measurement.',
      userAgent: navigator.userAgent, workerAsset, jobs: tiles.length, actual, workerWallMs,
      sourceBytes: sources.reduce((n, s) => n + s.positions.byteLength + s.normals.byteLength, 0), sourceSnapshotsSentIncludingWarmup: sourceSnapshotsSent,
      timerCallbacks: gaps.length, maxTimerGapMs: Math.max(0, ...gaps), triangles: prepared.reduce((n, p) => n + p.indices.length / 3, 0),
      sourceArraysIntact: sources.every(s => s.positions.byteLength > 0 && s.normals.byteLength > 0) };
  }, { sources, tiles, centerLat, centerLon, workerAsset }), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Worker verification timed out')), 60000); })]);
  clearTimeout(deadline);
  assert.deepEqual(result.actual, expected); assert(result.sourceArraysIntact); assert(result.timerCallbacks > 2);
  assert.equal(result.sourceSnapshotsSentIncludingWarmup, 1); assert.deepEqual(errors, []);
  const { actual, ...summary } = result;
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...summary, exactGeometryDigestsAndBoundsMatch: true, errors }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} finally { clearTimeout(deadline); await browser?.close(); server?.kill(); }
