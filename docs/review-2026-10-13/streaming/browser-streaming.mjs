import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/streaming'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4183', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser, blocked = true; const injected = new Set(), errors = [], unexpectedConsole = [], expectedConsole = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4183')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (!['warning', 'error'].includes(m.type())) return;
    const entry = { text: m.text(), url: m.location().url };
    if (injected.has(entry.url) || entry.text.includes('Rejecting local DEM: coverage too low')) expectedConsole.push(entry); else unexpectedConsole.push(entry);
  });
  await page.route('**/terrarium/15/**', async route => { if (blocked) { injected.add(route.request().url()); await route.abort('failed'); } else await route.continue(); });
  await page.goto('https://127.0.0.1:4183/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier') && !window.__trekViewerApp.graphicsRecovery.isSuspended, null, { timeout: 90000 });
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return !s.busy && !s.ready && s.failed.size === s.wanted.size && s.wanted.size > 0; }, null, { timeout: 60000 });
  await page.evaluate(() => { document.getElementById('profile-controls')?.remove(); const app = window.__trekViewerApp; app.controls.enableDamping = false; const s = app.activeTrek.localTerrainStreamer; window.streamCounts = { probes: 0 }; const prepare = s.prepareNext; s.prepareNext = function(...args) { window.streamCounts.probes++; return prepare.apply(this, args); }; });
  const snapshot = () => page.evaluate(() => {
    const app = window.__trekViewerApp, s = app.activeTrek.localTerrainStreamer, gl = app.sceneManager.renderer.getContext();
    const now = performance.now(), base = app.terrainResult.terrainMesh.geometry;
    return { elapsedMs: now, chunks: app.terrainResult.localChunks.length, vertices: app.terrainResult.localChunks.reduce((n, c) => n + c.totalVertices, 0), failures: s.failed.size, wanted: s.wanted.size, busy: s.busy, retryDelay: Number.isFinite(s.nextWorkAt) ? Math.max(0, s.nextWorkAt - now) : null, probes: window.streamCounts.probes, surfaceRevision: app.terrainResult.surfaceRevision, baseTriangles: Math.min(base.drawRange.count, base.index.count) / 3, camera: app.sceneManager.camera.position.toArray(), target: app.controls.target.toArray(), progress: app.session.getState().progress, glError: gl.getError(), renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  const before = await snapshot(); assert.equal(before.chunks, 0); assert(before.failures > 0); assert(before.retryDelay > 1000); assert.equal(before.glError, 0); assert(injected.size > 0);
  await page.screenshot({ path: path.join(out, 'base-during-outage.png') });
  blocked = false;
  await page.waitForTimeout(3000);
  const cooldown = await snapshot(); assert.equal(cooldown.chunks, 0); assert.equal(cooldown.probes, before.probes); assert.equal(cooldown.surfaceRevision, before.surfaceRevision);
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return s.activeChunks.length > 0; }, null, { timeout: 90000 });
  const firstRecovery = await snapshot(); assert(firstRecovery.chunks > 0); assert(firstRecovery.surfaceRevision > before.surfaceRevision);
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return s.chunks.size === s.wanted.size && !s.busy && !s.ready && s.failed.size === 0; }, null, { timeout: 90000 });
  const recovered = await snapshot(); assert(recovered.chunks > 0 && recovered.chunks <= 24); assert(recovered.vertices <= 160000); assert.equal(recovered.failures, 0); assert.equal(recovered.glError, 0);
  for (const key of ['camera', 'target']) assert(recovered[key].every((v, i) => Math.abs(v - before[key][i]) < 1e-12)); assert.equal(recovered.progress, before.progress);
  await page.waitForTimeout(3000); const idle = await snapshot(); assert.equal(idle.probes, recovered.probes); assert.equal(idle.surfaceRevision, recovered.surfaceRevision);
  await page.screenshot({ path: path.join(out, 'detail-after-recovery.png') });
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedConsole, []);
  const result = { before, cooldown, firstRecovery, recovered, idle, injectedTileRequests: injected.size, expectedConsoleCount: expectedConsole.length, errors, unexpectedConsole };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
