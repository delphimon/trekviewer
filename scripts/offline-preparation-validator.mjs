import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'vite';

/** PC preparation uses the same bounded browser worker/Canvas validators as the
 * installed app. This loopback harness never launches or queries a headset. */
export async function openOfflinePreparationValidator(directory) {
  const root = path.resolve(directory), helper = path.join(root, 'helper');
  fs.mkdirSync(root, { recursive: true });
  const entry = path.join(root, 'entry.ts');
  fs.writeFileSync(entry, `export { validateOfflineResource } from ${JSON.stringify(path.resolve('src/offline/OfflineDownloads.ts'))};
export { disposeTerrainJobs } from ${JSON.stringify(path.resolve('src/terrain/TerrainJobs.ts'))};`);
  await build({ configFile: false, base: './', logLevel: 'error', build: { outDir: helper, emptyOutDir: true,
    target: 'esnext', lib: { entry, formats: ['es'], fileName: () => 'validation.js' } } });
  const server = http.createServer((request, response) => {
    try {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); return response.end('<!doctype html><title>Route source preparation</title>'); }
      const file = path.resolve(helper, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      if (!file.startsWith(helper + path.sep) || !fs.statSync(file).isFile()) throw Error('Not found');
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); response.end(fs.readFileSync(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  let browser;
  const close = async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const require = createRequire(import.meta.url), { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin); await page.addScriptTag({ type: 'module', content: "import * as h from '/validation.js'; window.__validation=h;" });
    await page.waitForFunction(() => !!window.__validation);
    return { close, async validate(resource, bytes) {
      return page.evaluate(async ({ resource, encoded }) => {
        await window.__validation.validateOfflineResource(resource, new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]));
      }, { resource, encoded: Buffer.from(bytes).toString('base64') });
    } };
  } catch (error) { await close(); throw error; }
}
