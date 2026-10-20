import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_CANCEL_OUT ?? '.review-cache/imagery-cancellation');
fs.mkdirSync(out, { recursive: true });
const port = 4203, base = `http://127.0.0.1:${port}`;
const baseline = process.env.TREK_CANCEL_BASELINE === '1';
const connections = [], errors = [];
let png, browser;
const entry = path.join(out, 'entry.mjs');
fs.writeFileSync(entry, `import {TileImageCache} from ${JSON.stringify(path.resolve('src/terrain/TileImageCache.ts').replaceAll('\\', '/'))};
import {PersistentResourceCache} from ${JSON.stringify(path.resolve('src/terrain/PersistentResourceCache.ts').replaceAll('\\', '/'))};
window.cache=TileImageCache; window.disk=PersistentResourceCache;`);
await build({ configFile: false, logLevel: 'warn', plugins: baseline ? [{ name: 'previous-cache', load(id) {
  if (id.replaceAll('\\', '/').endsWith('/src/terrain/TileImageCache.ts')) {
    return execFileSync('git', ['show', 'c9336fa:src/terrain/TileImageCache.ts'], { encoding: 'utf8' });
  }
} }] : [], build: { outDir: out, emptyOutDir: false, minify: false,
  lib: { entry, formats: ['es'], fileName: () => 'fixture.js' } } });
const server = createServer((request, response) => {
  const url = new URL(request.url, base);
  if (url.pathname === '/__harness__') {
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Imagery cancellation fixture</title><script type="module" src="/fixture.js"></script>'); return;
  }
  if (url.pathname === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(out, 'fixture.js'))); return; }
  if (!url.pathname.startsWith('/__image__/')) { response.writeHead(404); response.end(); return; }
  const id = url.searchParams.get('fixture');
  const record = { id, started: Date.now(), closed: null, finished: false };
  connections.push(record);
  const timer = setTimeout(() => {
    record.finished = true;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'image/png'); response.end(png);
  }, id.endsWith('-old') ? 6000 : 25);
  response.on('close', () => { record.closed = Date.now(); clearTimeout(timer); });
});

const until = async (predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Connection observation timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const results = [];
try {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true, args: [] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  // Redirect only the reviewed-cache URL to this local server. No live imagery
  // is contacted; fetch follows the redirect and cancellation reaches its socket.
  await page.route('https://imagery.nationalmap.gov/**', route => {
    const id = new URL(route.request().url()).searchParams.get('fixture');
    return route.fulfill({ status: 302, headers: { location: `${base}/__image__/?fixture=${id}`, 'access-control-allow-origin': '*' } });
  });
  await page.goto(`${base}/__harness__`);
  await page.waitForFunction(() => !!window.cache && !!window.disk);
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 512, 256);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  png = Buffer.from(data, 'base64');
  for (const kind of ['image', 'persisted-shared-raster']) {
    console.log(`Checking ${kind}`);
    await page.evaluate(async ({ kind }) => {
      window.cache.clear(); await window.disk.clear(); window.disk.setEnabled(true);
      const raster = kind !== 'image';
      window.provider = { id: kind, displayName: 'controlled fixture', attribution: '', maxZoom: 19,
        getTileUrls: (_z, x) => [raster
          ? `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?fixture=${kind}-${x < 2 ? 'old' : 'current'}`
          : `${location.origin}/__image__/?fixture=${kind}-${x < 2 ? 'old' : 'current'}`],
        ...(raster ? { getTileImageRegion: (_z, x) => ({ x: (x % 2) * 256, y: 0, width: 256, height: 256 }) } : {}) };
      window.a = new AbortController(); window.b = new AbortController(); window.outcomes = [];
      const load = (x, signal) => window.cache.loadTile(window.provider, 19, x, 0, 10000, signal)
        .then(() => window.outcomes.push('unexpected success'), error => window.outcomes.push(error.name));
      window.pending = [load(0, a.signal), load(raster ? 1 : 0, b.signal)];
    }, { kind, port });
    await until(() => connections.some(c => c.id === `${kind}-old`));
    const old = connections.find(c => c.id === `${kind}-old`);
    await page.evaluate(() => a.abort());
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(old.closed, null, 'Remaining consumer must keep the physical connection alive');
    const cancelledAt = Date.now();
    await page.evaluate(() => b.abort());
    if (baseline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(old.closed, null, 'Negative control: the previous cache leaves the abandoned connection open');
    } else {
      await until(() => old.closed !== null);
      assert.equal(old.finished, false, 'The old connection must close before its delayed response');
    }
    const current = await page.evaluate(async () => {
      const start = performance.now();
      await Promise.all(window.pending);
      const image = await window.cache.loadTile(window.provider, 19, 2, 0, 10000);
      const result = { outcomes: window.outcomes, currentMs: performance.now() - start, width: image.width,
        height: image.height, stats: window.cache.getStats() };
      if (image instanceof HTMLCanvasElement) result.pixel = [...image.getContext('2d').getImageData(0, 0, 1, 1).data];
      await window.disk.flush();
      return result;
    });
    assert.deepEqual(current.outcomes, baseline ? ['Error', 'Error'] : ['AbortError', 'AbortError']);
    assert.equal(current.stats.failureCount, 0); assert.equal(current.stats.negativeCacheSize, 0);
    assert.ok(current.currentMs < 2000, 'Current work must finish before the six-second old response');
    assert.equal(current.height, 256);
    if (kind !== 'image') { assert.equal(current.width, 256); assert.deepEqual(current.pixel, [18, 52, 86, 255]); }
    assert.equal(connections.filter(c => c.id === `${kind}-old`).length, 1, 'Consumers must share one physical request');
    if (baseline) {
      await until(() => old.finished, 8000);
      await page.waitForFunction(() => window.cache.size() > 1);
    }
    results.push({ kind, ...current, abandonedResponseCompleted: old.finished,
      physicalCancelMs: baseline ? null : old.closed - cancelledAt });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ baseline, results, connections, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ baseline, results, errors }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
