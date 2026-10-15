import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { PNG } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/lib/utilsBundle.js');
const previousSource = stripTypeScriptTypes(fs.readFileSync(new URL('./TerrainRaycast-before.ts', import.meta.url), 'utf8'), { mode: 'transform' })
  .replace("import * as THREE from 'three';", 'const THREE = window.pickingThree;')
  .replace('export class TerrainRaycast', 'window.PreviousTerrainRaycast = class TerrainRaycast');
const out = path.resolve('.review-cache/picking'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4185', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4185')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
  await page.goto('https://127.0.0.1:4185/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'), null, { timeout: 90000 });
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return s.chunks.size === s.wanted.size && s.chunks.size === 24 && !s.busy && !s.ready; }, null, { timeout: 90000 });
  await page.evaluate(() => {
    document.getElementById('profile-controls')?.remove(); const app = window.__trekViewerApp;
    app.controls.enableDamping = false; app.activeTrek.localTerrainStreamer.update = () => {};
    const point = app.trailResult.routeGeometry.getTelemetryAtProgress(.4).position.clone();
    point.y = app.terrainResult.sampleRenderedSurfaceY(point.x, point.z); app.sceneManager.dioramaRoot.localToWorld(point);
    app.controls.target.copy(point); app.sceneManager.camera.position.copy(point).add(point.clone().set(0, .048, .064));
    app.controls.update(); app.sceneManager.updateCameraClipping(app.controls.getDistance());
  });
  await page.waitForFunction(() => { const d = window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics(); return d.coveragePercent === 100 && d.inFlightRequests === 0 && d.requestQueueLength === 0; }, null, { timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const app = window.__trekViewerApp, picker = app.activeTrek.imageryLOD.terrainRaycast;
    app.sceneManager.renderer.setAnimationLoop(null);
    window.pickingThree = { PlaneGeometry: app.terrainResult.terrainMesh.geometry.constructor, Matrix4: app.sceneManager.camera.matrixWorld.constructor, Vector3: app.sceneManager.camera.position.constructor, Ray: picker.localRay.constructor, FrontSide: 0, BackSide: 1 };
    app.sceneManager.dioramaRoot.updateWorldMatrix(true, true); app.sceneManager.render();
  });
  await page.addScriptTag({ content: previousSource });
  const canvas = page.locator('#canvas-container canvas').first();
  await page.evaluate(() => window.__trekViewerApp.sceneManager.render());
  const before = PNG.sync.read(await canvas.screenshot({ path: path.join(out, 'before.png') }));
  const picking = await page.evaluate(() => {
    const app = window.__trekViewerApp, root = app.sceneManager.dioramaRoot, terrain = app.terrainResult.terrainMesh;
    const surfaces = terrain.parent.children.filter(mesh => mesh.isMesh && mesh.visible && (mesh === terrain || mesh.name === 'LocalHighResTerrainMesh'));
    root.updateWorldMatrix(true, true);
    const previous = new window.PreviousTerrainRaycast(), current = app.activeTrek.imageryLOD.terrainRaycast;
    const V = window.pickingThree.Vector3, R = window.pickingThree.Ray;
    const camera = app.sceneManager.camera, forward = camera.getWorldDirection(new V());
    const right = new V(1, 0, 0).applyQuaternion(camera.quaternion), up = new V(0, 1, 0).applyQuaternion(camera.quaternion);
    const queries = [];
    for (const horizontal of [-.55, 0, .55]) for (const vertical of [-.35, 0, .35]) {
      queries.push({ ray: new R(camera.position.clone(), forward.clone().addScaledVector(right, horizontal).addScaledVector(up, vertical).normalize()), near: 0, far: Infinity });
    }
    for (const progress of [0, .15, .4, .7, 1]) {
      const target = app.trailResult.routeGeometry.getTelemetryAtProgress(progress).position.clone();
      target.y = app.terrainResult.sampleRenderedSurfaceY(target.x, target.z);
      const origin = target.clone().add(new V(100, 3000, -100));
      root.localToWorld(target); root.localToWorld(origin);
      queries.push({ ray: new R(origin, target.sub(origin).normalize()), near: 0, far: Infinity });
    }
    queries.push({ ray: new R(new V(100, 100, 100), new V(0, 1, 0)), near: 0, far: Infinity });
    let hits = 0, misses = 0, localHits = 0, maxNativeError = 0;
    const saved = [];
    for (const query of queries) {
      const before = previous.closest(query, surfaces), after = current.closest(query, surfaces);
      if (Boolean(before) !== Boolean(after)) throw Error('hit/miss changed');
      const nativeHits = []; for (const mesh of surfaces) mesh.raycast(query, nativeHits);
      nativeHits.sort((a, b) => a.distance - b.distance); const native = nativeHits[0] ?? null;
      if (Boolean(native) !== Boolean(after)) throw Error('native hit/miss mismatch');
      if (after) {
        hits++; if (after.mesh.name === 'LocalHighResTerrainMesh') localHits++;
        if (after.mesh !== before.mesh || !after.point.equals(before.point) || after.distance !== before.distance) throw Error('exact picking result changed');
        maxNativeError = Math.max(maxNativeError, after.point.distanceTo(native.point));
        saved.push({ hit: after, expected: after.point.clone() });
      } else misses++;
    }
    if (saved.some(({ hit, expected }) => !hit.point.equals(expected))) throw Error('saved hit overwritten');
    app.sceneManager.render(); const gl = app.sceneManager.renderer.getContext();
    return { queries: queries.length, hits, misses, localHits, surfaces: surfaces.length, maxNativeError, exactPreviousHits: true, retainedHitsIndependent: true, chunks: app.terrainResult.localChunks.length, vertices: app.terrainResult.localChunks.reduce((n, chunk) => n + chunk.totalVertices, 0), imagery: app.activeTrek.imageryLOD.getDiagnostics(), calls: app.sceneManager.renderer.info.render.calls, glError: gl.getError(), renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  assert(picking.hits > 0 && picking.misses > 0 && picking.localHits > 0); assert(picking.maxNativeError < 1e-8); assert.equal(picking.glError, 0);
  const after = PNG.sync.read(await canvas.screenshot({ path: path.join(out, 'after.png') }));
  let changedPixels = 0, maxChannelDifference = 0;
  assert.equal(before.width, after.width); assert.equal(before.height, after.height);
  for (let i = 0; i < before.data.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 4; c++) { const difference = Math.abs(before.data[i + c] - after.data[i + c]); changed ||= difference > 0; maxChannelDifference = Math.max(maxChannelDifference, difference); }
    if (changed) changedPixels++;
  }
  assert(changedPixels <= 4 && maxChannelDifference <= 1); assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#btnSettings'); await page.click('#btnFitTerrain');
  await page.evaluate(() => window.__trekViewerApp.sceneManager.render());
  await page.screenshot({ path: path.join(out, 'mobile.png') });
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  const result = { picking, renderingDifference: { changedPixels, maxChannelDifference, totalPixels: before.width * before.height }, errors, warnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
