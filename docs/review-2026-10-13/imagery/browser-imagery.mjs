import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/imagery'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4179', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser, releaseReplacement;
const replacementGate = new Promise(resolve => { releaseReplacement = resolve; });
let requestedReplacement;
const replacementRequested = new Promise(resolve => { requestedReplacement = resolve; });
const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4179')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text()); });
  await page.route('**/MountBakerJuly2026.gpx', async route => { requestedReplacement(); await replacementGate; await route.continue(); });
  await page.goto('https://127.0.0.1:4179/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier') && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  const setup = await page.evaluate(() => {
    const app = window.__trekViewerApp;
    document.getElementById('profile-controls')?.remove(); app.controls.enableDamping = false;
    window.oldTrek = app.activeTrek; window.oldImages = app.terrainResult.getGraphicsResources().map(texture => texture.image);
    window.imageryCanvases = []; window.imageryUploads = [];
    const create = document.createElement.bind(document);
    document.createElement = (...args) => { const element = create(...args); if (String(args[0]).toLowerCase() === 'canvas') window.imageryCanvases.push(element); return element; };
    const gl = app.sceneManager.renderer.getContext();
    for (const method of ['texImage2D', 'texSubImage2D']) {
      const original = gl[method].bind(gl);
      gl[method] = (...args) => {
        const source = args.find(value => value && typeof value.getContext === 'function' && window.imageryCanvases.includes(value));
        if (source) window.imageryUploads.push({ method, width: source.width, height: source.height });
        return original(...args);
      };
    }
    return { route: app.activeTrek.track.name, initialTextures: app.terrainResult.getGraphicsResources().map(texture => ({ width: texture.image.width, height: texture.image.height })), renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  // These are real session changes in one burst, before any tile can complete.
  await page.evaluate(() => { const app = window.__trekViewerApp; for (let i = 0; i < 12; i++) { app.session.setTextureStyle('topo'); app.session.setTextureStyle('satellite'); } app.session.setTextureStyle('topo'); });
  await page.waitForFunction(() => {
    const app = window.__trekViewerApp;
    return app.terrainResult.getGraphicsResources().length >= 3 && app.terrainResult.terrainMesh.material.map !== app.terrainResult.getGraphicsResources()[0];
  }, null, { timeout: 60000 });
  const switched = await page.evaluate(() => {
    const app = window.__trekViewerApp, resources = app.terrainResult.getGraphicsResources();
    window.oldImages = resources.map(texture => texture.image);
    return { style: app.session.getState().textureStyle, selected: document.getElementById('btnTopoTex').getAttribute('aria-pressed'), canvases: window.imageryCanvases.filter(canvas => canvas.width >= 512 && canvas.height >= 512).map(canvas => ({ width: canvas.width, height: canvas.height })), textures: resources.map(texture => ({ width: texture.image.width, height: texture.image.height, mipmaps: texture.generateMipmaps })), uploads: [...window.imageryUploads] };
  });
  assert.equal(switched.style, 'topo'); assert.equal(switched.selected, 'true'); assert.equal(switched.canvases.length, 1);
  await page.screenshot({ path: path.join(out, 'topographic.png') });
  // Leave the previously rendered Topo image cached and inactive during recovery.
  await page.click('#btnSatTex');
  const viewBefore = await page.evaluate(() => { const app = window.__trekViewerApp; return { progress: app.session.getState().progress, camera: app.sceneManager.camera.position.toArray(), target: app.controls.target.toArray() }; });
  await page.selectOption('#routeSelect', 'baker-2026');
  await Promise.race([replacementRequested, new Promise((_, reject) => setTimeout(() => reject(Error('replacement request timeout')), 10000))]);
  await page.waitForTimeout(400);
  const pending = await page.evaluate(() => { const app = window.__trekViewerApp; return { oldMounted: app.activeTrek === window.oldTrek && !!window.oldTrek.group.parent, disposed: window.oldTrek.isDisposed, images: window.oldImages.map(image => ({ width: image.width, height: image.height })) }; });
  assert(pending.oldMounted && !pending.disposed); assert(pending.images.every(image => image.width >= 512 && image.height >= 512));
  await page.screenshot({ path: path.join(out, 'replacement-loading.png') });
  await page.evaluate(() => { const gl = window.__trekViewerApp.sceneManager.renderer.getContext(); window.imageryRecovery = gl.getExtension('WEBGL_lose_context'); window.imageryRecovery.loseContext(); });
  await page.waitForFunction(() => window.__trekViewerApp.graphicsRecovery.state === 'lost');
  await page.evaluate(() => window.imageryRecovery.restoreContext());
  await page.waitForFunction(() => !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 30000 });
  const recovered = await page.evaluate(() => {
    const app = window.__trekViewerApp;
    return { oldMounted: app.activeTrek === window.oldTrek && !!window.oldTrek.group.parent, progress: app.session.getState().progress, camera: app.sceneManager.camera.position.toArray(), target: app.controls.target.toArray(), images: window.oldImages.map(image => ({ width: image.width, height: image.height })), glError: app.sceneManager.renderer.getContext().getError(), drawCalls: app.sceneManager.renderer.info.render.calls };
  });
  assert(recovered.oldMounted); assert.equal(recovered.glError, 0); assert(recovered.drawCalls > 0);
  for (const key of ['progress', 'camera', 'target']) assert.deepEqual(recovered[key], viewBefore[key]);
  assert(recovered.images.every(image => image.width >= 512 && image.height >= 512));
  releaseReplacement();
  await page.waitForFunction(() => window.__trekViewerApp.session.getState().activeRouteId === 'baker-2026', null, { timeout: 90000 });
  await page.waitForTimeout(300);
  const replaced = await page.evaluate(() => ({ oldDisposed: window.oldTrek.isDisposed, images: window.oldImages.map(image => ({ width: image.width, height: image.height })), route: window.__trekViewerApp.activeTrek.track.name, glError: window.__trekViewerApp.sceneManager.renderer.getContext().getError() }));
  assert(replaced.oldDisposed); assert(replaced.images.every(image => image.width === 1 && image.height === 1)); assert.equal(replaced.glError, 0);
  await page.screenshot({ path: path.join(out, 'replacement-ready.png') });
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ setup, switched, pending, recovered, replaced, errors, warnings }, null, 2));
  console.log(JSON.stringify({ setup, switched, pending, recovered, replaced, errors, warnings }));
} finally { releaseReplacement(); await browser?.close(); server.kill(); }
