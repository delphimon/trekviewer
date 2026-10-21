import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_STABILITY_URL ?? 'https://127.0.0.1:4215/';
const out = process.env.TREK_STABILITY_OUT ?? '.review-cache/terrain-stability';
const expected = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
const entry = path.posix.basename(fs.readFileSync('dist/index.html', 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
const route = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8')).find(row => row.id === 'olympus-bailey-2026');
fs.mkdirSync(out, { recursive: true });
let browser, server;
try {
  if (!process.env.TREK_STABILITY_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4215', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4215')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 }, userAgent: 'TrekViewer desktop live-source audit (Quest geometry budget)' });
  const errors = [], glErrors = [], requests = new Map();
  page.on('pageerror', () => errors.push('Page exception'));
  page.on('console', message => { if (/INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM|Shader Error/.test(message.text())) glErrors.push('GL error'); });
  page.on('request', request => { const url = new URL(request.url()); if (url.hostname === 'elevation.nationalmap.gov' && url.pathname.endsWith('/exportImage')) requests.set(url.href, (requests.get(url.href) ?? 0) + 1); });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__stabilityBuilds = [];
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        if (message.kind === 'chunk') window.__stabilityBuilds.push({ id: message.options.layout.id, timeMs: performance.now() });
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.route('**/routes/manifest.json', request => request.fulfill({ contentType: 'application/json', body: JSON.stringify([route]) }));
  await page.goto(base + '?profile=1&terrainImagery=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 120000 });
  const build = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
  assert.equal(build.id, expected.id); assert.ok(await page.evaluate(entry => [...document.scripts].some(s => s.src.endsWith('/' + entry)), entry));
  await page.evaluate(() => {
    const terrain = window.__trekViewerApp.activeTrek.terrainResult, grid = terrain.baseMeshGrid;
    window.__stabilityLifecycle = [];
    for (const method of ['attachLocalChunk', 'detachLocalChunk']) {
      const original = terrain[method];
      terrain[method] = function (chunk) {
        if (chunk) { const b = chunk.getSurfaceBounds(); window.__stabilityLifecycle.push({ method, id: `${Math.round((b.minX + grid.width / 2) / (grid.width / grid.segmentsX * 8))}:${Math.round((b.minZ + grid.depth / 2) / (grid.depth / grid.segmentsZ * 8))}`, timeMs: performance.now() }); }
        return original.apply(this, arguments);
      };
    }
  });
  const samples = [];
  for (let i = 0; i <= 18; i++) {
    if (i) await page.waitForTimeout(5000);
    const sample = await page.evaluate(() => {
      const app = window.__trekViewerApp, streamer = app.activeTrek.localTerrainStreamer, terrain = app.activeTrek.terrainResult;
      return { timeMs: performance.now(), playing: app.session.getState().isPlaying, progress: app.session.getState().progress,
        camera: app.sceneManager.camera.matrixWorld.elements.slice(), model: app.sceneManager.dioramaRoot.matrixWorld.elements.slice(),
        wanted: [...streamer.wanted.keys()].sort(), loaded: [...streamer.chunks.keys()].sort(),
        focus: streamer.localFocus, detailFocusKey: streamer.detailFocusKey, focusChanges: streamer.focusChanges,
        acquiring: streamer.acquisitions.size, busy: streamer.busy, revision: terrain.surfaceRevision,
        builds: window.__stabilityBuilds.length, publications: window.__stabilityLifecycle.filter(row => row.method === 'attachLocalChunk').length,
        removals: window.__stabilityLifecycle.filter(row => row.method === 'detachLocalChunk').length,
        counters: app.getDiagnostics?.() ?? null };
    });
    samples.push(sample); console.log(JSON.stringify({ seconds: i * 5, wanted: sample.wanted.length, loaded: sample.loaded.length, builds: sample.builds, publications: sample.publications, removals: sample.removals, focusChanges: sample.focusChanges }));
  }
  const audit = await page.evaluate(() => ({ builds: window.__stabilityBuilds, lifecycle: window.__stabilityLifecycle }));
  const warm = samples[6], settled = samples.slice(6);
  const repeatCount = events => events.length - new Set(events.map(row => row.id)).size;
  const result = { condition: 'Public-source Olympus paused desktop overview, Quest geometry budget, no camera/model/input motion, 30 s warmup followed by 60 s observation. No render-comparison stress, no native XR claim.',
    build, entry, samples, audit,
    summary: { observationSeconds: 60, builds: samples.at(-1).builds - warm.builds, publications: samples.at(-1).publications - warm.publications,
      removals: samples.at(-1).removals - warm.removals, planChanges: samples.at(-1).focusChanges - warm.focusChanges,
      repeatedBuilds: repeatCount(audit.builds.filter(row => row.timeMs > warm.timeMs)),
      cameraMovement: Math.max(...settled.map(row => Math.max(...row.camera.map((value, i) => Math.abs(value - warm.camera[i]))))),
      modelMovement: Math.max(...settled.map(row => Math.max(...row.model.map((value, i) => Math.abs(value - warm.model[i]))))) },
    elevationRequestEvents: { total: [...requests.values()].reduce((a, b) => a + b, 0), unique: requests.size }, errors, glErrors };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ summary: result.summary }));
  assert.ok(samples.every(row => !row.playing)); assert.equal(result.summary.cameraMovement, 0); assert.equal(result.summary.modelMovement, 0);
  assert.deepEqual(errors, []); assert.deepEqual(glErrors, []);
} finally { await browser?.close(); server?.kill(); }
