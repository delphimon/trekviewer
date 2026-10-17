import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_XR_QUALITY_OUT ?? '.review-cache/xr-quality-browser'); fs.mkdirSync(out, { recursive: true });
const base = process.env.TREK_XR_QUALITY_URL ?? 'https://127.0.0.1:4197';
let server, browser; const errors = [], warnings = [];
try {
  if (!process.env.TREK_XR_QUALITY_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4197', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timed out')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4197')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1233, height: 821 }, userAgent: 'Mozilla/5.0 (Quest 3) OculusBrowser/152.1.0.0' });
  page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
  await page.goto(`${base}/?profile=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__trekViewerApp?.activeTrek && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 120000 });
  await page.evaluate(() => { window.__trekViewerApp.desktopViewFitted = false; });
  const snapshot = () => page.evaluate(() => { const a = window.__trekViewerApp; return { quality: a.session.getState().qualityProfile,
    rendering: a.sceneManager.getXRRenderQuality(), camera: a.sceneManager.camera.position.toArray(),
    target: a.controls.target.toArray(), model: a.sceneManager.dioramaRoot.matrix.toArray(), progress: a.session.getState().progress }; });
  const high = await snapshot(); assert.equal(high.quality, 'quest-high'); assert.equal(high.rendering.xrRequestedFoveation, 0);
  await page.click('#btnQualityBalanced'); const balanced = await snapshot();
  assert.equal(balanced.quality, 'quest-balanced'); assert.equal(balanced.rendering.xrRequestedFoveation, 1);
  await page.click('#btnQualityHigh'); const restored = await snapshot();
  assert.equal(restored.quality, 'quest-high'); assert.equal(restored.rendering.xrRequestedFoveation, 0);
  for (const state of [balanced, restored]) for (const key of ['camera', 'target', 'model', 'progress']) assert.deepEqual(state[key], high[key]);
  await page.click('#profile-start'); await page.waitForTimeout(1300); await page.click('#profile-stop');
  await page.waitForFunction(() => window.__trekViewerApp.profileSavedOnDevice, null, { timeout: 10000 });
  const report = await page.evaluate(() => window.__trekViewerApp.completedProfile);
  assert(report.windows.length > 0);
  for (const w of report.windows) { assert.equal(w.xrRequestedFoveation, 0); assert.equal(w.xrLayerFoveation, null); assert.equal(w.xrLayerFoveationSupported, null); assert.equal(w.xrLayerType, 'none'); assert.deepEqual(w.xrEyeViewports, []); }
  const glError = await page.evaluate(() => window.__trekViewerApp.sceneManager.renderer.getContext().getError());
  assert.equal(glError, 0); assert.deepEqual(errors, []);
  const result = { condition: 'Actual Edge desktop WebGL with Quest user-agent policy. No immersive runtime: applied foveation stays unknown. Not a native quality/FPS test.',
    build: await (await page.request.get(`${base}/build-info.json`)).json(), high, balanced, restored,
    savedReportWindows: report.windows.length, reportedXRQuality: report.windows.map(w => ({ requested: w.xrRequestedFoveation, layer: w.xrLayerFoveation, supported: w.xrLayerFoveationSupported, type: w.xrLayerType })), glError, errors, warnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await browser?.close(); server?.kill(); }
