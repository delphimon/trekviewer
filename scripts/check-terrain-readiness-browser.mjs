import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const directory = process.env.TREK_READINESS_DIST ?? 'dist';
const out = process.env.TREK_READINESS_OUT ?? '.review-cache/terrain-readiness';
const baseline = process.env.TREK_READINESS_BASELINE === '1';
const base = process.env.TREK_READINESS_URL ?? 'https://127.0.0.1:4210/';
const build = JSON.parse(fs.readFileSync(path.join(directory, 'build-info.json'), 'utf8'));
const entry = path.posix.basename(fs.readFileSync(path.join(directory, 'index.html'), 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
const olympus = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8')).find(route => route.id === 'olympus-bailey-2026');
const lerc = fs.readFileSync('.review-cache/dem-registration/olympus-corrected.lerc');
let browser, server;
try {
  if (!process.env.TREK_READINESS_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', directory, '--host', '127.0.0.1', '--port', '4210', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4210')) { clearTimeout(timer); resolve(); } });
      server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, userAgent: 'TrekViewer desktop fixture (Quest budget)' });
  const errors = [], workerFallbackWarnings = [];
  let workers = 0;
  page.on('pageerror', error => errors.push(String(error)));
  page.on('worker', () => workers++);
  page.on('console', message => { if (message.text().includes('[TerrainJobs] Worker startup unavailable')) workerFallbackWarnings.push(message.text()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/routes/manifest.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify([olympus]) });
    if (url.hostname === 'elevation.nationalmap.gov' && url.searchParams.get('size') === '1024,675') return route.fulfill({ contentType: 'application/octet-stream', body: lerc });
    return url.origin === new URL(base).origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await page.goto(base + '?debug=1&regionalBase=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready'
    && window.__trekViewerApp.activeTrek?.localTerrainStreamer, null, { timeout: 60000 });
  assert.ok(await page.evaluate(entry => [...document.scripts].some(script => script.src.endsWith('/' + entry)), entry));
  const actualBuild = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
  assert.equal(actualBuild.id, build.id);
  const result = await page.evaluate(async baseline => {
    const app = window.__trekViewerApp;
    app.sceneManager.renderer.setAnimationLoop(null);
    const original = app.activeTrek.localTerrainStreamer, Streamer = original.constructor;
    const profile = original.getQualityProfile(); original.dispose();
    const center = app.activeTrek.terrainResult.terrainGeoBounds;
    const source = app.activeTrek.terrainResult.terrainMesh;
    const mesh = new source.constructor(source.geometry.clone(), source.material.clone());
    const parent = { width: 2880, depth: 960, segmentsX: 24, segmentsZ: 8 };
    const baseSurfaceData = { ...parent, heights: new Float32Array(25 * 9).fill(100) };
    const mercatorY = lat => Math.asinh(Math.tan(lat * Math.PI / 180)) * 6378137;
    const grid = { width: 2, height: 2, data: new Float32Array([300, 310, 290, 300]), isRealDEM: true,
      zoom: 0, minElevation: 290, maxElevation: 310, tileValidity: new Uint8Array([1]),
      rasterBounds: { west: (center.centerLon - 0.1) * Math.PI / 180 * 6378137,
        east: (center.centerLon + 0.1) * Math.PI / 180 * 6378137,
        south: mercatorY(center.centerLat - 0.1), north: mercatorY(center.centerLat + 0.1) } };
    const tiles = [0, 1, 2].map(column => ({ id: `${column}:0`, column, row: 0, width: 960, depth: 960,
      segmentsX: 192, segmentsZ: 192, vertexCount: 193 * 193,
      bounds: { minX: column * 960 - 1440, maxX: column * 960 - 480, minZ: -480, maxZ: 480 } }));
    const focus = { lat: center.centerLat, lon: center.centerLon };
    const make = () => {
      const attached = new Set();
      const terrain = { baseMeshGrid: parent, baseSurfaceData, terrainGeoBounds: center, terrainBaseElevation: 0,
        terrainMesh: mesh, sampleBaseSurfaceY: () => 100,
        attachLocalChunk: chunk => attached.add(chunk),
        detachLocalChunk: chunk => { attached.delete(chunk); chunk.dispose(); }, notifySurfaceChange: () => {} };
      const instance = new Streamer({ terrainResult: terrain, qualityProfile: profile, initialViewMode: 'diorama',
        routeGeometry: app.trailResult.routeGeometry, demGrid: grid });
      instance.plannedAt = { x: 0, z: 0 };
      return { instance, attached };
    };
    const deferred = () => {
      let resolve;
      const result = new Promise(done => { resolve = done; });
      const entry = { controller: new AbortController(), result, settled: false };
      void result.then(() => { entry.settled = true; });
      return { entry, resolve };
    };
    const pumpUntil = async (fixture, predicate, milliseconds = 5000) => {
      const deadline = performance.now() + milliseconds;
      do { fixture.instance.update(0, focus); await new Promise(resolve => setTimeout(resolve, 10)); }
      while (!predicate() && performance.now() < deadline);
    };
    const fixture = make(), pending = tiles.map(deferred);
    fixture.instance.wanted = new Map(tiles.map(tile => [tile.id, tile]));
    fixture.instance.prefetchElevation = () => {};
    fixture.instance.acquisitions = new Map(tiles.map((tile, index) => [tile.id, pending[index].entry]));
    fixture.instance.update(0, focus);
    pending[1].resolve({ grid }); pending[2].resolve({ grid });
    await pumpUntil(fixture, () => fixture.attached.size >= 2, baseline ? 750 : 5000);
    const whileFirstPending = fixture.attached.size;
    pending[0].resolve({ grid });
    await pumpUntil(fixture, () => fixture.attached.size === 3);
    const afterFirstCompletes = fixture.attached.size;
    const Chunk = [...fixture.attached][0].constructor;
    fixture.instance.dispose();

    const retry = make(); retry.instance.wanted = new Map([[tiles[1].id, tiles[1]]]);
    let acquisitions = 0, builds = 0, preparations = 0;
    retry.instance.prefetchElevation = () => {
      if (retry.instance.acquisitions.size || retry.instance.acquiringTile || retry.instance.ready || retry.attached.size) return;
      acquisitions++;
      retry.instance.acquisitions.set(tiles[1].id, { controller: new AbortController(), settled: true, result: Promise.resolve({ grid }) });
    };
    retry.instance.options.prepareSurfacePromotion = async () => {
      preparations++; const first = preparations === 1;
      return () => !first;
    };
    const create = Chunk.createAsync;
    try {
      Chunk.createAsync = (...args) => { builds++; return create.apply(Chunk, args); };
      await pumpUntil(retry, () => retry.attached.size === 1);
    } finally { Chunk.createAsync = create; }
    const published = retry.attached.size; retry.instance.dispose();
    mesh.geometry.dispose(); mesh.material.dispose();

    const hud = app.spatialHUD; hud.group.visible = true;
    const ownNow = Object.getOwnPropertyDescriptor(performance, 'now'), realNow = performance.now.bind(performance);
    let now = realNow();
    const initial = hud.getUploadDiagnostics().requests;
    hud.lastTextureUploadTime = now;
    try {
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
      hud.onPointerClick({ x: 200 / 1024, y: 1 - 250 / 768 });
      for (let i = 0; i < 720; i++) {
        now += 1000 / 720;
        hud.onPointerHover({ x: (i % 2 ? 50 : 300) / 1024, y: 1 - 440 / 768 });
        hud.onPointerDrag({ x: (53 + i / 720 * 918) / 1024, y: 1 - 250 / 768 });
        hud.update();
      }
      hud.onPointerRelease(); now += 85; hud.update();
    } finally {
      if (ownNow) Object.defineProperty(performance, 'now', ownNow); else delete performance.now;
      hud.lastTextureUploadTime = realNow();
    }
    const uploads = hud.getUploadDiagnostics().requests - initial;
    return { whileFirstPending, afterFirstCompletes, retry: { acquisitions, builds, preparations, published },
      hud: { uploads, logicalSourceBytes: uploads * 1024 * 768 * 4, finalProgress: hud.currentProgress, dirty: hud.dynamicDirty } };
  }, baseline);
  assert.equal(result.whileFirstPending, baseline ? 0 : 2);
  assert.equal(result.afterFirstCompletes, 3);
  assert.equal(result.retry.published, 1); assert.equal(result.retry.preparations, 2);
  assert.equal(result.retry.acquisitions, baseline ? 2 : 1); assert.equal(result.retry.builds, baseline ? 2 : 1);
  assert.ok(baseline ? result.hud.uploads >= 1000 : result.hud.uploads <= 13);
  assert.ok(Math.abs(result.hud.finalProgress - 719 / 720) < 1e-9); assert.equal(result.hud.dirty, false);
  assert.ok(workers > 0); assert.deepEqual(workerFallbackWarnings, []); assert.deepEqual(errors, []);
  fs.mkdirSync(out, { recursive: true });
  const evidence = { condition: 'Production desktop client and real terrain worker; injected synthetic DEM completions and imagery-publication invalidation. Deterministic 720-event HUD replay and controlled display clock. Not native frame performance, network timing, DEM accuracy or actual GPU transfer measurement.',
    baseline, build, entry, result, workers, workerFallbackWarnings, errors };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
} finally { await browser?.close(); server?.kill(); }
