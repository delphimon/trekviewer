import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/profile-recovery-browser'); fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(out, 'edge-'));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4195', '--strictPort'], { stdio: 'pipe', windowsHide: true });
const url = 'https://127.0.0.1:4195/?profile=1';
let context;
const errors = [];
async function launch() {
  context = await chromium.launchPersistentContext(profile, { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: ['--ignore-certificate-errors'], ignoreHTTPSErrors: true, viewport: { width: 1233, height: 821 } });
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__trekViewerApp);
  return page;
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Preview startup timed out')), 15000);
    server.stdout.on('data', data => { if (data.toString().includes('4195')) { clearTimeout(timer); resolve(); } });
    server.on('error', reject);
  });
  let page = await launch();
  await page.click('#profile-start');
  await page.waitForFunction(() => window.__trekViewerApp.profileRecorder.windowCount > 0, null, { timeout: 30000 });
  await page.click('#profile-stop');
  await page.waitForFunction(() => window.__trekViewerApp.profileSavedOnDevice);
  const original = await page.evaluate(() => window.__trekViewerApp.completedProfile);
  assert(original.windows.length > 0);
  assert(original.windows.every(window => !window.xrPresenting && window.xrEnvironmentBlendMode === 'none' && window.xrEyeCount === 0));
  await context.close();
  page = await launch();
  await page.waitForFunction(() => window.__trekViewerApp.profileSavedOnDevice);
  assert.deepEqual(await page.evaluate(() => window.__trekViewerApp.completedProfile), original);
  // Simulate a persisted report from another release: the current running build
  // must not be substituted into the restored report or its download filename.
  const historical = { ...original, buildId: 'previous-release-fixture' };
  await page.evaluate(report => new Promise((resolve, reject) => {
    const open = indexedDB.open('trekviewer-profiles', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('reports', 'readwrite');
      tx.objectStore('reports').put(report, 'latest');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), historical);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.profileSavedOnDevice);
  assert.equal(await page.evaluate(() => window.__trekViewerApp.completedProfile.buildId), historical.buildId);
  const downloadEvent = page.waitForEvent('download'); await page.click('#profile-download'); const download = await downloadEvent;
  assert(download.suggestedFilename().includes('previous-release-fixture'));
  await download.saveAs(path.join(out, 'download.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'download.json'), 'utf8')), historical);
  await page.setViewportSize({ width: 390, height: 844 });
  const rect = await page.locator('#profile-controls').boundingBox();
  assert(rect.x >= 0 && rect.x + rect.width <= 390);
  // Denied storage must leave a freshly completed report downloadable in memory.
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__trekViewerApp);
  await page.click('#profile-start');
  await page.waitForFunction(() => window.__trekViewerApp.profileRecorder.windowCount > 0, null, { timeout: 30000 });
  await page.click('#profile-stop');
  await page.waitForFunction(() => document.getElementById('profile-status').textContent.includes('Ready to download'));
  assert(await page.locator('#profile-download').isEnabled());
  assert.equal(await page.evaluate(() => window.__trekViewerApp.profileSavedOnDevice), false);
  assert.deepEqual(errors, []);
  const result = { condition: 'Actual Edge production build and real IndexedDB. Desktop diagnostic recordings only; no native MR quality claim.',
    originalBuild: original.buildId, originalWindows: original.windows.length, restoredAfterBrowserRestart: true, historicalBuildPreserved: true,
    downloadedHistoricalJsonEqual: true, mobileControlsWithinViewport: true, deniedStorageDownloadAvailable: true, errors };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await context?.close(); server.kill(); }
