import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/detail'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4180', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser;
const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4180')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text()); });
  await page.goto('https://127.0.0.1:4180/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier') && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  const setup = await page.evaluate(() => {
    const app = window.__trekViewerApp, scene = app.sceneManager, lod = app.activeTrek.imageryLOD;
    document.getElementById('profile-controls')?.remove(); app.controls.enableDamping = false;
    const target = app.trailResult.routeGeometry.getTelemetryAtProgress(0.4).position.clone();
    target.y = app.terrainResult.sampleRenderedSurfaceY(target.x, target.z); scene.dioramaRoot.localToWorld(target);
    window.detailTarget = target;
    window.detailPose = distance => {
      app.controls.target.copy(target); scene.camera.position.copy(target).add(target.clone().set(0, 0.6 * distance, 0.8 * distance));
      scene.camera.lookAt(target); app.controls.update(); scene.updateCameraClipping(app.controls.getDistance());
    };
    window.detailCalculator = lod.constructor.calculateTargetZoom;
    lod.constructor.calculateTargetZoom = (distance, ...args) => window.detailCalculator(Math.max(distance, 0.2), ...args);
    window.detailPose(0.025); lod.evaluationDirty = true;
    const gl = scene.renderer.getContext();
    return { renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL), target: target.toArray() };
  });
  await page.waitForFunction(() => {
    const d = window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics(); return d.coveragePercent === 100 && d.inFlightRequests === 0 && d.targetZoom >= 16;
  }, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  // Freeze DEM publication only for the matched imagery comparison; the render and imagery loops keep running.
  await page.evaluate(() => { const app = window.__trekViewerApp; app.activeTrek.localTerrainStreamer.update = () => {}; });
  const snapshot = () => page.evaluate(() => {
    const app = window.__trekViewerApp, d = app.activeTrek.imageryLOD.getDiagnostics();
    return { distance: app.controls.getDistance(), camera: app.sceneManager.camera.position.toArray(), target: app.controls.target.toArray(), near: app.sceneManager.camera.near, surfaceRevision: app.terrainResult.surfaceRevision, chunks: app.terrainResult.localChunks.length, zoom: d.targetZoom, desiredZoom: d.calculatedDesiredZoom, coverage: d.coveragePercent, patches: d.activePatchesCount, visibleByZoom: Object.fromEntries(d.visibleByZoom), maxPatches: app.activeTrek.imageryLOD.maxPatches, glError: app.sceneManager.renderer.getContext().getError() };
  });
  const baseline = await snapshot(); assert.equal(baseline.glError, 0);
  await page.screenshot({ path: path.join(out, 'close-floor.png') });
  await page.evaluate(() => { const app = window.__trekViewerApp; app.activeTrek.imageryLOD.constructor.calculateTargetZoom = window.detailCalculator; window.detailPose(0.05); });
  await page.waitForFunction(() => window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics().targetZoom === 18, null, { timeout: 10000 });
  const intermediate = await snapshot();
  await page.evaluate(() => window.detailPose(0.025));
  await page.waitForFunction(() => {
    const d = window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics(); return d.targetZoom === 19 && d.coveragePercent === 100 && (d.visibleByZoom.get(19) ?? 0) > 0;
  }, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const current = await snapshot();
  for (const key of ['camera', 'target']) assert(current[key].every((value, i) => Math.abs(value - baseline[key][i]) < 1e-12));
  for (const key of ['surfaceRevision', 'chunks', 'maxPatches']) assert.deepEqual(current[key], baseline[key]);
  assert(current.zoom > baseline.zoom); assert(current.patches <= current.maxPatches); assert.equal(current.glError, 0);
  assert(Math.abs(current.distance - intermediate.distance) < 0.04);
  await page.screenshot({ path: path.join(out, 'close-detail.png') });
  await page.evaluate(() => window.__trekViewerApp.startProfile()); await page.waitForTimeout(5000);
  const profile = await page.evaluate(() => { const app = window.__trekViewerApp; app.stopProfile(); return app.completedProfile; });
  fs.writeFileSync(path.join(out, 'close-profile.json'), JSON.stringify(profile, null, 2));
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ setup, baseline, intermediate, current, errors, warnings }, null, 2));
  console.log(JSON.stringify({ setup, baseline, intermediate, current, errors, warnings }));
} finally { await browser?.close(); server.kill(); }
