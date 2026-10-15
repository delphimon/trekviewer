import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/fidelity'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4188', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4188')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
  await page.goto('https://127.0.0.1:4188/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'), null, { timeout: 90000 });
  await page.evaluate(() => { document.getElementById('profile-controls')?.remove(); window.__trekViewerApp.controls.enableDamping = false; });
  await page.mouse.move(900, 400); await page.mouse.wheel(0, -300); await page.waitForTimeout(200);
  const snapshot = () => page.evaluate(() => {
    const app = window.__trekViewerApp, s = app.activeTrek.localTerrainStreamer, gl = app.sceneManager.renderer.getContext();
    return { profile: app.session.getState().qualityProfile, patches: app.activeTrek.imageryLOD.getDiagnostics().activePatchesCount, chunks: s.activeChunks.length, vertices: s.activeChunks.reduce((n, c) => n + c.totalVertices, 0), cells: s.activeChunks.map(c => c.getCellSize()), camera: app.sceneManager.camera.position.toArray(), target: app.controls.target.toArray(), model: app.sceneManager.dioramaRoot.matrix.toArray(), progress: app.session.getState().progress, glError: gl.getError() };
  });
  const before = await snapshot(); assert.equal(before.profile, 'desktop-high');
  await page.click('#btnQualityBalanced');
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return s.profile.name === 'quest-balanced' && !s.retireAll && !s.busy && !s.ready && s.chunks.size === s.wanted.size && s.chunks.size > 0; }, null, { timeout: 120000 });
  const balanced = await snapshot(); assert.equal(balanced.profile, 'quest-balanced'); assert(balanced.chunks <= 9 && balanced.vertices <= 40000); assert(balanced.cells.every(c => c.x <= 25.001 && c.z <= 25.001 && c.x > 5));
  await page.click('#btnQualityHigh');
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return s.profile.name === 'desktop-high' && !s.retireAll && s.chunks.size > 0 && [...s.chunks.values()].every(c => c.getCellSize().x <= 5.001); }, null, { timeout: 120000 });
  const high = await snapshot(); assert.equal(high.profile, 'desktop-high'); assert(high.chunks <= 128 && high.vertices <= 1600000);
  for (const view of [balanced, high]) {
    for (const key of ['camera', 'target', 'model']) assert(view[key].every((value, i) => Math.abs(value - before[key][i]) < 1e-12));
    assert.equal(view.progress, before.progress); assert.equal(view.glError, 0);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.click('#btnSettings'); await page.click('#btnFitTerrain');
  assert.equal(await page.locator('#btnSettings').getAttribute('aria-expanded'), 'false');
  const mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert(mobile.scrollWidth <= mobile.width);
  await page.screenshot({ path: path.join(out, 'mobile-high.png') });
  await page.click('#btnViewToggle'); assert(await page.locator('#btnFitTerrain').isDisabled());
  await page.waitForTimeout(300); await page.click('#btnViewToggle'); assert(await page.locator('#btnFitTerrain').isEnabled());
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  const result = { before, balanced, high, mobile, errors, warnings };
  fs.writeFileSync(path.join(out, 'controls.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
