import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const html = fs.readFileSync('dist/index.html', 'utf8');
const [, entry, integrity] = html.match(/src="([^"]+\.js)"[^>]*data-trek-entry="true" integrity="([^"]+)"/);
const body = fs.readFileSync(path.join('dist', entry));
assert.equal(integrity, `sha384-${createHash('sha384').update(body).digest('base64')}`);
const out = path.resolve(process.env.TREK_ENTRY_OUT ?? '.review-cache/entry-delivery');
fs.mkdirSync(out, { recursive: true });
let browser, server;
const results = [];
try {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4201', '--strictPort'], { stdio: 'pipe', windowsHide: true });
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Preview timeout')), 15000); server.stdout.on('data', data => { if (data.toString().includes('4201')) { clearTimeout(timeout); resolve(); } }); server.on('error', reject); });
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  for (const failures of [0, 1, 2, 3]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage(), errors = [], requests = [], consoleErrors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route('**/assets/index-*.js*', route => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: 'application/javascript', body: requests.length <= failures ? 'window.__corruptExecuted = true;' : body });
    });
    // Startup verification does not require downloading a whole US route.
    await page.route('**/services.nationalmap.gov/**', route => route.abort());
    await page.route('**/imagery.geoplatform.gov/**', route => route.abort());
    await page.goto('https://127.0.0.1:4201/?profile=1', { waitUntil: 'domcontentloaded' });
    if (failures < 3) {
      await page.waitForFunction(() => !!window.__trekViewerApp, null, { timeout: 15000 });
      assert.equal(await page.locator('#canvas-container canvas').count(), 1);
      assert.equal(await page.locator('#appLoadError').count(), 0);
    } else {
      await page.locator('#appLoadError').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#appLoadError button').textContent(), 'Reload TrekViewer');
      assert.equal(await page.evaluate(() => !!window.__trekViewerApp), false);
    }
    await page.waitForTimeout(1200);
    assert.equal(requests.length, Math.min(failures + 1, 3));
    assert.equal(await page.evaluate(() => !!window.__corruptExecuted), false);
    assert.deepEqual(errors, []);
    const integrityErrors = consoleErrors.filter(message => message.includes('integrity'));
    assert.equal(integrityErrors.length, failures);
    results.push({ injectedFailures: failures, attempts: requests.length, started: failures < 3, corruptedCodeExecuted: false, integrityRejections: integrityErrors.length, pageErrors: errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ integrity, entry, results }, null, 2) + '\n');
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  server?.kill();
}
