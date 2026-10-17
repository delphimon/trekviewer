import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_WORKER_URL ?? 'https://127.0.0.1:4199';
const out = path.resolve(process.env.TREK_WORKER_OUT ?? '.review-cache/worker-startup-browser'); fs.mkdirSync(out, { recursive: true });
let browser, server;
try {
  if (!process.env.TREK_WORKER_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4199', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Preview timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4199')) { clearTimeout(timer); resolve(); } }); server.on('error', reject); });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const results = [];
  for (const scenario of ['one-failed-start', 'unavailable-worker']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1233, height: 821 } });
    let attempts = 0, blocked = 0; let allowRecovery = false;
    const errors = [], warnings = [];
    await context.route('**/TerrainWorker-*.js', async route => {
      attempts++;
      if (!allowRecovery && (scenario === 'unavailable-worker' || attempts === 1)) { blocked++; return route.abort('failed'); }
      return route.continue();
    });
    await context.route('**/USGSNAIPPlus/ImageServer/exportImage?**', route => route.abort('timedout'));
    await context.route('**/imagery.geoplatform.gov/**', route => route.abort('timedout'));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
    await page.goto(`${base}/?profile=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__trekViewerApp?.activeTrek && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 120000 });
    const snapshot = await page.evaluate(async () => {
      const app = window.__trekViewerApp, grid = app.activeTrek.terrainResult.demGrid;
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', grid.data))].map(n => n.toString(16).padStart(2, '0')).join('');
      return { build: await (await fetch('/build-info.json')).json(), route: app.activeTrek.track.name, source: grid.source, width: grid.width, height: grid.height, hash, glError: app.sceneManager.renderer.getContext().getError() };
    });
    assert(snapshot.source.includes('USGS 3DEP')); assert.equal(snapshot.glError, 0); assert.equal(blocked, scenario === 'one-failed-start' ? 1 : 2);
    if (scenario === 'one-failed-start') assert.equal(warnings.filter(w => w.includes('using identical local computation')).length, 0);
    else {
      assert.equal(warnings.filter(w => w.includes('using identical local computation')).length, 1);
      allowRecovery = true;
      await page.waitForTimeout(10100);
      await page.click('#btnViewToggle');
      await page.waitForFunction(() => [...window.__trekViewerApp.activeTrek.imageryLOD.patches.values()].some(p => p.zoom === 19 && p.mesh.visible), null, { timeout: 120000 });
      assert(attempts > blocked, 'Worker is retried after cooldown');
    }
    assert.deepEqual(errors, []);
    results.push({ scenario, attempts, blocked, snapshot, errors, warnings });
    await context.close();
  }
  assert.equal(results[0].snapshot.hash, results[1].snapshot.hash, 'Worker and local fallback preserve exact elevation samples');
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ condition: 'Actual production Edge WebGL with deliberate terrain worker script failures, real USGS data and public imagery alternatives. Desktop, not native XR.', results }, null, 2));
  console.log(JSON.stringify(results.map(r => ({ scenario: r.scenario, attempts: r.attempts, blocked: r.blocked, source: r.snapshot.source, hash: r.snapshot.hash, glError: r.snapshot.glError, errors: r.errors }))));
} finally { await browser?.close(); server?.kill(); }
