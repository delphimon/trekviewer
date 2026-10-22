import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { createHash } from 'node:crypto';
import * as Lerc from 'lerc';
import { checkOfflineArchiveImport } from './offline-archive-browser-check.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_OFFLINE_URL ?? 'https://127.0.0.1:4218/';
const out = process.env.TREK_OFFLINE_OUT ?? '.review-cache/offline-defaults';
fs.mkdirSync(out, { recursive: true });
const helper = path.resolve(out, 'helper'), entry = path.resolve(out, 'entry.ts');
fs.writeFileSync(entry, `export { OfflineStore, hashOfflineBlob } from ${JSON.stringify(path.resolve('src/offline/OfflineStore.ts'))};
export { OfflineDownloads } from ${JSON.stringify(path.resolve('src/offline/OfflineDownloads.ts'))};
export { PersistentResourceCache } from ${JSON.stringify(path.resolve('src/terrain/PersistentResourceCache.ts'))};
export { planOfflineRoute, sha256 } from ${JSON.stringify(path.resolve('src/offline/OfflinePlan.ts'))};
export { GPXParser } from ${JSON.stringify(path.resolve('src/gpx/GPXParser.ts'))};
export { disposeTerrainJobs } from ${JSON.stringify(path.resolve('src/terrain/TerrainJobs.ts'))};
export { inspectOfflineArchive, offlineArchiveSource, archiveInventoryHash } from ${JSON.stringify(path.resolve('src/offline/OfflineArchive.ts'))};
`);
await build({ configFile: false, base: './', logLevel: 'error', build: { outDir: helper, emptyOutDir: true, target: 'esnext',
  lib: { entry, formats: ['es'], fileName: () => 'offline-test.js' } } });
const expected = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
let browser, server;
try {
  if (!process.env.TREK_OFFLINE_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4218', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timed out')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4218')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  let external = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/__offline-test/')) {
      const file = path.resolve(helper, decodeURIComponent(url.pathname.slice('/__offline-test/'.length)));
      if (!file.startsWith(helper + path.sep)) return route.abort();
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
    }
    if (url.origin === new URL(base).origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external++; return route.abort();
  });
  await page.goto(base + '?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 60000 });
  const defaults = await page.locator('[data-offline-route]:checked').evaluateAll(elements => elements.map(el => el.dataset.offlineRoute));
  assert.deepEqual(defaults, ['rainier-emmons', 'enchantments-dragontail']);
  await page.evaluate(() => window.__trekViewerApp.sceneManager.renderer.setAnimationLoop(null));
  if (await page.locator('#btnSettings').isVisible()) await page.locator('#btnSettings').click();
  await page.locator('[data-offline-action="prepare"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-offline-action="download"]').disabled, null, { timeout: 20000 });
  const estimate = await page.locator('[data-offline-message]').textContent();
  const inventories = await page.evaluate(() => window.__trekViewerApp.overlay.offlineDownloads.plans.map(plan => ({ id: plan.id,
    routeId: plan.routeId, coverage: plan.coverage, maxZoom: plan.maxZoom, estimatedBytes: plan.estimatedBytes,
    sources: plan.resources.length, imagery: plan.resources.filter(r => r.kind === 'image').length, elevation: plan.resources.filter(r => r.kind === 'elevation').length,
    elevationBeforeImagery: plan.resources.slice(0, plan.resources.findIndex(r => r.kind === 'image')).every(r => r.kind === 'elevation')
      && plan.resources.slice(plan.resources.findIndex(r => r.kind === 'image')).every(r => r.kind === 'image') })));
  assert.deepEqual(inventories.map(row => row.sources), [5337, 8177]);
  assert.ok(inventories.every(row => row.elevationBeforeImagery));
  assert.ok(estimate.includes('Rainier:') && estimate.includes('Enchantments:') && estimate.includes('uncompressed budget')
    && estimate.includes('not required free space') && estimate.includes('GB'));
  console.log(JSON.stringify({ phase: 'default-estimates', estimate }));
  await page.screenshot({ path: path.join(out, 'settings.png') });
  await page.addScriptTag({ type: 'module', content: `import * as h from '/__offline-test/offline-test.js'; window.__offlineTest=h;` });
  await page.waitForFunction(() => !!window.__offlineTest);
  const planFingerprints = await page.evaluate(async () => Promise.all(window.__trekViewerApp.overlay.offlineDownloads.plans.map(async plan => ({
    routeId: plan.routeId, inventorySha256: await window.__offlineTest.archiveInventoryHash(plan) }))));
  for (const row of planFingerprints) {
    const pc = JSON.parse(fs.readFileSync(`.review-cache/portable-packs/inventory/${row.routeId}.inventory.json`, 'utf8'));
    if (row.inventorySha256 !== pc.inventorySha256) {
      const actual = await page.evaluate(id => window.__trekViewerApp.overlay.offlineDownloads.plans.find(p => p.routeId === id), row.routeId);
      const expected = JSON.parse(fs.readFileSync(`.review-cache/portable-packs/inventory/${row.routeId}.plan.json`, 'utf8'));
      const differences = actual.resources.flatMap((resource, index) => JSON.stringify(resource) === JSON.stringify(expected.resources[index]) ? [] : [{ index, browser: resource, pc: expected.resources[index] }]);
      fs.writeFileSync(path.join(out, 'plan-differences.json'), JSON.stringify({ routeId: row.routeId, differences: differences.slice(0, 5), totalDifferences: differences.length }, null, 2));
    }
    assert.equal(row.inventorySha256, pc.inventorySha256, 'Production browser and PC preparer must agree on the complete source contract');
  }
  const fixture = fs.readFileSync('test/fixtures/elevation/rainier-3dep-window.lerc').toString('base64');
  const fixtureMetadata = JSON.parse(fs.readFileSync('test/fixtures/elevation/rainier-3dep-window.json', 'utf8'));
  await Lerc.load({ locateFile: () => require.resolve('lerc/lerc-wasm.wasm') });
  const encodedBytes = Buffer.from(fixture, 'base64');
  const reference = Lerc.decode(encodedBytes.buffer.slice(encodedBytes.byteOffset, encodedBytes.byteOffset + encodedBytes.byteLength));
  const referenceHash = createHash('sha256').update(new Uint8Array(Float32Array.from(reference.pixels[0]).buffer)).digest('hex');
  const state = await page.evaluate(async ({ encoded, request }) => {
    const h = window.__offlineTest;
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#458945'; ctx.fillRect(0, 0, 256, 256); ctx.fillStyle = '#abcdef'; ctx.fillRect(20, 20, 90, 90);
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const dem = new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]);
    const imageUrl = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?fixture=offline-a';
    const secondUrl = imageUrl.replace('offline-a', 'offline-b');
    const resources = [{ kind: 'elevation', urls: [request.url], width: request.width, height: request.height },
      { kind: 'image', urls: [imageUrl], width: 256, height: 256 }, { kind: 'image', urls: [secondUrl], width: 256, height: 256 }];
    const plan = { id: 'controlled-storage-fixture-v1', routeId: 'controlled-fixture', routeHash: 'a'.repeat(64), name: 'Controlled storage fixture — not a full route',
      version: 1, coverage: 'full-model', maxZoom: 19, estimatedBytes: 1e6, resources };
    const nativeFetch = window.fetch.bind(window), calls = new Map(); let pauseSecond = true;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (resources.some(r => r.urls.includes(url))) {
        calls.set(url, (calls.get(url) ?? 0) + 1);
        if (url === secondUrl && pauseSecond) { h.OfflineDownloads.pause(); throw new DOMException('Paused', 'AbortError'); }
        return new Response(url === request.url ? dem : image);
      }
      return nativeFetch(input, init);
    };
    await h.OfflineDownloads.start(plan);
    const interrupted = await h.OfflineStore.state(plan.id);
    assert(interrupted.state === 'paused' && interrupted.completed === 2, 'Pause must retain exactly two committed sources');
    assert(await h.OfflineStore.read(imageUrl) === null, 'Staging must remain invisible');
    pauseSecond = false; await h.OfflineDownloads.start(plan);
    const ready = await h.OfflineStore.state(plan.id);
    assert(ready.state === 'ready' && ready.completed === 3, 'Resume must atomically publish all sources');
    assert(calls.get(request.url) === 1 && calls.get(imageUrl) === 1, 'Resume must not refetch validated source bytes');
    const resumeRequests = Object.fromEntries(calls);
    h.PersistentResourceCache.setEnabled(false);
    assert((await h.PersistentResourceCache.read(imageUrl))?.size === image.size, 'Pinned reads must ignore temporary-cache opt-out');
    await h.PersistentResourceCache.clear();
    assert((await h.PersistentResourceCache.read(request.url))?.size === dem.size, 'Temporary clear must retain pinned DEM');
    let badPublish = false;
    try { await h.OfflineStore.publish({ ...plan, id: 'missing-fixture' }, 3, 1); } catch { badPublish = true; }
    assert(badPublish && !await h.OfflineStore.state('missing-fixture'), 'Incomplete staging must never publish');
    let lockRejected = false;
    await navigator.locks.request('trekviewer-offline-download', async () => {
      try { await h.OfflineDownloads.withLock(async () => {}); } catch { lockRejected = true; }
    });
    assert(lockRejected, 'A second management operation must not run under a held browser lock');
    const encodedPlan = { ...plan, id: 'encoded-capacity-fixture', estimatedBytes: Number.MAX_SAFE_INTEGER };
    await h.OfflineDownloads.start(encodedPlan);
    const encodedReady = await h.OfflineStore.state(encodedPlan.id);
    assert(encodedReady.state === 'ready' && encodedReady.bytes === ready.bytes, 'Raw budget larger than quota must not block a fitting encoded pack');
    const nativeEstimate = navigator.storage.estimate.bind(navigator.storage);
    const requestsBeforeCapacity = [...calls.values()].reduce((sum, n) => sum + n, 0);
    navigator.storage.estimate = async () => ({ quota: 100e6, usage: 99e6 });
    let capacityRejected = false;
    try { await h.OfflineDownloads.start({ ...plan, id: 'capacity-fixture' }); } catch { capacityRejected = true; }
    const capacityState = await h.OfflineStore.state('capacity-fixture');
    assert(capacityRejected && capacityState.state === 'paused' && capacityState.completed === 0,
      'Low capacity must pause without committing any source');
    assert(requestsBeforeCapacity === [...calls.values()].reduce((sum, n) => sum + n, 0), 'Low capacity must stop before fetching');
    // Nothing new is needed: a complete staged pack can still verify/publish.
    await h.OfflineStore.putState({ ...encodedReady, state: 'paused' });
    await h.OfflineDownloads.start(encodedPlan);
    assert((await h.OfflineStore.state(encodedPlan.id)).state === 'ready', 'Full staging must publish without additional data quota');
    navigator.storage.estimate = nativeEstimate;
    const nativeCapacitySave = h.OfflineStore.save;
    h.OfflineStore.save = async (...args) => {
      await nativeCapacitySave.apply(h.OfflineStore, args);
      navigator.storage.estimate = async () => ({ quota: 100e6, usage: 99e6 });
    };
    const incrementalPlan = { ...plan, id: 'incremental-capacity-fixture' };
    let incrementalRejected = false;
    try { await h.OfflineDownloads.start(incrementalPlan); } catch { incrementalRejected = true; }
    finally { h.OfflineStore.save = nativeCapacitySave; navigator.storage.estimate = nativeEstimate; }
    const incrementalPaused = await h.OfflineStore.state(incrementalPlan.id);
    assert(incrementalRejected && incrementalPaused.state === 'paused' && incrementalPaused.completed === 1 && incrementalPaused.bytes === dem.size,
      'Capacity changing during a download must preserve exactly committed progress');
    const demCallsBeforeResume = calls.get(request.url);
    await h.OfflineDownloads.start(incrementalPlan);
    assert((await h.OfflineStore.state(incrementalPlan.id)).state === 'ready' && calls.get(request.url) === demCallsBeforeResume,
      'After freeing space, resume must reuse already committed terrain');
    for (const id of ['capacity-fixture', encodedPlan.id, incrementalPlan.id]) await h.OfflineDownloads.withLock(() => h.OfflineStore.remove(id));
    const nativeSave = h.OfflineStore.save;
    h.OfflineStore.save = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
    let quotaRejected = false;
    try { await h.OfflineDownloads.start({ ...plan, id: 'quota-fixture' }); } catch { quotaRejected = true; }
    finally { h.OfflineStore.save = nativeSave; }
    const quotaState = await h.OfflineStore.state('quota-fixture');
    assert(quotaRejected && quotaState.state === 'paused' && quotaState.completed === 0 && quotaState.bytes === 0, 'Failed write must not increment committed progress');
    await h.OfflineDownloads.withLock(() => h.OfflineStore.remove('quota-fixture'));
    window.fetch = nativeFetch;
    h.disposeTerrainJobs();
    window.__fixturePlan = plan;
    return { interrupted, ready, resumeSourceRequests: resumeRequests, temporaryCacheIndependent: true, missingPublishRejected: true,
      managementLockRejected: lockRejected, capacityRejected, encodedPackBelowRawBudget: true, fullStagingPublishesWithoutNewDataQuota: true,
      sharedUsageChangePausedAndResumed: true, incrementalPaused, quotaWritePreservedProgress: true, imageBytes: image.size, demBytes: dem.size };
  }, { encoded: fixture, request: fixtureMetadata.request });
  const archiveImport = await checkOfflineArchiveImport(page);
  let sw;
  try { sw = await page.evaluate(async () => {
    let timer;
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Offline shell installation timed out')), 30000); })]);
    clearTimeout(timer);
    return { active: registration.active?.scriptURL, cached: (await caches.keys()).filter(k => k.startsWith('trekviewer-shell-')) };
  }); } catch (error) {
    const diagnostic = await page.evaluate(async () => ({ status: document.getElementById('offlineShellStatus')?.textContent,
      registrations: (await navigator.serviceWorker.getRegistrations()).map(r => ({ active: r.active?.state, installing: r.installing?.state, waiting: r.waiting?.state })),
      caches: await caches.keys() }));
    fs.writeFileSync(path.join(out, 'shell-failure.json'), JSON.stringify({ build: expected, diagnostic, error: String(error) }, null, 2) + '\n');
    throw error;
  }
  assert.ok(sw.active?.endsWith('/sw.js')); assert.ok(sw.cached.some(key => key.endsWith(expected.id)));
  console.log(JSON.stringify({ phase: 'storage-validated', shell: expected.id }));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 60000 });
  const offline = await page.evaluate(async () => ({ build: await (await fetch('build-info.json')).json(),
    routes: document.querySelectorAll('#routeSelect option').length, controlled: !!navigator.serviceWorker.controller,
    selected: [...document.querySelectorAll('[data-offline-route]:checked')].map(el => el.dataset.offlineRoute) }));
  assert.equal(offline.build.id, expected.id); assert.equal(offline.routes, 8); assert.equal(offline.controlled, true);
  assert.deepEqual(offline.selected, defaults);
  const workerName = fs.readdirSync('dist/assets').find(name => /^TerrainWorker-.*\.js$/.test(name));
  const expectedWorkerHash = createHash('sha256').update(fs.readFileSync(path.join('dist/assets', workerName))).digest('hex');
  const offlineWorker = await page.evaluate(async ({ workerName, encoded, request }) => {
    const workerBytes = await (await fetch('assets/' + workerName)).arrayBuffer();
    const workerHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', workerBytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const worker = new Worker('assets/' + workerName, { type: 'module' });
    const message = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Offline worker timed out')), 10000);
      worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
      worker.onerror = error => { clearTimeout(timer); reject(error); };
    });
    try {
      if (!(await message()).ready) throw Error('Missing offline worker handshake');
      const input = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)).buffer;
      const next = message(); worker.postMessage({ kind: 'lerc', input: { buffer: input, width: request.width, height: request.height } }, [input]);
      const response = await next;
      if (response.error || response.result.validCount !== request.width * request.height || input.byteLength) throw Error('Offline LERC decode/transfer failed');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', response.result.data.buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
      return { workerName, workerHash, transferred: true, validCount: response.result.validCount, dataHash: hash };
    } finally { worker.terminate(); }
  }, { workerName, encoded: fixture, request: fixtureMetadata.request });
  assert.equal(offlineWorker.dataHash, referenceHash);
  assert.equal(offlineWorker.workerHash, expectedWorkerHash);
  await context.setOffline(false);
  await page.evaluate(() => window.__trekViewerApp.sceneManager.renderer.setAnimationLoop(null));
  await page.addScriptTag({ type: 'module', content: `import * as h from '/__offline-test/offline-test.js'; window.__offlineTest=h;` });
  await page.waitForFunction(() => !!window.__offlineTest);
  const damaged = await page.evaluate(async () => {
    const h = window.__offlineTest;
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('trekviewer-offline-packs-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const keyUrl = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?fixture=offline-a';
    await new Promise((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite'), r = tx.objectStore('assets').index('urls').get(keyUrl);
      r.onsuccess = () => tx.objectStore('assets').put({ ...r.result, blob: new Blob(['corrupt']) }); tx.oncomplete = resolve; tx.onerror = reject;
    }); db.close();
    const value = await h.OfflineStore.read(keyUrl), state = await h.OfflineStore.state('controlled-storage-fixture-v1');
    if (value !== null || state.state !== 'paused' || state.completed !== 2) throw Error('Corruption must unpublish and remove the broken source');
    await h.OfflineDownloads.withLock(() => h.OfflineStore.remove(state.id));
    if ((await h.OfflineStore.list()).some(row => row.id === state.id)) throw Error('Explicit removal failed');
    return { hashFailureUnpublished: true, retainedSources: state.completed, explicitRemoval: true };
  });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ condition: 'Production shell/default selections and generated helper built from the same source. Controlled three-source storage fixture, real lossless Rainier decoder fixture, actual IndexedDB/Web Locks/Canvas/worker. Network-disabled app shell/catalogue startup uses existing fallbacks; this does not establish full offline High terrain, multi-GB acquisition, installed APK or native acceptance.',
    build: expected, defaults, estimate, inventories, planFingerprints, state, archiveImport, sw, offline, offlineWorker, damaged, externalAborted: external, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ build: expected.id, defaults, passed: true, out }));
} finally { await browser?.close(); server?.kill(); }
