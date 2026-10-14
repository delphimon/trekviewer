import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/startup'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4184', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
const samePose = (a, b) => { for (const key of ['camera', 'target']) assert(a[key].every((v, i) => Math.abs(v - b[key][i]) < 1e-12), key); };
const fits = s => { assert(s.fitted); assert(s.projected.left >= s.area.left - 1e-6 && s.projected.right <= s.area.right + 1e-6); assert(s.projected.top >= s.area.top - 1e-6 && s.projected.bottom <= s.area.bottom + 1e-6); assert.equal(s.glError, 0); };
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4184')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (['warning', 'error'].includes(m.type())) warnings.push(m.text()); });
  await page.addInitScript(() => {
    const xr = new EventTarget(), pending = [];
    window.xrRequestCount = 0;
    xr.isSessionSupported = mode => new Promise((resolve, reject) => pending.push({ mode, resolve, reject }));
    xr.requestSession = () => { window.xrRequestCount++; return Promise.reject(Error('Unexpected session request in support test')); };
    Object.defineProperty(navigator, 'xr', { configurable: true, value: xr });
    window.finishXRCheck = (vr, ar, fail = false) => { for (const item of pending.splice(0)) fail ? item.reject(Error('Simulated capability-check failure')) : item.resolve(item.mode === 'immersive-vr' ? vr : ar); };
    window.xrPendingCount = () => pending.length;
  });
  let releaseRoute; const heldRoute = new Promise(resolve => { releaseRoute = resolve; });
  await page.route('**/routes/MountRainierViaEmmons.gpx', async route => { await heldRoute; await route.continue(); });
  await page.goto('https://127.0.0.1:4184/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp && window.xrPendingCount() === 2);
  const initial = await page.evaluate(() => ({ vrDisabled: document.querySelector('#btnEnterVR').disabled, arDisabled: document.querySelector('#btnEnterAR').disabled, checking: document.querySelector('#xrSupportStatus').getAttribute('aria-busy'), message: document.querySelector('#xrSupportStatus').textContent, routeReady: Boolean(window.__trekViewerApp.activeTrek) }));
  assert(initial.vrDisabled && initial.arDisabled && initial.checking === 'true' && !initial.routeReady);
  await page.evaluate(() => { document.getElementById('btnEnterVR').click(); document.getElementById('btnEnterAR').click(); window.finishXRCheck(true, true); });
  await page.waitForFunction(() => document.querySelector('#xrSupportStatus').getAttribute('aria-busy') === 'false');
  assert(await page.locator('#btnEnterVR').isDisabled()); assert(await page.locator('#btnEnterAR').isDisabled());
  releaseRoute();
  await page.waitForFunction(() => window.__trekViewerApp.activeTrek && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const app = window.__trekViewerApp; document.getElementById('profile-controls')?.remove(); app.controls.enableDamping = false;
    app.activeTrek.localTerrainStreamer.update = () => {};
    window.startupFrameCalls = 0; const fit = app.frameDesktopDiorama; app.frameDesktopDiorama = function(...args) { window.startupFrameCalls++; return fit.apply(this, args); };
    window.startupSnapshot = () => {
      const app = window.__trekViewerApp, camera = app.sceneManager.camera, terrain = app.terrainResult;
      app.sceneManager.dioramaRoot.updateWorldMatrix(true, true);
      let box;
      const meshes = [terrain.terrainMesh, terrain.skirtMesh, ...terrain.localChunks.filter(c => c.mesh.visible).map(c => c.mesh)].filter(Boolean);
      for (const mesh of meshes) { mesh.geometry.computeBoundingBox(); const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld); if (box) box.union(b); else box = b; }
      const area = { left: innerWidth > 900 ? document.querySelector('.stats-panel').getBoundingClientRect().right + 16 : 16, right: innerWidth - 16, top: document.querySelector('.top-bar').getBoundingClientRect().bottom + 16, bottom: document.querySelector('.player-bar').getBoundingClientRect().top - 16 };
      const projected = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = camera.position.clone().set(x, y, z).project(camera), px = (p.x + 1) * innerWidth / 2, py = (1 - p.y) * innerHeight / 2;
        projected.left = Math.min(projected.left, px); projected.right = Math.max(projected.right, px); projected.top = Math.min(projected.top, py); projected.bottom = Math.max(projected.bottom, py);
      }
      return { area, projected, camera: camera.position.toArray(), target: app.controls.target.toArray(), fitted: app.desktopViewFitted, frameCalls: window.startupFrameCalls, glError: app.sceneManager.renderer.getContext().getError() };
    };
  });
  const snapshot = () => page.evaluate(() => window.startupSnapshot());
  assert(await page.locator('#btnEnterVR').isEnabled()); assert(await page.locator('#btnEnterAR').isEnabled());
  const ready = await snapshot(); fits(ready);
  await page.evaluate(() => navigator.xr.dispatchEvent(new Event('devicechange')));
  await page.waitForFunction(() => window.xrPendingCount() === 2 && window.startupFrameCalls > 0);
  const checkingFit = await snapshot(); fits(checkingFit); assert(await page.locator('#btnEnterVR').isDisabled());
  await page.evaluate(() => window.finishXRCheck(false, false)); await page.waitForTimeout(100);
  const unsupportedFit = await snapshot(); fits(unsupportedFit); assert(await page.locator('#btnEnterVR').isDisabled()); assert(await page.locator('#btnEnterAR').isDisabled());
  await page.screenshot({ path: path.join(out, 'availability-layout.png') });
  await page.mouse.move(900, 400); await page.mouse.wheel(0, -200); await page.waitForTimeout(100);
  const manual = await snapshot(); assert.equal(manual.fitted, false);
  await page.evaluate(() => { document.querySelector('.player-bar').style.paddingBottom = '110px'; }); await page.waitForTimeout(150);
  const manualLayout = await snapshot(); samePose(manual, manualLayout); assert.equal(manualLayout.frameCalls, manual.frameCalls);
  await page.click('#btnFitTerrain'); await page.waitForTimeout(100); const footerFit = await snapshot(); fits(footerFit);
  await page.evaluate(() => document.querySelector('.player-bar').style.removeProperty('padding-bottom')); await page.waitForTimeout(150);
  const restoredFit = await snapshot(); fits(restoredFit); assert(restoredFit.frameCalls > footerFit.frameCalls);
  await page.waitForTimeout(300); const staticFit = await snapshot(); assert.equal(staticFit.frameCalls, restoredFit.frameCalls);
  await page.evaluate(() => navigator.xr.dispatchEvent(new Event('devicechange'))); await page.waitForFunction(() => window.xrPendingCount() === 2);
  assert(await page.locator('#btnEnterVR').isDisabled());
  await page.evaluate(() => window.finishXRCheck(null, null, true)); await page.waitForTimeout(100);
  assert(await page.locator('#btnEnterVR').isEnabled()); assert(await page.locator('#btnEnterAR').isEnabled());
  assert((await page.locator('#xrSupportStatus').textContent()).includes('could not be checked'));
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(150);
  const mobile = await snapshot(); fits(mobile); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.click('#btnSettings'); await page.click('#btnFitTerrain'); await page.screenshot({ path: path.join(out, 'mobile-layout.png') });
  const disposal = await page.evaluate(() => {
    const app = window.__trekViewerApp; let disconnects = 0;
    const observer = app.layoutObserver, disconnect = observer.disconnect; observer.disconnect = function() { disconnects++; disconnect.call(this); };
    const header = document.querySelector('.top-bar');
    app.dispose(); const before = window.startupFrameCalls;
    header.style.paddingBottom = '70px';
    return { disconnects, observerCleared: app.layoutObserver === null, before };
  });
  await page.waitForTimeout(150); assert.equal(await page.evaluate(() => window.startupFrameCalls), disposal.before); assert.equal(disposal.disconnects, 1); assert(disposal.observerCleared);
  assert.equal(await page.evaluate(() => window.xrRequestCount), 0); assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  const result = { initial, ready, checkingFit, unsupportedFit, manual, manualLayout, footerFit, restoredFit, staticFit, mobile, disposal, sessionRequests: 0, errors, warnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
