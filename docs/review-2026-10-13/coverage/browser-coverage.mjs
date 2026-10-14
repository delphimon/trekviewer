import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve('.review-cache/coverage'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4178', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser;
const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4178')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text()); });
  await page.goto('https://127.0.0.1:4178/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.terrainResult?.localChunks?.filter(c => c.mesh.visible).length >= 8, null, { timeout: 90000 });
  await page.waitForTimeout(4000);
  const setup = await page.evaluate(() => {
    const app = window.__trekViewerApp, scene = app.sceneManager, terrain = app.terrainResult;
    scene.renderer.setAnimationLoop(null); app.flyoverController.pause(); app.controls.enableDamping = false;
    document.getElementById('profile-controls')?.remove();
    const index = terrain.terrainMesh.geometry.index, gl = scene.renderer.getContext();
    window.coverageUploads = [];
    const upload = gl.bufferSubData.bind(gl);
    gl.bufferSubData = (...args) => {
      if (args[2] === index.array) window.coverageUploads.push({ offset: args[1], elements: args[4] ?? index.array.length, bytes: (args[4] ?? index.array.length) * index.array.BYTES_PER_ELEMENT });
      return upload(...args);
    };
    window.validateCoverage = () => {
      const grid = terrain.baseMeshGrid, holes = terrain.terrainMesh.geometry.userData.surfaceHoles;
      let cursor = 0, mismatches = 0;
      for (let z = 0; z < grid.segmentsZ; z++) for (let x = 0; x < grid.segmentsX; x++) {
        const cx = (x + 0.5) * grid.width / grid.segmentsX - grid.width / 2;
        const cz = (z + 0.5) * grid.depth / grid.segmentsZ - grid.depth / 2;
        if (holes.some(b => cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ)) continue;
        const a = x + (grid.segmentsX + 1) * z, b = a + grid.segmentsX + 1, c = b + 1, d = a + 1;
        for (const expected of [a,b,d,b,c,d]) if (index.array[cursor++] !== expected) mismatches++;
      }
      return { mismatches, expectedIndices: cursor, drawnIndices: terrain.terrainMesh.geometry.drawRange.count, totalIndices: index.count, holes: holes.length };
    };
    const pos = terrain.terrainMesh.geometry.attributes.position;
    let peak = 0; for (let i = 1; i < pos.count; i++) if (pos.getY(i) > pos.getY(peak)) peak = i;
    const target = scene.camera.position.clone().fromBufferAttribute(pos, peak); terrain.terrainMesh.localToWorld(target);
    app.controls.target.copy(target); scene.camera.position.copy(target).add(target.clone().set(0, 0.036, 0.048)); scene.camera.lookAt(target);
    app.controls.update(); scene.updateCameraClipping(app.controls.getDistance());
    app.activeTrek.updateWaypoints(scene.camera, scene.dioramaRoot.scale.x, 0, innerHeight); scene.render();
    return { grid: terrain.baseMeshGrid, coverage: window.validateCoverage(), renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  assert.equal(setup.coverage.mismatches, 0); assert.equal(setup.coverage.expectedIndices, setup.coverage.drawnIndices); assert(setup.coverage.holes >= 8);
  await page.screenshot({ path: path.join(out, 'refined-close.png') });
  await page.locator('.btn-exag[data-exag="1.5"]').scrollIntoViewIfNeeded(); await page.click('.btn-exag[data-exag="1.5"]');
  const exaggerated = await page.evaluate(() => {
    const app = window.__trekViewerApp, scene = app.sceneManager, mesh = app.terrainResult.terrainMesh;
    const pos = mesh.geometry.attributes.position;
    let peak = 0; for (let i = 1; i < pos.count; i++) if (pos.getY(i) > pos.getY(peak)) peak = i;
    const target = scene.camera.position.clone().fromBufferAttribute(pos, peak); mesh.localToWorld(target);
    const offset = scene.camera.position.clone().sub(app.controls.target);
    app.controls.target.copy(target); scene.camera.position.copy(target).add(offset); app.controls.update();
    scene.updateCameraClipping(app.controls.getDistance()); scene.render();
    return { coverage: window.validateCoverage(), uploads: [...window.coverageUploads] };
  });
  assert.equal(exaggerated.coverage.mismatches, 0); assert.equal(exaggerated.coverage.expectedIndices, exaggerated.coverage.drawnIndices);
  assert(exaggerated.uploads.some(write => write.elements === exaggerated.coverage.drawnIndices && write.elements < exaggerated.coverage.totalIndices));
  const retired = await page.evaluate(() => {
    const app = window.__trekViewerApp;
    app.activeTrek.localTerrainStreamer.dispose(); app.sceneManager.render();
    return { coverage: window.validateCoverage(), uploads: [...window.coverageUploads], glError: app.sceneManager.renderer.getContext().getError() };
  });
  assert.equal(retired.coverage.mismatches, 0); assert.equal(retired.coverage.holes, 0);
  assert.equal(retired.coverage.drawnIndices, retired.coverage.totalIndices); assert.equal(retired.glError, 0);
  assert.equal(retired.uploads.at(-1).elements, retired.coverage.totalIndices);
  await page.screenshot({ path: path.join(out, 'parent-restored.png') });
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ setup, exaggerated, retired, errors, warnings }, null, 2));
  console.log(JSON.stringify({ setup, exaggerated, retired, errors, warnings }));
} finally { await browser?.close(); server.kill(); }
