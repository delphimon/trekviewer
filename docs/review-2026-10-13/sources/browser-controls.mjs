import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/sources');
fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4189', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser;
const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4189')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (['warning', 'error'].includes(m.type())) warnings.push(m.text()); });
  await page.goto('https://127.0.0.1:4189/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'), null, { timeout: 120000 });
  await page.evaluate(() => { document.getElementById('profile-controls')?.remove(); window.__trekViewerApp.controls.enableDamping = false; });
  await page.click('#btnFitTerrain'); await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(out, 'overview.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#btnSettings'); await page.click('#btnFitTerrain'); await page.waitForTimeout(300);
  const mobile = await page.evaluate(() => {
    const a = window.__trekViewerApp, rect = document.getElementById('desktopAttribution').getBoundingClientRect();
    const center = a.terrainResult.terrainMesh.geometry.boundingSphere.center.clone();
    a.terrainResult.terrainMesh.localToWorld(center); center.project(a.sceneManager.camera);
    return { fitted: a.desktopViewFitted, center: center.toArray(), width: innerWidth, scrollWidth: document.documentElement.scrollWidth, attribution: { left: rect.left, right: rect.right, bottom: rect.bottom }, glError: a.sceneManager.renderer.getContext().getError(), camera: a.sceneManager.camera.position.toArray() };
  });
  assert(mobile.fitted); assert(mobile.scrollWidth <= mobile.width);
  assert(Math.abs(mobile.center[0]) < .5 && Math.abs(mobile.center[1]) < .7, 'fitted terrain centre is in the mobile view');
  assert(mobile.attribution.left >= 0 && mobile.attribution.right <= 390); assert.equal(mobile.glError, 0);
  assert.equal(await page.locator('#btnSettings').getAttribute('aria-expanded'), 'false');
  await page.screenshot({ path: path.join(out, 'mobile.png') });
  await page.click('#btnSettings');
  const sourceLink = page.locator('a[href$="data-sources.html"]'); assert.equal(await sourceLink.count(), 1);
  const creditsResponse = await page.request.get(new URL(await sourceLink.getAttribute('href'), page.url()).href);
  assert(creditsResponse.ok()); const credits = await creditsResponse.text(); assert(credits.includes('CC BY-NC-SA 4.0') && credits.includes('lerc-LICENSE.txt'));
  const global = await page.evaluate(async () => {
    const lat = 46.85, lon = 9.5, z = 15, n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n), y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    const url = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${y}/${x}.jpg`;
    const image = new Image(); image.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(Error('EOX image load failed')); image.src = url; });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, 256, 256).data; let min = 255, max = 0;
    for (let i = 0; i < rgba.length; i += 4) { min = Math.min(min, rgba[i]); max = Math.max(max, rgba[i]); }
    return { url, width: image.naturalWidth, height: image.naturalHeight, redMin: min, redMax: max, canvasCorsReadable: true };
  });
  assert.equal(global.width, 256); assert(global.redMax - global.redMin > 30);
  assert.deepEqual(errors, []);
  const result = { mobile, global, creditsPage: true, errors, warnings, checksPassed: true };
  fs.writeFileSync(path.join(out, 'controls.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
