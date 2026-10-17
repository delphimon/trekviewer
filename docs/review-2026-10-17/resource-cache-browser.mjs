import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_CACHE_URL ?? 'https://127.0.0.1:4198';
const out = path.resolve(process.env.TREK_CACHE_OUT ?? '.review-cache/resource-cache-browser'); fs.mkdirSync(out, { recursive: true });
let browser, server; const errors = [], requests = [];
try {
  if (!process.env.TREK_CACHE_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4198', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4198')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1233, height: 821 } });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (/USGSNAIPPlus\/ImageServer\/exportImage|imagery\.geoplatform\.gov/.test(url)) return route.abort('timedout');
    if (/nationalmap\.gov|elevation-tiles-prod|tiles\.maps\.eox/.test(url)) requests.push(url);
    return route.continue();
  });
  const ready = () => page.waitForFunction(() => !!window.__trekViewerApp?.activeTrek && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 180000 });
  await page.goto(`${base}/?profile=1`, { waitUntil: 'domcontentloaded' }); await ready();
  await page.evaluate(() => { const a = window.__trekViewerApp; a.flyoverController.setProgress(.3555875547854273); a.session.setProgress(.3555875547854273); });
  await page.click('#btnViewToggle');
  await page.waitForFunction(() => [...window.__trekViewerApp.activeTrek.imageryLOD.patches.values()].filter(p => p.zoom === 19 && p.mesh.visible && !p.isFading).length >= 32, null, { timeout: 180000 });
  const first = await page.evaluate(async () => {
    const app = window.__trekViewerApp; await app.resourceCache.flush();
    const patch = [...app.activeTrek.imageryLOD.patches.values()].find(p => p.zoom === 19 && p.mesh.visible && p.texture.image.dataset?.sourceUrl?.includes('/USGSNAIPImagery/'));
    if (!patch) throw Error('No actual fallback fine imagery');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.drawImage(patch.texture.image, 0, 0);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, 256, 256).data))].map(n => n.toString(16).padStart(2, '0')).join('');
    const source = patch.texture.image.dataset.sourceUrl;
    const blob = await app.resourceCache.read(source);
    if (!blob) throw Error('Fine source not committed');
    const rawHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
    const grid = app.activeTrek.terrainResult.demGrid;
    const elevationHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', grid.data))].map(n => n.toString(16).padStart(2, '0')).join('');
    const db = await new Promise(resolve => { const q = indexedDB.open('trekviewer-resources-v1', 1); q.onsuccess = () => resolve(q.result); });
    const metadata = await new Promise(resolve => { const q = db.transaction('metadata').objectStore('metadata').getAll(); q.onsuccess = () => resolve(q.result); }); db.close();
    return { key: patch.key, source, hash, rawHash, rawBytes: blob.size, elevationSource: grid.source, elevationHash,
      persistedElevationURLs: metadata.map(e => e.key).filter(url => url.includes('3DEPElevation/ImageServer/exportImage')),
      stats: await app.resourceCache.refreshStats(), build: await (await fetch('/build-info.json')).json() };
  });
  assert(first.stats.writes > 0 && first.stats.entries > 0 && first.stats.bytes <= first.stats.maxBytes);
  const beforeReload = requests.length;
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
  const sample = async () => page.evaluate(async key => {
    const app = window.__trekViewerApp;
    const [, z, x, y] = key.split(':');
    const image = await app.activeTrek.imageryLOD.constructor.loadPatchImage(+z, +x, +y, 'satellite');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, 256, 256).data))].map(n => n.toString(16).padStart(2, '0')).join('');
    await app.resourceCache.flush();
    return { hash, width: image.width, height: image.height, stats: await app.resourceCache.refreshStats() };
  }, first.key);
  const warm = await sample();
  const warmElevationHash = await page.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', window.__trekViewerApp.activeTrek.terrainResult.demGrid.data))].map(n => n.toString(16).padStart(2, '0')).join(''));
  assert(first.elevationSource.includes('USGS 3DEP')); assert(first.persistedElevationURLs.length > 0);
  assert.equal(warmElevationHash, first.elevationHash);
  assert.equal(requests.slice(beforeReload).filter(url => first.persistedElevationURLs.includes(url)).length, 0, 'Stored elevation rasters reuse source bytes');
  assert.equal(warm.hash, first.hash); assert.equal(warm.width, 256); assert.equal(warm.height, 256); assert(warm.stats.hits > 0);
  assert.equal(requests.slice(beforeReload).filter(url => url === first.source).length, 0, 'Reload uses IndexedDB source, with HTTP cache disabled');
  await page.click('#profile-start'); await page.waitForTimeout(1300); await page.click('#profile-stop');
  await page.waitForFunction(() => window.__trekViewerApp.profileSavedOnDevice, null, { timeout: 10000 });
  const profileCaches = await page.evaluate(() => window.__trekViewerApp.completedProfile.windows.map(w => ({ hits: w.resourceCacheHits, misses: w.resourceCacheMisses, writes: w.resourceCacheWrites, failed: w.resourceCacheWriteFailed })));
  assert(profileCaches.length > 0 && profileCaches.every(w => w.hits >= warm.stats.hits && w.failed === false));
  await page.evaluate(async url => { const cache = window.__trekViewerApp.resourceCache; cache.write(url, new Blob(['corrupt image'])); await cache.flush(); }, first.source);
  const beforeRecovery = requests.filter(url => url === first.source).length;
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
  const recovered = await sample(); assert.equal(recovered.hash, first.hash);
  assert.equal(requests.filter(url => url === first.source).length, beforeRecovery + 1, 'Corrupt encoded image refetched once');
  // Real IndexedDB transaction checks; synthetic metadata pressure avoids allocating 320 MiB of fixture bodies.
  const maintenance = await page.evaluate(async url => {
    const cache = window.__trekViewerApp.resourceCache;
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('trekviewer-resources-v1', 1); q.onsuccess = () => resolve(q.result); q.onerror = reject; });
    const fixture = url + '&cache-audit=';
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['metadata', 'bodies'], 'readwrite');
      for (const [key, bytes, accessed] of [['oldest', 128 * 1048576, 1], ['older', 128 * 1048576, 2], ['newer', 64 * 1048576, 3]]) {
        tx.objectStore('metadata').put({ key: fixture + key, bytes, accessed, created: Date.now(), expires: Date.now() + 60000 });
        tx.objectStore('bodies').put(new Blob(['fixture']), fixture + key);
      }
      tx.oncomplete = resolve; tx.onerror = reject;
    });
    cache.write(fixture + 'incoming', new Blob(['actual cache test payload'])); await cache.flush();
    const entries = await new Promise(resolve => { const q = db.transaction('metadata').objectStore('metadata').getAll(); q.onsuccess = () => resolve(q.result); });
    const oldestRemoved = !entries.some(e => e.key === fixture + 'oldest');
    const newerRetained = entries.some(e => e.key === fixture + 'newer');
    await new Promise(resolve => {
      const tx = db.transaction('metadata', 'readwrite');
      const q = tx.objectStore('metadata').get(fixture + 'incoming');
      q.onsuccess = () => tx.objectStore('metadata').put({ ...q.result, expires: 0 }); tx.oncomplete = resolve;
    });
    const expired = await cache.read(fixture + 'incoming');
    db.close();
    const oldGeneration = cache.getGeneration(); await cache.clear();
    cache.write(fixture + 'stale', new Blob(['stale']), oldGeneration); await cache.flush();
    return { oldestRemoved, newerRetained, bytes: entries.reduce((n, e) => n + e.bytes, 0), expiredIsNull: expired === null, afterClear: await cache.refreshStats() };
  }, first.source);
  assert(maintenance.oldestRemoved && maintenance.newerRetained && maintenance.expiredIsNull);
  assert(maintenance.bytes <= first.stats.maxBytes); assert.equal(maintenance.afterClear.entries, 0);
  await page.uncheck('#resourceCacheEnabled');
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
  assert.equal(await page.isChecked('#resourceCacheEnabled'), false);
  await page.click('#btnClearResourceCache');
  await page.waitForFunction(() => document.getElementById('resourceCacheStatus').textContent.includes('Saved data cleared.'), null, { timeout: 10000 });
  const final = await page.evaluate(() => ({ stats: window.__trekViewerApp.resourceCache.getStats(), glError: window.__trekViewerApp.sceneManager.renderer.getContext().getError(), savedProfileBuild: window.__trekViewerApp.completedProfile?.buildId }));
  assert.equal(final.stats.enabled, false); assert.equal(final.stats.entries, 0); assert.equal(final.glError, 0); assert.deepEqual(errors, []);
  assert.equal(final.savedProfileBuild, first.build.id, 'Clearing resources preserves the completed profile across reload');
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ condition: 'Actual Edge production WebGL and IndexedDB; HTTP cache disabled; preferred/GeoPlatform imagery requests deliberately aborted. No native XR claim.', first, warm, warmElevationHash, profileCaches, recovered, maintenance, final, errors }, null, 2));
  console.log(JSON.stringify({ first: first.stats, warm: warm.stats, recovered: recovered.stats, pixelHashesEqual: first.hash === warm.hash && warm.hash === recovered.hash, maintenance, final, errors }));
} finally { await browser?.close(); server?.kill(); }
