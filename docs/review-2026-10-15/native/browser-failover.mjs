import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_FAILOVER_OUT ?? '.review-cache/mr-failover-browser');
fs.mkdirSync(out, { recursive: true });
let server, browser;
const base = process.env.TREK_FAILOVER_URL ?? 'https://127.0.0.1:4194';
const errors = [], warnings = [], primaryRequests = [], alternateResponses = [];
try {
  if (!process.env.TREK_FAILOVER_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4194', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timed out')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4194')) { clearTimeout(timer); resolve(); } });
      server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
  await page.route('**/USGSNAIPPlus/ImageServer/exportImage?**', async route => {
    primaryRequests.push(route.request().url());
    await route.abort('timedout');
  });
  page.on('response', response => {
    if (/imagery\.geoplatform\.gov\/|\/USGSNAIPImagery\//.test(response.url()) && response.url().includes('/exportImage?')) alternateResponses.push({ url: response.url(), status: response.status() });
  });
  await page.goto(`${base}/?profile=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__trekViewerApp?.activeTrek, null, { timeout: 120000 });
  await page.evaluate(() => {
    const app = window.__trekViewerApp;
    app.flyoverController.setProgress(0.3555875547854273);
    app.session.setProgress(0.3555875547854273);
  });
  await page.click('#btnViewToggle');
  await page.waitForFunction(() => [...window.__trekViewerApp.activeTrek.imageryLOD.patches.values()]
    .filter(patch => patch.zoom === 19 && patch.mesh.visible && !patch.isFading).length >= 16, null, { timeout: 180000 });
  const initialPrimaryRequests = primaryRequests.length;
  await page.waitForFunction(() => {
    const app = window.__trekViewerApp;
    return app.session.getState().viewMode === 'first-person'
      && [...app.activeTrek.imageryLOD.patches.values()].filter(patch => patch.zoom === 19 && patch.mesh.visible && !patch.isFading).length >= 64;
  }, null, { timeout: 180000 });
  const result = await page.evaluate(async () => {
    const app = window.__trekViewerApp, lod = app.activeTrek.imageryLOD;
    const fine = [...lod.patches.values()].filter(patch => patch.zoom === 19 && patch.mesh.visible && !patch.isFading);
    return {
      build: await (await fetch('/build-info.json')).json(),
      mode: app.session.getState().viewMode,
      visibleFineTiles: fine.length,
      fineImages: fine.map(patch => ({ key: patch.key, width: patch.texture.image.width, height: patch.texture.image.height, source: patch.texture.image.dataset?.sourceUrl })),
      diagnostics: lod.getDiagnostics(),
      contextLost: app.sceneManager.renderer.getContext().isContextLost(),
      glError: app.sceneManager.renderer.getContext().getError(),
    };
  });
  Object.assign(result, { condition: 'Actual Edge production build with preferred imagery endpoint deliberately aborted; real configured public NAIP imagery and terrain. Desktop 1:1 rendering, not native MR.', initialPrimaryRequests, primaryRequests, alternateResponses, errors, warnings });
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  // Startup tabletop selection and the transition to 1:1 can each admit four
  // source groups before the first outage is delivered. Later groups must not
  // keep reissuing the failed preferred service.
  assert(primaryRequests.length > 0 && primaryRequests.length <= 8);
  assert.equal(primaryRequests.length, initialPrimaryRequests, 'No repeated preferred-service failures after initial fine coverage');
  assert(alternateResponses.filter(response => response.status === 200).length >= 4);
  assert(result.visibleFineTiles >= 64);
  assert(result.fineImages.every(image => image.width === 256 && image.height === 256 && /imagery\.geoplatform\.gov\/|\/USGSNAIPImagery\//.test(image.source ?? '')));
  assert.equal(result.contextLost, false); assert.equal(result.glError, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ visibleFineTiles: result.visibleFineTiles, initialPrimaryRequests, primaryRequests: primaryRequests.length, alternateResponses: alternateResponses.length, errors, warnings }));
} finally { await browser?.close(); server?.kill(); }
