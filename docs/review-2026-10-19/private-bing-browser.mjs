import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
assert.ok(process.env.TREK_LOCAL_PROVIDERS_PATH, 'Set TREK_LOCAL_PROVIDERS_PATH to a local providers.json; never embed the token in this script.');
const config = JSON.parse(fs.readFileSync(process.env.TREK_LOCAL_PROVIDERS_PATH, 'utf8'));
assert.equal(config.imageryAssetId, 2, 'The existing Bing adapter uses asset 2');
assert.ok(typeof config.ionToken === 'string' && config.ionToken.length > 10);
const out = path.resolve(process.env.TREK_BING_BROWSER_OUT ?? '.review-cache/private-bing-browser');
fs.mkdirSync(out, { recursive: true });
const expectedBuild = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
const expectedEntry = path.posix.basename(fs.readFileSync('dist/index.html', 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
// Check all emitted assets, without printing a matching file or any token text.
for (const file of fs.readdirSync('dist', { recursive: true })) {
  if (/\.(?:js|html|json)$/.test(file)) assert.ok(!fs.readFileSync(path.join('dist', file), 'utf8').includes(config.ionToken), 'Credential found in a build artifact');
}
const base = process.env.TREK_BING_BROWSER_URL ?? 'https://127.0.0.1:4205/';
let browser, server;
const errors = [], metadata = [];
try {
  if (!process.env.TREK_BING_BROWSER_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4205', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4205')) { clearTimeout(timer); resolve(); } });
      server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('response', response => {
    const url = new URL(response.url());
    if (['api.cesium.com', 'dev.virtualearth.net'].includes(url.hostname)) metadata.push({ host: url.hostname, path: url.pathname, status: response.status() });
  });
  page.on('pageerror', () => errors.push('Page exception')); // Never serialize credential-bearing errors.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const account = url.origin === 'https://api.cesium.com' || url.origin === 'https://dev.virtualearth.net';
    const imagery = url.protocol === 'https:' && url.hostname.endsWith('.tiles.virtualearth.net');
    return account || imagery || url.origin === new URL(base).origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source:
    `globalThis.__TREK_VIEWER_PROVIDERS__=${JSON.stringify({ provider: 'cesium-bing', ionToken: config.ionToken })};` });
  await page.goto(`${base}?profile=1&terrainTiles=0&regionalBase=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 60000 });
  const provider = await page.evaluate(() => window.__trekViewerApp.getProfileCounters().imageryProvider);
  if (provider !== 'cesium-bing') console.log(JSON.stringify({ metadata, bootstrap: await page.evaluate(() => ({ present: !!window.__TREK_VIEWER_PROVIDERS__, selected: window.__TREK_VIEWER_PROVIDERS__?.provider })) }));
  assert.equal(provider, 'cesium-bing', 'Private launch did not initialize Bing');
  const scripts = await page.evaluate(() => [...document.scripts].map(s => s.src));
  assert.ok(scripts.some(s => s.endsWith('/' + expectedEntry)));
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await page.evaluate(() => { delete window.__TREK_VIEWER_PROVIDERS__; });
  const tile = await page.evaluate(async () => {
    const a = window.__trekViewerApp, start = performance.now();
    const image = await a.activeTrek.imageryLOD.constructor.loadPatchImage(19, 81977, 182681, 'satellite');
    return { width: image.width, height: image.height, elapsedMs: performance.now() - start,
      provider: a.getProfileCounters().imageryProvider, bootstrapRemoved: !('__TREK_VIEWER_PROVIDERS__' in window) };
  });
  assert.equal(tile.width, 256); assert.equal(tile.height, 256); assert.equal(tile.provider, 'cesium-bing');
  assert.ok(tile.bootstrapRemoved);
  // A normal refresh returns to the public default; no browser storage or
  // hosted provider file was used to persist the credential.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__trekViewerApp?.activeTrek, null, { timeout: 60000 });
  const afterReload = await page.evaluate(() => window.__trekViewerApp.getProfileCounters().imageryProvider);
  assert.equal(afterReload, 'public-naip'); assert.deepEqual(errors, []);
  const actualBuild = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
  assert.equal(actualBuild.id, expectedBuild.id);
  const result = { condition: 'Private aerial-only source/launch test in desktop Edge. External DEM blocked; synthetic terrain. Not native acceptance or a general Bing integration/attribution review.',
    build: actualBuild, entry: expectedEntry, tile, afterReload, metadata, credentialAbsentFromBuild: true, errors };
  assert.ok(!JSON.stringify(result).includes(config.ionToken));
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await browser?.close(); server?.kill(); }
