// Bounded real-source audit, NOT a complete pack download. Run with Node's
// --experimental-transform-types. No private configuration or app storage used.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { DEFAULT_OFFLINE_ROUTES, planOfflineRoute } = await import('../src/offline/OfflinePlan.ts');
const { offlineSourceAllowed } = await import('../src/offline/OfflineStore.ts');
const { readBoundedBlob } = await import('../src/terrain/PersistentResourceCache.ts');
const { latLonToTile } = await import('../src/gpx/Coordinates.ts');
const { PublicImageryProvider } = await import('../src/terrain/providers/PublicImageryProvider.ts');
const { resolveChromium, resolveLaunchOptions } = await import('./playwright-launch.mjs');
const chromium = resolveChromium();
const out = path.resolve(process.env.TREK_OFFLINE_PROBE_OUT ?? '.review-cache/offline-real-defaults');
const helper = path.join(out, 'helper'), bodies = path.join(out, 'bodies');
fs.mkdirSync(bodies, { recursive: true });
const entry = path.join(out, 'entry.ts');
fs.writeFileSync(entry, `export { validateOfflineResource } from ${JSON.stringify(path.resolve('src/offline/OfflineDownloads.ts'))};
export { disposeTerrainJobs } from ${JSON.stringify(path.resolve('src/terrain/TerrainJobs.ts'))};`);
await build({ configFile: false, base: './', logLevel: 'error', build: { outDir: helper, emptyOutDir: true, target: 'esnext',
  lib: { entry, formats: ['es'], fileName: () => 'validation.js' } } });
const manifest = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8'));
const provider = new PublicImageryProvider(), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = fs.existsSync(path.join(out, 'probe.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'probe.json'), 'utf8')) : null;
const retainedHashes = new Map(previous?.results.flatMap(r => r.samples.flatMap(s => s.attempts.filter(a => a.passed).map(a => [a.url, a]))) ?? []);
const report = { generatedAt: new Date().toISOString(), appBuild: JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8')),
  sourceCommit: process.env.TREK_OFFLINE_PROBE_COMMIT ?? null,
  condition: 'At most eight actual planned sources per default route: full-model overview DEM, first/middle/last local DEM, Z16 overview and Z17/18/19 route imagery. One acquisition/validation lane; approved public sources only, 35 seconds and 32 MiB/DEM or 8 MiB/image per attempt. Node fetch and production browser worker/Canvas validators. Not a complete coverage audit, final pack size, source-native bake, installed APK or native performance test.',
  encoding: 'Original lossless PNG and zero-tolerance Float32 LERC, without resampling/re-encoding. Local encoded source cache only; no browser pack publication.',
  results: [] };
let browser, server;
try {
  server = http.createServer((request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); return response.end('<!doctype html><title>Offline source validation</title>'); }
      const file = path.resolve(helper, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      if (!file.startsWith(helper + path.sep) || !fs.statSync(file).isFile()) throw Error('Not found');
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      response.end(fs.readFileSync(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(resolveLaunchOptions());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.addScriptTag({ type: 'module', content: "import * as h from '/validation.js'; window.__validation=h;" });
  await page.waitForFunction(() => !!window.__validation);
  for (const id of DEFAULT_OFFLINE_ROUTES) {
    const route = manifest.find(r => r.id === id), xml = fs.readFileSync('public' + route.file, 'utf8').replace(/\r\n?/g, '\n');
    const track = GPXParser.parse(xml), plan = planOfflineRoute(track, id, sha(xml));
    const dem = plan.resources.filter(r => r.kind === 'elevation');
    const chosen = [{ label: 'overview-dem', resource: dem[0] }, { label: 'first-local-dem', resource: dem[1] },
      { label: 'middle-local-dem', resource: dem[Math.floor(dem.length / 2)] }, { label: 'last-local-dem', resource: dem.at(-1) }];
    for (const [zoom, fraction] of [[16, 0.5], [17, 0], [18, 0.5], [19, 1]]) {
      const point = track.points[Math.round((track.points.length - 1) * fraction)], tile = latLonToTile(point.lat, point.lon, zoom);
      const urls = provider.getTileUrls(zoom, tile.x, tile.y);
      const resource = plan.resources.find(r => r.kind === 'image' && r.urls.includes(urls[0]));
      assert.ok(resource, 'Sample must belong to the actual complete plan');
      chosen.push({ label: `imagery-z${zoom}`, resource });
    }
    assert.equal(new Set(chosen.map(s => s.resource.urls[0])).size, 8);
    const result = { id, planId: plan.id, routeHash: plan.routeHash, totalSources: plan.resources.length,
      uncompressedBudgetBytes: plan.estimatedBytes, samples: [] };
    report.results.push(result);
    for (const sample of chosen) {
      assert.ok(sample.resource.urls.every(offlineSourceAllowed));
      const record = { ...sample, attempts: [], passed: false }; result.samples.push(record);
      for (const url of sample.resource.urls) {
        const began = performance.now(), filename = path.join(bodies, sha(url) + '.bin');
        let cached = false;
        try {
          const limit = sample.resource.kind === 'image' ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
          let bytes;
          if (fs.existsSync(filename) && retainedHashes.has(url)) {
            assert.ok(fs.statSync(filename).size <= limit); bytes = fs.readFileSync(filename); cached = true;
            assert.equal(bytes.length, retainedHashes.get(url).bytes);
            assert.equal(sha(bytes), retainedHashes.get(url).sha256, 'Retained source hash changed');
          } else {
            assert.notEqual(process.env.TREK_OFFLINE_PROBE_CACHE_ONLY, '1', 'Source missing from verified local cache');
            const response = await fetch(url, { signal: AbortSignal.timeout(35000), redirect: 'error', credentials: 'omit' });
            bytes = Buffer.from(await (await readBoundedBlob(response, limit)).arrayBuffer());
          }
          const validation = await page.evaluate(async ({ resource, encoded }) => {
            const blob = new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]);
            const began = performance.now();
            await window.__validation.validateOfflineResource(resource, blob);
            return { elapsedMs: performance.now() - began, coverage: resource.kind === 'image' ? 'all alpha pixels opaque' : resource.requiredWindow ? 'all required support samples valid' : 'all raster samples valid' };
          }, { resource: sample.resource, encoded: bytes.toString('base64') });
          if (!cached) fs.writeFileSync(filename, bytes);
          record.attempts.push({ url, cached, passed: true, bytes: bytes.length, sha256: sha(bytes), elapsedMs: performance.now() - began, validation });
          record.passed = true; break;
        } catch (error) { record.attempts.push({ url, cached, passed: false, elapsedMs: performance.now() - began, error: String(error.message) }); }
      }
      fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ route: id, sample: sample.label, passed: record.passed, bytes: record.attempts.at(-1)?.bytes ?? null }));
    }
  }
  await page.evaluate(() => window.__validation.disposeTerrainJobs());
  assert.deepEqual(errors, []);
  report.passed = report.results.every(r => r.samples.every(s => s.passed));
  report.validatedBytes = report.results.reduce((sum, r) => sum + r.samples.reduce((n, s) => n + (s.attempts.find(a => a.passed)?.bytes ?? 0), 0), 0);
  fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, validatedBytes: report.validatedBytes, out }));
  if (!report.passed) process.exitCode = 1;
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
