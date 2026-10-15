import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/relations/pixels'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4191', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4191')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (['warning', 'error'].includes(m.type())) warnings.push(m.text()); });
  await page.goto('https://127.0.0.1:4191/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'), null, { timeout: 120000 });
  await page.waitForFunction(() => [...window.__trekViewerApp.activeTrek.imageryLOD.patches.values()].filter(p => p.mesh.visible && !p.isFading).length >= 4, null, { timeout: 120000 });
  await page.addScriptTag({ content: fs.readFileSync('.review-cache/relations/baseline-browser.js', 'utf8') });
  const comparison = await page.evaluate(() => {
    const a = window.__trekViewerApp, lod = a.activeTrek.imageryLOD, r = a.sceneManager.renderer, gl = r.getContext();
    r.setAnimationLoop(null);
    const state = () => ({ visible: [...lod.patches].filter(([, p]) => p.mesh.visible).map(([key]) => key).sort(), queue: lod.requestQueue.map(q => [q.key, q.priority]) });
    const capture = () => { r.render(a.sceneManager.scene, a.sceneManager.camera); const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels; };
    lod.updatePatchVisibility(); lod.sortRequestQueue(); for (let i = 0; i < 3; i++) capture();
    const current = capture(), currentState = state(), currentPng = r.domElement.toDataURL('image/png'), control = capture();
    window.visibilityBaseline.call(lod); window.sortBaseline.call(lod);
    const baseline = capture(), baselineState = state(), baselinePng = r.domElement.toDataURL('image/png');
    const difference = other => { let changedChannels = 0, maxDelta = 0; for (let i = 0; i < current.length; i++) { const delta = Math.abs(current[i] - other[i]); if (delta) changedChannels++; maxDelta = Math.max(maxDelta, delta); } return { changedChannels, maxDelta }; };
    return { control: difference(control), baseline: difference(baseline), currentState, baselineState, currentPng, baselinePng, channels: current.length, glError: gl.getError() };
  });
  for (const [name, value] of [['current', comparison.currentPng], ['baseline', comparison.baselinePng]]) fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(value.split(',')[1], 'base64'));
  delete comparison.currentPng; delete comparison.baselinePng;
  assert.deepEqual(comparison.currentState, comparison.baselineState); assert(comparison.currentState.visible.length >= 4);
  assert.equal(comparison.glError, 0); assert.deepEqual(errors, []);
  // A non-repeatable same-code control invalidates an exact-pixel conclusion.
  // Keep that result explicit; state equality remains independently testable.
  const pixelComparison = comparison.control.changedChannels === 0 ? 'repeatable control' : 'inconclusive: unchanged-code control is not pixel-repeatable';
  fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify({ ...comparison, stateChecksPassed: true, pixelComparison, errors, warnings }, null, 2) + '\n');
  if (comparison.control.changedChannels === 0) assert.equal(comparison.baseline.changedChannels, 0, 'raw WebGL pixels remain identical');
  console.log(JSON.stringify({ stateChecksPassed: true, pixelComparison, ...comparison, currentState: comparison.currentState.visible.length, baselineState: comparison.baselineState.visible.length, errors, warnings }));
} finally { await browser?.close(); server.kill(); }
