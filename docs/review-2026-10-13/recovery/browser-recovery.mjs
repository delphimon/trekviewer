import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/recovery'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4177', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4177')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text()); });
  await page.goto('https://127.0.0.1:4177/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { document.getElementById('profile-controls')?.remove(); window.__trekViewerApp.controls.enableDamping = false; });
  // Allocate alternate trail and map resources, then leave them cached before context loss.
  await page.click('#btnViewToggle'); await page.waitForTimeout(300); await page.click('#btnViewToggle');
  await page.locator('#btnTopoTex').scrollIntoViewIfNeeded(); await page.click('#btnTopoTex'); await page.waitForTimeout(500);
  await page.click('#btnSatTex'); await page.waitForTimeout(300);
  const snapshot = () => page.evaluate(() => {
    const app = window.__trekViewerApp;
    return { route: app.currentTrack.name, progress: app.session.getState().progress, playing: app.session.getState().isPlaying,
      model: { position: app.sceneManager.dioramaRoot.position.toArray(), quaternion: app.sceneManager.dioramaRoot.quaternion.toArray(), scale: app.sceneManager.dioramaRoot.scale.toArray() },
      camera: app.sceneManager.camera.position.toArray(), target: app.controls.target.toArray() };
  });
  await page.locator('#scrubberInput').evaluate(input => { input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#btnPlay'); assert.equal(await page.locator('#btnPlay').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => {
    const gl = window.__trekViewerApp.sceneManager.renderer.getContext();
    window.recoveryExtension = gl.getExtension('WEBGL_lose_context');
    if (!window.recoveryExtension) throw Error('Context-loss extension unavailable');
    window.recoveryExtension.loseContext();
  });
  await page.waitForFunction(() => window.__trekViewerApp.graphicsRecovery.state === 'lost');
  const lost = await snapshot(); assert.equal(lost.playing, false);
  assert(await page.locator('#btnPlay').isDisabled()); assert(await page.locator('#scrubberInput').isDisabled());
  await page.screenshot({ path: path.join(out, 'graphics-paused.png') });
  await page.waitForTimeout(200); assert.equal((await snapshot()).progress, lost.progress);
  await page.evaluate(() => window.recoveryExtension.restoreContext());
  await page.waitForFunction(() => !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const restored = await snapshot(); assert.deepEqual(restored, lost);
  assert(await page.locator('#btnPlay').isEnabled()); assert(await page.locator('#graphicsStatus').isHidden());
  const rendering = await page.evaluate(() => ({ ...window.__trekViewerApp.sceneManager.getMemoryInfo(), glError: window.__trekViewerApp.sceneManager.renderer.getContext().getError() }));
  assert(rendering.render.calls > 0); assert.equal(rendering.glError, 0);
  await page.screenshot({ path: path.join(out, 'graphics-restored.png') });
  // Simulate shader preparation failure while exercising a second real context loss/restore.
  await page.evaluate(() => {
    const app = window.__trekViewerApp;
    window.realGraphicsPrepare = app.graphicsRecovery.options.prepare;
    app.graphicsRecovery.options.prepare = async () => { throw Error('Injected preparation failure'); };
    window.recoveryExtension = app.sceneManager.renderer.getContext().getExtension('WEBGL_lose_context');
    window.recoveryExtension.loseContext();
  });
  await page.waitForFunction(() => window.__trekViewerApp.graphicsRecovery.state === 'lost');
  await page.evaluate(() => window.recoveryExtension.restoreContext());
  await page.waitForFunction(() => window.__trekViewerApp.graphicsRecovery.state === 'failed');
  assert(await page.locator('#btnRetryGraphics').isVisible());
  await page.screenshot({ path: path.join(out, 'graphics-retry.png') });
  await page.evaluate(() => { window.__trekViewerApp.graphicsRecovery.options.prepare = window.realGraphicsPrepare; });
  await page.click('#btnRetryGraphics');
  await page.waitForFunction(() => !window.__trekViewerApp.graphicsRecovery.isSuspended);
  assert.deepEqual(await snapshot(), restored);
  // Selected state follows real clicks, and stays on the focused button.
  const selections = {};
  for (const [selector, group] of [['#btnColorEle', '[id^=btnColor]'], ['.speed-btn[data-speed="5"]', '.speed-btn'], ['.btn-exag[data-exag="1.5"]', '.btn-exag'], ['#btnQualityBalanced', '.btn-quality'], ['#btnTopoTex', '#btnSatTex,#btnHybridTex,#btnTopoTex']]) {
    await page.locator(selector).scrollIntoViewIfNeeded(); await page.locator(selector).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator(selector).getAttribute('aria-pressed'), 'true');
    const state = await page.locator(group).evaluateAll(buttons => buttons.map(button => ({ id: button.id || button.dataset.speed || button.dataset.exag, pressed: button.getAttribute('aria-pressed'), active: button.classList.contains('btn-active'), focused: button === document.activeElement })));
    assert.equal(state.filter(button => button.pressed === 'true').length, 1); assert(state.every(button => (button.pressed === 'true') === button.active)); assert(state.some(button => button.focused));
    selections[selector] = state;
  }
  await page.screenshot({ path: path.join(out, 'selected-controls.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.click('#btnSettings');
  await page.locator('#btnQualityBalanced').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, 'mobile-selected-controls.png') });
  await page.keyboard.press('Escape');
  const nextRoute = await page.locator('#routeSelect option').evaluateAll(options => options.find(option => !option.selected)?.value);
  if (nextRoute) {
    await page.selectOption('#routeSelect', nextRoute);
    await page.waitForFunction(() => window.__trekViewerApp.session.getState().activeRouteId === document.getElementById('routeSelect').value, null, { timeout: 90000 });
    await page.waitForTimeout(200);
  }
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ lost, restored, rendering, selections, errors, warnings }, null, 2));
  console.log(JSON.stringify({ lost, restored, rendering, errors, warnings }));
} finally { await browser?.close(); server.kill(); }
