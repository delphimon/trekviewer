import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { build } from 'vite';
import { resolveChromium, resolveLaunchOptions } from './playwright-launch.mjs';

/** PC preparation uses the same bounded browser worker/Canvas validators as the
 * installed app. This loopback harness never launches or queries a headset. */
export async function openOfflinePreparationValidator(directory) {
  const root = path.resolve(directory), helper = path.join(root, 'helper');
  fs.mkdirSync(root, { recursive: true });
  const entry = path.join(root, 'entry.ts');
  fs.writeFileSync(entry, `export { validateOfflineResource } from ${JSON.stringify(path.resolve('src/offline/OfflineDownloads.ts'))};
export { inspectOfflineArchive, offlineArchiveSource } from ${JSON.stringify(path.resolve('src/offline/OfflineArchive.ts'))};
export { disposeTerrainJobs } from ${JSON.stringify(path.resolve('src/terrain/TerrainJobs.ts'))};`);
  await build({ configFile: false, base: './', logLevel: 'error', build: { outDir: helper, emptyOutDir: true,
    target: 'esnext', lib: { entry, formats: ['es'], fileName: () => 'validation.js' } } });
  const server = http.createServer((request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); return response.end('<!doctype html><title>Route source preparation</title><input type="file" id="pack-file">'); }
      const file = path.resolve(helper, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      if (!file.startsWith(helper + path.sep) || !fs.statSync(file).isFile()) throw Error('Not found');
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); response.end(fs.readFileSync(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  let browser;
  const close = async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const chromium = resolveChromium();
    browser = await chromium.launch(resolveLaunchOptions());
    const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
    let blockedRequests = 0, archiveBusy = false, reportProgress;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blockedRequests++; return route.abort();
    });
    await page.exposeFunction('__archiveProgress', value => reportProgress?.(value));
    await page.goto(origin); await page.addScriptTag({ type: 'module', content: "import * as h from '/validation.js'; window.__validation=h;" });
    await page.waitForFunction(() => !!window.__validation);
    return { close, async validate(resource, bytes) {
      return page.evaluate(async ({ resource, encoded }) => {
        await window.__validation.validateOfflineResource(resource, new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]));
      }, { resource, encoded: Buffer.from(bytes).toString('base64') });
    }, async verifyArchive(file, plan, signal, onProgress = () => {}) {
      if (archiveBusy) throw Error('Archive verification is already running');
      archiveBusy = true;
      const blockedBefore = blockedRequests;
      const abort = () => { void page.evaluate(() => window.__archiveAbort?.abort()).catch(() => {}); };
      try {
        signal?.throwIfAborted();
        // A local path gives Chromium a native File; the archive is never sent
        // as a base64 string or loaded into a Node/Playwright buffer.
        await page.locator('#pack-file').setInputFiles(path.resolve(file));
        await page.evaluate(() => { window.__archiveAbort = new AbortController(); });
        signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
        reportProgress = async value => { await onProgress(value); return !signal?.aborted; };
        const result = await page.evaluate(async plan => {
          const h = window.__validation, signal = window.__archiveAbort.signal;
          const file = document.querySelector('#pack-file').files[0];
          const indexed = await h.inspectOfflineArchive(file, signal);
          const source = await h.offlineArchiveSource(file, indexed, plan, signal);
          const state = { phase: 'indexed', archiveBytes: file.size, sources: indexed.manifest.records.length,
            validated: 0, originalSourceBytes: 0, storedSourceBytes: 0, elevationSources: 0, imagerySources: 0,
            maxSourceBytes: 0, lastSourceOffset: indexed.offsets.at(-1), inventorySha256: indexed.manifest.inventorySha256 };
          const progress = async () => {
            if (await window.__archiveProgress(state) === false) window.__archiveAbort.abort();
            signal.throwIfAborted();
          };
          await progress();
          state.phase = 'validating';
          for (let index = 0; index < plan.resources.length; index++) {
            signal.throwIfAborted();
            const loaded = await source.load(index, signal);
            await h.validateOfflineResource(plan.resources[index], loaded.blob, signal);
            state.validated++;
            state.originalSourceBytes += loaded.blob.size;
            state.storedSourceBytes += indexed.manifest.records[index].storedBytes;
            state.maxSourceBytes = Math.max(state.maxSourceBytes, loaded.blob.size);
            state[plan.resources[index].kind === 'elevation' ? 'elevationSources' : 'imagerySources']++;
            await progress();
          }
          return { ...state, phase: 'sources-verified' };
        }, plan);
        signal?.throwIfAborted();
        if (blockedRequests !== blockedBefore) throw Error('Archive verification attempted an external request');
        return { ...result, externalRequests: 0, nativeFileHandle: true };
      } finally {
        signal?.removeEventListener('abort', abort); reportProgress = undefined;
        await page.locator('#pack-file').setInputFiles([]).catch(() => {});
        archiveBusy = false;
      }
    } };
  } catch (error) { await close(); throw error; }
}
