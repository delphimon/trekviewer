import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_DEM_BROWSER_OUT ?? '.review-cache/dem-registration-browser');
fs.mkdirSync(out, { recursive: true });
const expectedBuild = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
const expectedEntry = path.posix.basename(fs.readFileSync('dist/index.html', 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
const olympus = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8')).find(r => r.id === 'olympus-bailey-2026');
assert.ok(olympus);
const base = process.env.TREK_DEM_BROWSER_URL ?? 'https://127.0.0.1:4204/';
let browser, server;
const requests = [], errors = [];
try {
  if (!process.env.TREK_DEM_BROWSER_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4204', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4204')) { clearTimeout(timer); resolve(); } });
      server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  // Desktop Edge only: the explicit test UA selects the same 125k base-vertex
  // budget as the saved Quest run. This does not simulate native XR rendering.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: true,
    userAgent: 'TrekViewer desktop regression fixture (Quest geometry budget)' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/routes/manifest.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify([olympus]) });
    if (url.hostname === 'elevation.nationalmap.gov' && url.pathname.endsWith('/3DEPElevation/ImageServer/exportImage')) {
      requests.push(url.href); return route.continue();
    }
    return url.origin === new URL(base).origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const snapshots = [];
  for (const pass of ['cold', 'reload']) {
    await page.goto(`${base}?debug=1&terrainTiles=0&regionalBase=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready'
      && window.__trekViewerApp.currentTrack?.name.includes('Olympus'), null, { timeout: 90000 });
    await page.waitForFunction(() => {
      const c = window.__trekViewerApp.getProfileCounters();
      return c.resourceCacheWrites > 0 || c.resourceCacheHits > 0;
    });
    const snapshot = await page.evaluate(() => {
      const a = window.__trekViewerApp, t = a.activeTrek.terrainResult, g = t.demGrid;
      return { scripts: [...document.scripts].map(s => s.src), state: a.session.getState().viewMode,
        quality: t.terrainQuality, grid: g && { width: g.width, height: g.height, source: g.source,
          min: g.minElevation, max: g.maxElevation, rasterBounds: g.rasterBounds, sampleSpacingMeters: g.sampleSpacingMeters },
        mesh: t.baseMeshGrid, counters: a.getProfileCounters(), xr: a.sceneManager.renderer.xr.isPresenting,
        contextLost: a.sceneManager.renderer.getContext().isContextLost(), glError: a.sceneManager.renderer.getContext().getError() };
    });
    assert.ok(snapshot.scripts.some(src => src.endsWith('/' + expectedEntry)));
    assert.equal(snapshot.quality, 'dem'); assert.equal(snapshot.grid.source, 'USGS 3DEP best available (public domain)');
    assert.equal(snapshot.grid.width, 1024); assert.equal(snapshot.grid.height, 675);
    assert.equal(snapshot.mesh.segmentsX, 434); assert.equal(snapshot.mesh.segmentsZ, 286);
    assert.ok(snapshot.grid.max - snapshot.grid.min > 2000);
    assert.equal(snapshot.xr, false); assert.equal(snapshot.contextLost, false); assert.equal(snapshot.glError, 0);
    snapshots.push({ pass, ...snapshot });
    console.log(JSON.stringify({ pass, grid: snapshot.grid, cacheHits: snapshot.counters.resourceCacheHits, networkExports: requests.length }));
  }
  const baseRequests = requests.filter(url => new URL(url).searchParams.get('size') === '1024,675');
  assert.equal(baseRequests.length, 1, 'Reload must reuse corrected whole-model LERC bytes');
  assert.ok(requests.every(url => new URL(url).searchParams.get('adjustAspectRatio') === 'false'));
  assert.ok(snapshots[1].counters.resourceCacheHits >= 1); assert.deepEqual(errors, []);
  const hostedBuild = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
  assert.equal(hostedBuild.id, expectedBuild.id);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ condition: 'Production desktop Edge, Quest geometry budget selected by test UA, single-route manifest fixture, live USGS DEM. Imagery and broad tiled refinement are disabled; the legacy local refinement path may still request elevation. Reload assertions concern the whole-model raster. No native acceptance claim.',
    build: hostedBuild, entry: expectedEntry, requests, baseRequests, snapshots, errors }, null, 2) + '\n');
} finally { await browser?.close(); server?.kill(); }
