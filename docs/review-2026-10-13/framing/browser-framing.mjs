import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/framing'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4181', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
const samePose = (a, b) => { for (const key of ['camera', 'target', 'position', 'quaternion', 'scale']) assert(a[key].every((v, i) => Math.abs(v - b[key][i]) < 1e-12), key); assert.equal(a.progress, b.progress); };
const fitted = s => { assert(s.fitted); assert(s.screen.left >= s.area.left - 0.5); assert(s.screen.right <= s.area.right + 0.5); assert(s.screen.top >= s.area.top - 0.5); assert(s.screen.bottom <= s.area.bottom + 0.5); assert(s.depth.min > -1 && s.depth.max < 1); assert.equal(s.glError, 0); };
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4181')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error))); page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text()); });
  await page.goto('https://127.0.0.1:4181/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier') && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    document.getElementById('profile-controls')?.remove();
    const app = window.__trekViewerApp; app.controls.enableDamping = false;
    window.frameSnapshot = () => {
      const root = app.sceneManager.dioramaRoot, camera = app.sceneManager.camera, terrain = app.terrainResult;
      root.updateWorldMatrix(true, true);
      const meshes = [terrain.terrainMesh, terrain.skirtMesh, ...terrain.localChunks.filter(c => c.mesh.visible).map(c => c.mesh)].filter(Boolean);
      let box;
      for (const mesh of meshes) { mesh.geometry.computeBoundingBox(); const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld); if (box) box.union(b); else box = b; }
      const area = { left: innerWidth > 900 ? document.querySelector('.stats-panel').getBoundingClientRect().right + 16 : 16, right: innerWidth - 16, top: document.querySelector('.top-bar').getBoundingClientRect().bottom + 16, bottom: document.querySelector('.player-bar').getBoundingClientRect().top - 16 };
      const screen = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }, depth = { min: Infinity, max: -Infinity };
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = camera.position.clone().set(x, y, z).project(camera), px = (p.x + 1) * innerWidth / 2, py = (1 - p.y) * innerHeight / 2;
        screen.left = Math.min(screen.left, px); screen.right = Math.max(screen.right, px); screen.top = Math.min(screen.top, py); screen.bottom = Math.max(screen.bottom, py); depth.min = Math.min(depth.min, p.z); depth.max = Math.max(depth.max, p.z);
      }
      return { area, screen, depth, camera: camera.position.toArray(), target: app.controls.target.toArray(), position: root.position.toArray(), quaternion: root.quaternion.toArray(), scale: root.scale.toArray(), progress: app.session.getState().progress, fitted: app.desktopViewFitted, distance: app.controls.getDistance(), glError: app.sceneManager.renderer.getContext().getError() };
    };
    app.frameDesktopDiorama();
  });
  const snapshot = () => page.evaluate(() => window.frameSnapshot());
  const desktop = await snapshot(); fitted(desktop);
  await page.screenshot({ path: path.join(out, 'desktop-fit.png') });
  await page.setViewportSize({ width: 1400, height: 900 }); await page.waitForTimeout(250);
  const autoResize = await snapshot(); fitted(autoResize);
  await page.mouse.move(920, 430); await page.mouse.wheel(0, -350); await page.waitForTimeout(150);
  const manual = await snapshot(); assert.equal(manual.fitted, false); assert(manual.distance < autoResize.distance);
  await page.setViewportSize({ width: 1233, height: 821 }); await page.waitForTimeout(250);
  const manualResize = await snapshot(); samePose(manual, manualResize); assert.equal(manualResize.fitted, false);
  await page.uncheck('#horizonLocked');
  const beforeFit = await page.evaluate(() => { const app = window.__trekViewerApp; app.sceneManager.dioramaRoot.rotation.set(0.2, 0.7, -0.1, 'YXZ'); app.session.setProgress(0.37); return window.frameSnapshot(); });
  await page.locator('#btnFitTerrain').scrollIntoViewIfNeeded(); await page.locator('#btnFitTerrain').focus(); await page.keyboard.press('Enter');
  const explicitFit = await snapshot(); fitted(explicitFit);
  for (const key of ['position', 'quaternion', 'scale', 'progress']) assert.deepEqual(explicitFit[key], beforeFit[key]);
  await page.screenshot({ path: path.join(out, 'desktop-controls.png') });
  await page.mouse.move(890, 380); await page.mouse.down(); await page.mouse.move(970, 410, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(100);
  const rotated = await snapshot(); assert.equal(rotated.fitted, false);
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
  const mobileBeforeFit = await snapshot(); samePose(rotated, mobileBeforeFit);
  await page.click('#btnSettings'); await page.locator('#btnFitTerrain').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'mobile-settings.png') });
  await page.click('#btnFitTerrain'); await page.waitForTimeout(150);
  const mobile = await snapshot(); fitted(mobile);
  assert.equal(await page.locator('#btnSettings').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnSettings');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(out, 'mobile-fit.png') });
  await page.click('#btnViewToggle'); assert(await page.locator('#btnFitTerrain').isDisabled());
  await page.click('#btnViewToggle'); assert(await page.locator('#btnFitTerrain').isEnabled());
  const restored = await snapshot(); fitted(restored);
  const setup = await page.evaluate(() => { const gl = window.__trekViewerApp.sceneManager.renderer.getContext(); return { renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) }; });
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  const results = { setup, desktop, autoResize, manual, manualResize, beforeFit, explicitFit, rotated, mobileBeforeFit, mobile, restored, errors, warnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
} finally { await browser?.close(); server.kill(); }
