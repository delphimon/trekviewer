import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { PNG } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/lib/utilsBundle.js');
const compare = (a, b) => {
  const first = PNG.sync.read(a), second = PNG.sync.read(b);
  assert.equal(first.width, second.width); assert.equal(first.height, second.height);
  let changedPixels = 0, maxChannelDifference = 0;
  for (let i = 0; i < first.data.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 4; c++) { const difference = Math.abs(first.data[i + c] - second.data[i + c]); changed ||= difference > 0; maxChannelDifference = Math.max(maxChannelDifference, difference); }
    if (changed) changedPixels++;
  }
  return { changedPixels, maxChannelDifference, totalPixels: first.width * first.height };
};
const oldSource = stripTypeScriptTypes(fs.readFileSync(new URL('./SurfaceVertexIndex-before.ts', import.meta.url), 'utf8'), { mode: 'transform' })
  .replace("import * as THREE from 'three';", 'const THREE = window.lookupThree;')
  .replace('export class SurfaceVertexIndex', 'window.PreviousSurfaceVertexIndex = class SurfaceVertexIndex');
const out = path.resolve('.review-cache/lookup'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4182', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4182')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error))); page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text()); });
  await page.goto('https://127.0.0.1:4182/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier') && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    document.getElementById('profile-controls')?.remove(); const app = window.__trekViewerApp;
    app.controls.enableDamping = false;
    app.activeTrek.localTerrainStreamer.update = () => {};
    const point = app.trailResult.routeGeometry.getTelemetryAtProgress(0.4).position.clone();
    point.y = app.terrainResult.sampleRenderedSurfaceY(point.x, point.z);
    app.sceneManager.dioramaRoot.localToWorld(point); app.controls.target.copy(point);
    app.sceneManager.camera.position.copy(point).add(point.clone().set(0, 0.048, 0.064));
    app.controls.update(); app.sceneManager.updateCameraClipping(app.controls.getDistance());
  });
  await page.waitForFunction(() => { const d = window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics(); return d.coveragePercent === 100 && d.inFlightRequests === 0 && d.requestQueueLength === 0; }, null, { timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const app = window.__trekViewerApp; app.sceneManager.renderer.setAnimationLoop(null);
    const geometry = app.trailResult.trailMesh.geometry;
    window.lookupThree = { Sphere: geometry.boundingSphere.constructor, DynamicDrawUsage: geometry.attributes.position.usage };
  });
  await page.addScriptTag({ content: oldSource });
  const baseline = await page.evaluate(() => {
    const app = window.__trekViewerApp, trail = app.trailResult;
    const geometries = trail.getGraphicsResources().filter(g => g.isBufferGeometry);
    const point = trail.routeGeometry.getTelemetryAtProgress(0.4).position;
    const bounds = { minX: point.x - 650, maxX: point.x + 650, minZ: point.z - 650, maxZ: point.z + 650 };
    const factor = app.session.getState().verticalExaggeration;
    const lift = Math.max(2.5, 2 * Math.max(1, Math.max(app.currentTrack.bounds.widthMeters, app.currentTrack.bounds.depthMeters) / 4000));
    window.lookupSampler = (x, z) => app.terrainResult.sampleRenderedSurfaceY(x, z);
    window.lookupBounds = bounds;
    window.lookupInitial = geometries.map(g => ({ positions: g.attributes.position.array.slice(), normals: g.attributes.normal.array.slice(), box: g.boundingBox.clone(), sphere: g.boundingSphere.clone() }));
    const beacons = [trail.startBeacon, trail.finishBeacon, trail.hikerMarker];
    window.lookupBeacons = beacons.map(b => b.position.clone());
    const selected = [];
    geometries.forEach((g, index) => {
      const previous = new window.PreviousSurfaceVertexIndex(g, 500, index === 1), indices = previous.verticesIn(bounds);
      for (const i of indices) {
        const x = g.attributes.position.getX(i), z = g.attributes.position.getZ(i);
        g.attributes.position.setY(i, window.lookupSampler(x, z) * (index === 0 ? factor : 1) + (index === 0 ? lift : 0.08));
      }
      previous.updatePositions(indices); if (index === 1) previous.updateNormals(indices); selected.push(indices.length);
    });
    beacons.forEach((b, i) => { const p = b.position; if (p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ) p.y = window.lookupSampler(p.x, p.z) * factor + (i === 2 ? lift : 8); });
    window.lookupExpected = geometries.map(g => ({ positions: g.attributes.position.array.slice(), normals: g.attributes.normal.array.slice() }));
    app.sceneManager.render();
    const gl = app.sceneManager.renderer.getContext(), diagnostics = app.activeTrek.imageryLOD.getDiagnostics();
    return { selected, bounds, vertices: geometries.map(g => g.attributes.position.count), calls: app.sceneManager.renderer.info.render.calls, textures: app.sceneManager.renderer.info.memory.textures, patches: diagnostics.activePatchesCount, coverage: diagnostics.coveragePercent, glError: gl.getError(), renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  const canvas = page.locator('#canvas-container canvas').first();
  const before = await canvas.screenshot({ path: path.join(out, 'previous-lookup.png') });
  await page.evaluate(() => window.__trekViewerApp.sceneManager.render());
  const beforeRepeat = await canvas.screenshot({ path: path.join(out, 'previous-repeat.png') });
  const current = await page.evaluate(() => {
    const app = window.__trekViewerApp, trail = app.trailResult;
    const geometries = trail.getGraphicsResources().filter(g => g.isBufferGeometry);
    geometries.forEach((g, index) => { const initial = window.lookupInitial[index]; g.attributes.position.array.set(initial.positions); g.attributes.normal.array.set(initial.normals); g.boundingBox.copy(initial.box); g.boundingSphere.copy(initial.sphere); g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true; });
    [trail.startBeacon, trail.finishBeacon, trail.hikerMarker].forEach((b, i) => b.position.copy(window.lookupBeacons[i]));
    trail.reprojectToSurface(window.lookupSampler, window.lookupBounds);
    const equality = geometries.map((g, index) => {
      const expected = window.lookupExpected[index];
      return { positions: g.attributes.position.array.every((v, i) => Object.is(v, expected.positions[i])), normals: g.attributes.normal.array.every((v, i) => Object.is(v, expected.normals[i])) };
    });
    app.sceneManager.render();
    return { equality, calls: app.sceneManager.renderer.info.render.calls, textures: app.sceneManager.renderer.info.memory.textures, glError: app.sceneManager.renderer.getContext().getError() };
  });
  assert(current.equality.every(g => g.positions && g.normals));
  const after = await canvas.screenshot({ path: path.join(out, 'current-lookup.png') });
  await page.evaluate(() => window.__trekViewerApp.sceneManager.render());
  const afterRepeat = await canvas.screenshot({ path: path.join(out, 'current-repeat.png') });
  const renderingDifference = compare(beforeRepeat, after), previousRepeatDifference = compare(before, beforeRepeat), currentRepeatDifference = compare(after, afterRepeat);
  // A one-step channel tolerance accounts for GPU/compositor rounding, not geometry changes.
  assert(renderingDifference.changedPixels <= 4 && renderingDifference.maxChannelDifference <= 1, 'matched rendering');
  for (const key of ['calls', 'textures', 'glError']) assert.equal(baseline[key], current[key]); assert.equal(current.glError, 0);
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  const result = { baseline, current, renderingDifference, previousRepeatDifference, currentRepeatDifference, imageSha256: createHash('sha256').update(after).digest('hex'), errors, warnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
