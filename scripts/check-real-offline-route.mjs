import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { preparedArchiveReadiness, verifiedArchiveResult, acquisitionQueueState } from './offline-pack-readiness.mjs';
import { writePackProgress } from './offline-pack-progress.mjs';
for (const arg of process.argv.slice(2)) assert.ok(['--preflight', '--wait', '--tour-only', '--inspect-only'].includes(arg), `Unknown option ${arg}`);
const routeId = process.env.TREK_REAL_ROUTE ?? 'rainier-emmons';
assert.ok(['rainier-emmons', 'enchantments-dragontail'].includes(routeId));
const preflight = process.argv.includes('--preflight'), wait = process.argv.includes('--wait');
const inspectOnly = process.argv.includes('--inspect-only'), tourOnly = process.argv.includes('--tour-only') || inspectOnly;
const out = path.resolve(process.env.TREK_REAL_OUT ?? `.review-cache/real-route-offline/${routeId}`);
const profile = path.resolve('.review-cache/real-route-offline/browser-profile');
const base = process.env.TREK_REAL_URL ?? 'https://trekviewer.surge.sh/';
const origin = new URL(base).origin, packs = '.review-cache/prepared-route-packs/output', verification = '.review-cache/verified-route-packs';
const expected = JSON.parse(fs.readFileSync('dist/build-info.json'));
assert.equal(execFileSync('git', ['diff', '--name-only', expected.sha, '--', 'src', 'public', 'package.json', 'vite.config.ts'], { encoding: 'utf8' }).trim(), '',
  'Diagnostic helper and published app must use the same runtime source');
const expectedEntry = path.posix.basename(fs.readFileSync('dist/index.html', 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
fs.mkdirSync(out, { recursive: true });
const status = async value => { await writePackProgress(path.join(out, 'progress.json'), { ...value, pid: process.pid, routeId, updated: new Date().toISOString() }); console.log(JSON.stringify(value)); };
const lock = path.resolve('.review-cache/real-route-offline/acceptance.lock'), stopFile = path.resolve('.review-cache/real-route-offline/acceptance.stop');
assert.ok(!fs.existsSync(stopFile), 'Acceptance pause marker exists');
const fd = fs.openSync(lock, 'wx');
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, routeId, started: new Date().toISOString() }));
let context, page; const errors = [], external = []; let stage = 'initial';
const controller = new AbortController(), checkpoint = () => { if (fs.existsSync(stopFile)) controller.abort(); controller.signal.throwIfAborted(); };
controller.signal.addEventListener('abort', () => { void context?.close().catch(() => {}); });
const poll = setInterval(() => { if (fs.existsSync(stopFile)) controller.abort(); }, 500); poll.unref();
try {
let ready, certificate;
if (!preflight) {
  while (true) {
    checkpoint();
    ready = preparedArchiveReadiness(packs, routeId);
    if (ready.ready) {
      try { certificate = verifiedArchiveResult(verification, ready, 0); break; } catch { /* Wait for the independent full-file verifier. */ }
    }
    let verifierState;
    try { verifierState = JSON.parse(fs.readFileSync(path.join(verification, 'defaults.verification.progress.json'))); } catch {}
    const failure = verifierState?.results?.find(result => result.routeId === routeId && result.state === 'failed');
    if (failure) throw Error('Independent archive verification failed: ' + failure.error);
    const sourceState = acquisitionQueueState(packs);
    if (!wait || (!ready.ready && ['failed', 'paused', 'unfinished', 'complete'].includes(sourceState))) throw Error('No complete independently verified archive is available');
    await status({ phase: 'waiting-verified-archive', publicationReady: ready.ready, acquisitionState: sourceState });
    await delay(30000, undefined, { signal: controller.signal });
  }
}
const helperRoot = path.join(out, 'helper'), entry = path.join(out, 'entry.ts');
fs.writeFileSync(entry, `export { OfflineStore } from ${JSON.stringify(path.resolve('src/offline/OfflineStore.ts'))};\nexport { PersistentResourceCache } from ${JSON.stringify(path.resolve('src/terrain/PersistentResourceCache.ts'))};`);
await build({ configFile: false, logLevel: 'error', build: { outDir: helperRoot, emptyOutDir: true, target: 'esnext',
  lib: { entry, formats: ['iife'], name: 'TrekRealOffline', fileName: () => 'helper.js' } } });
const helper = fs.readFileSync(path.join(helperRoot, 'helper.js'), 'utf8');
const { resolveChromium, resolveLaunchOptions } = await import('./playwright-launch.mjs');
const chromium = resolveChromium();
async function boot(offline = false) {
  checkpoint();
  context = await chromium.launchPersistentContext(profile, resolveLaunchOptions({
    viewport: { width: 1100, height: 820 }, userAgent: 'TrekViewer PC offline acceptance (Quest geometry budget)' }));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) external.push({ stage, host: url.hostname });
  });
  await context.setOffline(offline);
  page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', error => errors.push({ stage, message: String(error) }));
  await page.goto(base + '?profile=1', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 120000 });
  if (routeId !== 'rainier-emmons') {
    await page.locator('#routeSelect').selectOption(routeId);
    await page.waitForFunction(id => { const s = window.__trekViewerApp.session.getState(); return s.activeRouteId === id && s.loadingPhase === 'ready'; }, routeId, { timeout: 120000 });
  }
  const observed = await page.evaluate(async () => (await fetch('build-info.json')).json());
  assert.equal(observed.id, expected.id);
  assert.ok(await page.evaluate(name => [...document.scripts].some(s => s.src.endsWith('/' + name)), expectedEntry));
  await page.addScriptTag({ content: helper });
  await page.waitForFunction(() => !!window.TrekRealOffline?.OfflineStore);
  if (await page.locator('#btnSettings').isVisible()) await page.locator('#btnSettings').click();
  await page.waitForFunction(() => !!document.querySelector('[data-offline-file]'));
}
async function state() { return page.evaluate(id => window.TrekRealOffline.OfflineStore.state(id), ready.inventory.planId); }
async function audit(prefix = []) {
  await page.evaluate(({ planId, prefix }) => {
    const native = IDBObjectStore.prototype.put, seen = new Set(), previous = new Set(prefix);
    window.__packPutAudit = { keys: [], duplicateRequests: 0, retainedPrefixRewriteRequests: 0 };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.transaction.db.name === 'trekviewer-offline-packs-v1' && this.name === 'assets' && value.packId === planId) {
        const audit = window.__packPutAudit;
        if (seen.has(value.key)) audit.duplicateRequests++;
        if (previous.has(value.key)) audit.retainedPrefixRewriteRequests++;
        seen.add(value.key); audit.keys.push(value.key);
      }
      return native.call(this, value, ...args);
    };
  }, { planId: ready.inventory.planId, prefix });
}
async function importUntilPause() {
  await page.locator('[data-offline-file]').setInputFiles(ready.file);
  const deadline = Date.now() + 45 * 60 * 1000;
  let last = 0;
  while (Date.now() < deadline) {
    checkpoint();
    const current = await state();
    if (current?.completed >= 128) {
      await page.locator('[data-offline-action="pause"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-offline-action="import"]').disabled, null, { timeout: 60000 });
      const paused = await state(); assert.equal(paused.state, 'paused');
      assert.ok(paused.completed < paused.total); return paused;
    }
    const controls = await page.locator('[data-offline-action="import"]').isEnabled();
    if (current?.state === 'paused' && controls) throw Error(current.message);
    if (Date.now() - last > 10000) { await status({ phase: 'importing-prefix', state: current }); last = Date.now(); }
    await delay(1000);
  }
  throw Error('Prefix import timed out');
}
  await status({ phase: preflight ? 'preflight-startup' : 'import-startup', build: expected.id });
  await boot();
  await page.evaluate(() => window.__trekViewerApp.sceneManager.renderer.setAnimationLoop(null));
  const shell = await page.evaluate(async () => {
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(Error('Shell readiness timed out')), 90000))]);
    return { active: registration.active?.scriptURL, keys: await caches.keys() };
  });
  assert.ok(shell.keys.some(key => key.endsWith(expected.id)));
  if (preflight) {
    const result = { condition: 'Harness startup/selectors/inline diagnostic helper and exact cached shell only. No route archive was imported or accepted.', build: expected.id, entry: expectedEntry, routeId, shell, errors };
    fs.writeFileSync(path.join(out, 'preflight.json'), JSON.stringify(result, null, 2));
    await status({ phase: 'preflight-passed' });
  } else {
    let imported;
    if (tourOnly) {
      imported = JSON.parse(fs.readFileSync(path.join(out, 'import.json')));
      const saved = await state();
      assert.equal(saved.state, 'ready'); assert.equal(saved.completed, ready.inventory.sources);
      assert.equal(saved.bytes, certificate.originalSourceBytes);
      assert.equal(imported.ready.id, saved.id); assert.equal(imported.ready.bytes, saved.bytes);
    } else {
    assert.equal(await state(), undefined, 'Use a fresh isolated target-route profile; existing data must not silently bypass interruption acceptance');
    const before = await page.evaluate(() => navigator.storage.estimate());
    await audit(); stage = 'import-prefix';
    const paused = await importUntilPause();
    const firstAudit = await page.evaluate(() => window.__packPutAudit);
    assert.equal(firstAudit.keys.length, paused.completed); assert.equal(firstAudit.duplicateRequests, 0);
    const invisible = await page.evaluate(async urls => (await window.TrekRealOffline.OfflineStore.read(urls[0])) === null,
      JSON.parse(fs.readFileSync(path.join(packs, routeId + '.plan.json'))).resources[0].urls);
    assert.equal(invisible, true);
    fs.writeFileSync(path.join(out, 'paused.json'), JSON.stringify({ paused, assetPutRequests: firstAudit.keys.length, stagingInvisible: invisible }, null, 2));
    await context.close(); context = undefined;
    stage = 'resume-startup'; await boot();
    await page.evaluate(() => window.__trekViewerApp.sceneManager.renderer.setAnimationLoop(null));
    const retained = await state(); assert.equal(retained.completed, paused.completed); assert.equal(retained.bytes, paused.bytes);
    await audit(firstAudit.keys); stage = 'import-resume';
    await page.locator('[data-offline-file]').setInputFiles(ready.file);
    const deadline = Date.now() + 90 * 60 * 1000; let last = 0, completed;
    while (Date.now() < deadline) {
      checkpoint();
      completed = await state();
      if (completed?.state === 'ready') break;
      if (completed?.state === 'paused' && await page.locator('[data-offline-action="import"]').isEnabled()) throw Error(completed.message);
      if (Date.now() - last > 10000) { await status({ phase: 'importing-resume', state: completed }); last = Date.now(); }
      await delay(1000);
    }
    assert.equal(completed.state, 'ready'); assert.equal(completed.completed, ready.inventory.sources); assert.equal(completed.bytes, certificate.originalSourceBytes);
    const resumedAudit = await page.evaluate(() => window.__packPutAudit);
    assert.equal(resumedAudit.retainedPrefixRewriteRequests, 0); assert.equal(resumedAudit.duplicateRequests, 0);
    assert.equal(resumedAudit.keys.length + firstAudit.keys.length, ready.inventory.sources);
    await page.waitForFunction(() => !document.querySelector('[data-offline-action="import"]').disabled, null, { timeout: 60000 });
    await page.evaluate(() => window.TrekRealOffline.PersistentResourceCache.clear());
    assert.equal((await state()).state, 'ready');
    const after = await page.evaluate(() => navigator.storage.estimate());
    imported = { paused, ready: completed, retainedAcrossBrowserRestart: true, stagedInvisible: true, prefixRewriteRequests: 0,
      totalAssetPutRequests: firstAudit.keys.length + resumedAudit.keys.length, temporaryClearRetainedPack: true, storageBefore: before, storageAfter: after };
    fs.writeFileSync(path.join(out, 'import.json'), JSON.stringify(imported, null, 2));
    }
    await context.close(); context = undefined;
    stage = 'offline-startup'; const externalBefore = external.length; await boot(true);
    const cold = await page.evaluate(() => { const app = window.__trekViewerApp; return { build: document.getElementById('offlineShellStatus')?.textContent,
      controlled: !!navigator.serviceWorker.controller, session: { activeRouteId: app.session.getState().activeRouteId,
        terrainQuality: app.session.getState().terrainQuality, qualityProfile: app.session.getState().qualityProfile },
      dem: app.activeTrek.terrainResult.demGrid && { source: app.activeTrek.terrainResult.demGrid.source, isRealDEM: app.activeTrek.terrainResult.demGrid.isRealDEM } }; });
    assert.equal(cold.controlled, true); assert.equal(cold.session.activeRouteId, routeId);
    assert.equal(cold.session.terrainQuality, 'dem'); assert.equal((await state()).state, 'ready');
    if (inspectOnly) {
      stage = 'offline-inspection'; const checkpoints = [];
      for (const progress of [.15, .5, .85]) {
        const started = Date.now();
        await page.locator('#scrubberInput').evaluate((input, progress) => { input.value = String(progress * 100); input.dispatchEvent(new Event('input', { bubbles: true })); }, progress);
        await page.evaluate(() => {
          const app = window.__trekViewerApp; app.session.setFollowRoute(false);
          // Inspect nearby ground through the normal camera, outside the large
          // overview beacon. Keep the marker, trail and all renderer budgets.
          const terrain = app.activeTrek.terrainResult;
          const local = app.activeTrek.trailResult.hikerMarker.position.clone(); local.x += 500;
          local.y = terrain.sampleRenderedSurfaceY(local.x, local.z) * terrain.getVerticalExaggeration();
          const bounds = terrain.terrainGeoBounds;
          window.__realInspectionGeo = { lat: bounds.centerLat - local.z / 6371000 * 180 / Math.PI,
            lon: bounds.centerLon + local.x / (6371000 * Math.cos(bounds.centerLat * Math.PI / 180)) * 180 / Math.PI };
          const ground = terrain.group.localToWorld(local);
          app.controls.target.copy(ground);
          app.sceneManager.camera.position.copy(ground).add(ground.clone().set(.002, .006, .003));
          app.controls.update(); app.sceneManager.updateCameraClipping(app.controls.getDistance());
        });
        await page.waitForFunction(() => {
          const app = window.__trekViewerApp, lod = app.activeTrek.imageryLOD;
          const geo = lod.getInspectedGeo(); if (!geo || lod.getFocusSource() !== 'center') return false;
          const expected = window.__realInspectionGeo;
          if (Math.abs(geo.lat - expected.lat) > .001 || Math.abs(geo.lon - expected.lon) > .001) return false;
          const lat = geo.lat, lon = geo.lon;
          const x = Math.floor((lon + 180) / 360 * 2 ** 19), phi = lat * Math.PI / 180;
          const y = Math.floor((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * 2 ** 19);
          return [...app.activeTrek.imageryLOD.patches.values()].some(p => p.zoom === 19 && p.x === x && p.y === y && p.mesh.visible);
        }, null, { timeout: 90000 });
        const viewZ19ReadyMs = Date.now() - started;
        const settleDeadline = Date.now() + 90000; let stable = 0;
        while (Date.now() < settleDeadline && stable < 3) {
          checkpoint();
          const settled = await page.evaluate(() => {
            const d = window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics();
            return d.targetZoom === 19 && d.coveragePercent >= 95 && d.inFlightRequests === 0 && d.pendingRequestsCount === 0 && d.requestQueueLength === 0;
          });
          stable = settled ? stable + 1 : 0; if (stable < 3) await delay(250);
        }
        assert.equal(stable, 3, 'Offline Z19 inspection did not settle');
        const observation = await page.evaluate(() => {
          const app = window.__trekViewerApp, diagnostics = app.activeTrek.imageryLOD.getDiagnostics();
          return { progress: app.session.getState().progress, cameraDistance: app.controls.getDistance(), counters: app.getProfileCounters(),
            inspectedGeo: app.activeTrek.imageryLOD.getInspectedGeo(), focusSource: app.activeTrek.imageryLOD.getFocusSource(),
            visibleByZoom: [...diagnostics.visibleByZoom], visibleFineBySource: diagnostics.visibleFineBySource,
            pending: diagnostics.pendingRequestsCount, coveragePercent: diagnostics.coveragePercent };
        });
        observation.viewZ19ReadyMs = viewZ19ReadyMs; observation.settledMs = Date.now() - started;
        checkpoints.push(observation); await status({ phase: 'offline-inspection', checkpoint: observation });
        await page.screenshot({ path: path.join(out, `offline-inspection-${progress}.png`) });
      }
      const sourceAttempts = external.slice(externalBefore); assert.equal(sourceAttempts.length, 0); assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(out, 'inspection.json'), JSON.stringify({ condition: 'Cold network-disabled normal High diorama inspection of ground 500 m beside three real route positions, outside the overview beacon, requiring the Z19 tile at the actual center terrain ray hit. Same persistent imported pack; no synthetic sources, hidden markers or renderer/quality-budget changes. PC browser evidence, not native comfort/performance acceptance.',
        build: expected.id, routeId, cold, checkpoints, offlineExternalAttempts: sourceAttempts.length, errors }, null, 2));
      await status({ phase: 'inspection-passed' });
    } else {
    stage = 'offline-tour';
    if (await page.locator('#btnSettings').isVisible() && await page.locator('#btnSettings').getAttribute('aria-expanded') === 'true') await page.locator('#btnSettings').click();
    await page.locator('#playbackMode').selectOption('tour');
    await page.locator('.speed-btn[data-speed="1"]').click();
    await status({ phase: 'offline-tour', cold, importedSources: imported.ready.completed });
    await page.evaluate(() => {
      const app = window.__trekViewerApp;
      window.__realTourCameraStart = app.sceneManager.camera.position.toArray(); window.__realTourSamples = [];
      window.__realTourTimer = setInterval(() => {
        const state = app.session.getState(), terrain = app.activeTrek.terrainResult;
        const point = app.activeTrek.trailResult.routeGeometry.getTelemetryAtProgress(state.progress).position;
        const chunk = (terrain.localChunks ?? []).find(c => { const b = c.getSurfaceBounds(); return c.mesh.visible && point.x >= b.minX && point.x <= b.maxX && point.z >= b.minZ && point.z <= b.maxZ; });
        const cell = chunk?.getCellSize();
        window.__realTourSamples.push({ progress: state.progress, fineAtHiker: !!(cell && Math.max(cell.x, cell.z) <= 10 && chunk.currentGrid.isRealDEM),
          cellM: cell ? Math.max(cell.x, cell.z) : null, source: chunk?.currentGrid.source ?? null, counters: app.getProfileCounters() });
      }, 500);
    });
    await page.locator('#btnPlay').click();
    const tourDeadline = Date.now() + 240000; let tourFinished = false;
    while (Date.now() < tourDeadline) {
      checkpoint();
      const current = await page.evaluate(() => {
        const app = window.__trekViewerApp, state = app.session.getState();
        return { progress: state.progress, isPlaying: state.isPlaying, following: state.followRoute,
          mode: state.playbackMode, speed: state.playbackSpeed, latest: window.__realTourSamples.at(-1) };
      });
      await status({ phase: 'offline-tour', playback: current });
      if (current.progress >= .999 && !current.isPlaying) { tourFinished = true; break; }
      await delay(5000, undefined, { signal: controller.signal });
    }
    assert.ok(tourFinished, 'Real UI tour did not finish');
    const tour = await page.evaluate(() => {
      clearInterval(window.__realTourTimer); const app = window.__trekViewerApp, start = window.__realTourCameraStart, end = app.sceneManager.camera.position.toArray();
      return { samples: window.__realTourSamples, cameraTravelSceneUnits: Math.hypot(...end.map((v, i) => v - start[i])), endProgress: app.session.getState().progress };
    });
    assert.ok(tour.cameraTravelSceneUnits > 1); assert.equal(tour.endProgress, 1);
    const fineSamples = tour.samples.filter(sample => sample.fineAtHiker).length;
    assert.ok(tour.samples.length >= 150 && fineSamples / tour.samples.length >= .95, 'Fine terrain was not consistently present beneath the hiker');
    const sourceAttempts = external.slice(externalBefore); assert.equal(sourceAttempts.length, 0, 'Offline startup/tour attempted uncached external sources');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(out, 'offline-finish.png') });
    const result = { condition: 'Real complete route file, native production file input, actual persistent IndexedDB, pause/browser restart/resume without prefix rewrites, temporary-cache clear, cold network-disabled PWA startup and full desktop High tour. PC browser evidence; not headset/APK/native performance acceptance.',
      build: expected.id, routeId, certificate, imported, cold, tour, offlineExternalAttempts: sourceAttempts.length, errors };
    fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2)); await status({ phase: 'passed', routeId });
    }
  }
} catch (error) {
  await status({ phase: controller.signal.aborted ? 'paused' : 'failed', stage, error: String(error), errors });
  if (!controller.signal.aborted) throw error;
  process.exitCode = 2;
} finally { clearInterval(poll); await context?.close(); fs.closeSync(fd); fs.unlinkSync(lock); }
