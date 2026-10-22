import fs from 'node:fs';
import assert from 'node:assert/strict';

export async function checkOfflineArchiveImport(page) {
  const fixture = JSON.parse(fs.readFileSync('.review-cache/portable-packs/preparation-fixture/latest.json', 'utf8'));
  assert.ok(fs.statSync(fixture.archive).size < 16 * 1024 * 1024, 'Controlled fixture must stay bounded');
  const bytes = fs.readFileSync(fixture.archive);
  const result = await page.evaluate(async ({ plan, encoded }) => {
    const h = window.__offlineTest, assert = (value, message) => { if (!value) throw Error(message); };
    const pcDemUrl = plan.resources[0].urls[0], browserDem = new URL(pcDemUrl), bbox = browserDem.searchParams.get('bbox').split(',').map(Number);
    bbox[1] += 4e-9; browserDem.searchParams.set('bbox', bbox.join(','));
    plan.resources[0].urls = [browserDem.href];
    const file = new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]);
    const index = await h.inspectOfflineArchive(file), hashes = index.manifest.records.map(r => r.sha256);
    const nativeFetch = window.fetch.bind(window), urls = new Set(plan.resources.flatMap(r => r.urls)); let sourceRequests = 0;
    window.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      if (urls.has(url) && new Error().stack?.includes('/__offline-test/')) { sourceRequests++; throw Error('Archive import must not fetch source URLs'); }
      return nativeFetch(input, options);
    };
    const nativeSave = h.OfflineStore.save; let pausedOnce = false; const writes = [];
    h.OfflineStore.save = async (...args) => {
      await nativeSave.apply(h.OfflineStore, args); writes.push(args[0].completed);
      if (!pausedOnce && args[0].id === plan.id) { pausedOnce = true; h.OfflineDownloads.pause(); }
    };
    const prepare = () => h.OfflineDownloads.prepare(async signal => ({ plan,
      source: await h.offlineArchiveSource(file, await h.inspectOfflineArchive(file, signal), plan) }));
    let pausedState, ready;
    try {
      await prepare(); pausedState = await h.OfflineStore.state(plan.id);
      assert(pausedState.state === 'paused' && pausedState.completed === 1, 'Import pause must retain exactly the original DEM');
      assert(await h.OfflineStore.read(pcDemUrl) !== null, 'Existing independent fixture coverage must remain accessible');
      assert(await h.OfflineStore.read(plan.resources[1].urls[0]) === null, 'Incomplete archive staging must remain invisible');
      await prepare(); ready = await h.OfflineStore.state(plan.id);
      assert(ready.state === 'ready' && ready.completed === 3, 'Resume must publish all three real components');
      assert(JSON.stringify(writes) === '[1,2,3]', 'Resume must not rewrite verified saved source bodies');
      for (let i = 0; i < plan.resources.length; i++) {
        const asset = await h.OfflineStore.stored(plan.id, plan.resources[i]);
        assert(asset.sha256 === hashes[i] && await h.hashOfflineBlob(asset.blob) === hashes[i], 'Stored originals must exactly match PC archive source hashes');
        if (i === 0) assert(asset.sourceUrl === pcDemUrl && asset.urls.includes(browserDem.href), 'Original request provenance and runtime lookup alias must both be preserved');
      }
    } finally { h.OfflineStore.save = nativeSave; window.fetch = nativeFetch; }
    assert(sourceRequests === 0, 'Import must not acquire any imagery or terrain from the network');
    await h.OfflineDownloads.withLock(() => h.OfflineStore.remove(plan.id));
    const position = index.offsets[0] + 17, originalByte = new Uint8Array(await file.slice(position, position + 1).arrayBuffer())[0];
    const damaged = new Blob([file.slice(0, position), new Uint8Array([originalByte ^ 1]), file.slice(position + 1)]);
    let rejected = false;
    try { await h.OfflineDownloads.prepare(async signal => ({ plan, source: await h.offlineArchiveSource(damaged, await h.inspectOfflineArchive(damaged, signal), plan) })); }
    catch { rejected = true; }
    const failed = await h.OfflineStore.state(plan.id);
    assert(rejected && failed.state === 'paused' && failed.completed === 0, 'Corrupt stored bytes must not publish or commit a source');
    await h.OfflineDownloads.withLock(() => h.OfflineStore.remove(plan.id));
    let layoutRejected = false;
    try { await h.offlineArchiveSource(file, index, { ...plan, routeHash: 'b'.repeat(64) }); } catch { layoutRejected = true; }
    assert(layoutRejected, 'An archive for another route revision must be rejected');
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = h.OfflineDownloads.prepare(async signal => {
      enter(); await new Promise(resolve => { release = resolve; }); signal.throwIfAborted(); return { plan };
    });
    await entered; assert(h.OfflineDownloads.busy(), 'Header preparation must own the shared operation');
    h.OfflineDownloads.pause(); release(); let preparationPaused = false;
    try { await pending; } catch (error) { preparationPaused = error.name === 'AbortError'; }
    assert(preparationPaused && !h.OfflineDownloads.busy() && !await h.OfflineStore.state(plan.id), 'Pause during preflight must prevent later source acquisition');
    return { paused: pausedState, ready, sourceRequests, committedWrites: writes, originalHashes: hashes,
      corruptSourceRejected: true, routeRevisionRejected: true, preflightPausePreventedAcquisition: true, originalRequestPreservedAcrossMathULP: true };
  }, { plan: fixture.plan, encoded: bytes.toString('base64') });
  await page.locator('[data-offline-file]').setInputFiles({ name: 'controlled-fixture.tar', mimeType: 'application/x-tar', buffer: bytes });
  await page.waitForFunction(() => document.querySelector('[data-offline-message]').textContent.includes('not supported'));
  await page.waitForFunction(() => !document.querySelector('[data-offline-action="import"]').disabled);
  await page.locator('[data-offline-file]').setInputFiles({ name: 'truncated.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(1024) });
  await page.waitForFunction(() => document.querySelector('[data-offline-message]').textContent.includes('Incomplete route pack'));
  await page.waitForFunction(() => !document.querySelector('[data-offline-action="import"]').disabled);
  await page.evaluate(() => window.__trekViewerApp.session.setPlayback(true));
  await page.locator('[data-offline-file]').setInputFiles({ name: 'truncated.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(1024) });
  await page.waitForFunction(() => document.querySelector('[data-offline-message]').textContent.includes('Pause playback'));
  await page.evaluate(() => window.__trekViewerApp.session.setPlayback(false));
  await page.evaluate(() => { window.__trekViewerApp.xrEntryPending = true; document.querySelector('[data-offline-message]').textContent = 'Checking controlled XR entry guard'; });
  await page.locator('[data-offline-file]').setInputFiles({ name: 'truncated.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(1024) });
  await page.waitForFunction(() => document.querySelector('[data-offline-message]').textContent.includes('leave VR/MR'));
  await page.evaluate(() => { window.__trekViewerApp.xrEntryPending = false; });
  return { condition: fixture.condition, archiveBytes: fixture.archiveBytes, independentTarNames: fixture.names,
    ...result, uiUnsupportedRouteRejected: true, uiTruncatedFileRejected: true, uiPlayingImportBlocked: true, uiXREntryImportBlocked: true };
}
