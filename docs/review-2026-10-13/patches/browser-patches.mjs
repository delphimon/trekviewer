import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { PNG } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/lib/utilsBundle.js');
const geometryScript = (file, name) => '(() => {' + stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'transform' })
  .replace("import * as THREE from 'three';", 'const THREE = window.patchThree;')
  .replace('export function buildSurfacePatchGeometry', 'function buildSurfacePatchGeometry') + `;window.${name} = buildSurfacePatchGeometry;})()`;
const previousSource = geometryScript(new URL('./SurfacePatchGeometry-before.ts', import.meta.url), 'previousPatchBuilder');
const currentSource = geometryScript(path.resolve('src/terrain/SurfacePatchGeometry.ts'), 'currentPatchBuilder');
const coordinatesSource = '(() => {' + stripTypeScriptTypes(fs.readFileSync('src/gpx/Coordinates.ts', 'utf8'), { mode: 'transform' }).replaceAll('export ', '')
  + ';window.patchCoordinates = { tileBounds, geoToLocalMeters, localMetersToGeo, clampLatitude, degToRad };})()';
const compare = (a, b) => {
  const first = PNG.sync.read(a), second = PNG.sync.read(b);
  assert.equal(first.width, second.width); assert.equal(first.height, second.height);
  let changedPixels = 0, maxChannelDifference = 0;
  for (let i = 0; i < first.data.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 4; c++) { const difference = Math.abs(first.data[i + c] - second.data[i + c]); changed ||= difference > 0; maxChannelDifference = Math.max(maxChannelDifference, difference); }
    if (changed) changedPixels++;
  }
  return { changedPixels, maxChannelDifference, totalPixels: first.width * first.height };
};
const out = path.resolve('.review-cache/patches'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4186', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser; const errors = [], warnings = [];
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4186')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
  await page.goto('https://127.0.0.1:4186/?profile=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'), null, { timeout: 90000 });
  await page.waitForFunction(() => { const s = window.__trekViewerApp.activeTrek.localTerrainStreamer; return s.chunks.size === s.wanted.size && s.chunks.size === 24 && !s.busy && !s.ready; }, null, { timeout: 90000 });
  await page.evaluate(() => {
    document.getElementById('profile-controls')?.remove(); const app = window.__trekViewerApp;
    app.controls.enableDamping = false; app.activeTrek.localTerrainStreamer.update = () => {};
    const point = app.trailResult.routeGeometry.getTelemetryAtProgress(.4).position.clone();
    point.y = app.terrainResult.sampleRenderedSurfaceY(point.x, point.z); app.sceneManager.dioramaRoot.localToWorld(point);
    app.controls.target.copy(point); app.sceneManager.camera.position.copy(point).add(point.clone().set(0, .015, .02));
    app.controls.update(); app.sceneManager.updateCameraClipping(app.controls.getDistance());
  });
  await page.waitForFunction(() => { const d = window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics(); return d.desiredZoom === 19 && d.coveragePercent === 100 && d.inFlightRequests === 0 && d.requestQueueLength === 0; }, null, { timeout: 90000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const app = window.__trekViewerApp, geometry = app.terrainResult.terrainMesh.geometry;
    app.sceneManager.renderer.setAnimationLoop(null);
    window.patchThree = { PlaneGeometry: geometry.constructor, Mesh: app.terrainResult.terrainMesh.constructor, BufferGeometry: Object.getPrototypeOf(geometry.constructor), Float32BufferAttribute: geometry.attributes.position.constructor };
    app.sceneManager.dioramaRoot.updateWorldMatrix(true, true);
  });
  await page.addScriptTag({ content: previousSource }); await page.addScriptTag({ content: currentSource }); await page.addScriptTag({ content: coordinatesSource });
  const geometry = await page.evaluate(() => {
    const app = window.__trekViewerApp, lod = app.activeTrek.imageryLOD, base = app.terrainResult.terrainMesh;
    const { tileBounds, geoToLocalMeters, localMetersToGeo, clampLatitude, degToRad } = window.patchCoordinates;
    const { centerLat, centerLon } = lod.options.terrainGeoBounds;
    window.patchPairs = []; let vertices = 0, triangles = 0;
    const equal = (a, b) => a.constructor === b.constructor && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    for (const patch of lod.patches.values()) {
      if (!patch.mesh.visible) continue;
      const tb = tileBounds(patch.x, patch.y, patch.zoom);
      const nw = geoToLocalMeters(tb.nw.lat, tb.nw.lon, 0, centerLat, centerLon, 0), se = geoToLocalMeters(tb.se.lat, tb.se.lon, 0, centerLat, centerLon, 0);
      const bounds = { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z };
      const uv = (x, z) => {
        const point = localMetersToGeo(x, z, centerLat, centerLon), sin = Math.sin(degToRad(clampLatitude(point.lat)));
        const tileY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** patch.zoom;
        return { u: (point.lon - tb.nw.lon) / (tb.se.lon - tb.nw.lon), v: 1 - (tileY - patch.y) };
      };
      const before = window.previousPatchBuilder(base, bounds, uv), after = window.currentPatchBuilder(base, bounds, uv);
      for (const attribute of ['position', 'normal', 'uv']) if (!equal(before.attributes[attribute].array, after.attributes[attribute].array)) throw Error(`${patch.key}: ${attribute} changed`);
      if (!equal(before.index.array, after.index.array)) throw Error(`${patch.key}: indices changed`);
      if (!before.boundingBox.equals(after.boundingBox) || !before.boundingSphere.equals(after.boundingSphere)) throw Error(`${patch.key}: bounds changed`);
      vertices += after.attributes.position.count; triangles += after.index.count / 3;
      window.patchPairs.push({ mesh: patch.mesh, original: patch.mesh.geometry, before, after }); patch.mesh.geometry = before;
    }
    app.sceneManager.render(); app.sceneManager.render();
    return { patches: window.patchPairs.length, vertices, triangles, exactBuffersAndBounds: true, chunks: app.terrainResult.localChunks.length, detailedVertices: app.terrainResult.localChunks.reduce((n, chunk) => n + chunk.totalVertices, 0), imagery: lod.getDiagnostics(), calls: app.sceneManager.renderer.info.render.calls, textures: app.sceneManager.renderer.info.memory.textures, glError: app.sceneManager.renderer.getContext().getError() };
  });
  assert(geometry.patches > 0 && geometry.vertices > 0); assert.equal(geometry.glError, 0);
  const canvas = page.locator('#canvas-container canvas').first();
  const before = await canvas.screenshot({ path: path.join(out, 'previous.png') });
  await page.evaluate(() => window.__trekViewerApp.sceneManager.render());
  const repeat = await canvas.screenshot({ path: path.join(out, 'previous-repeat.png') });
  const current = await page.evaluate(() => {
    const app = window.__trekViewerApp;
    for (const pair of window.patchPairs) pair.mesh.geometry = pair.after;
    app.sceneManager.render(); app.sceneManager.render(); const gl = app.sceneManager.renderer.getContext();
    return { calls: app.sceneManager.renderer.info.render.calls, textures: app.sceneManager.renderer.info.memory.textures, glError: gl.getError(), renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
  });
  const after = await canvas.screenshot({ path: path.join(out, 'current.png') });
  const renderingDifference = compare(repeat, after), repeatDifference = compare(before, repeat);
  assert(renderingDifference.changedPixels <= 4 && renderingDifference.maxChannelDifference <= 1, JSON.stringify(renderingDifference));
  for (const key of ['calls', 'textures', 'glError']) assert.equal(current[key], geometry[key]); assert.equal(current.glError, 0);
  await page.evaluate(() => { for (const pair of window.patchPairs) { pair.mesh.geometry = pair.original; pair.before.dispose(); pair.after.dispose(); } });
  await page.setViewportSize({ width: 390, height: 844 }); await page.click('#btnSettings'); await page.click('#btnFitTerrain');
  await page.evaluate(() => window.__trekViewerApp.sceneManager.render()); await page.screenshot({ path: path.join(out, 'mobile.png') });
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
  const result = { geometry, current, renderingDifference, repeatDifference, errors, warnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.kill(); }
