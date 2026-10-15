import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const coordinates = '(() => {' + stripTypeScriptTypes(fs.readFileSync('src/gpx/Coordinates.ts', 'utf8'), { mode: 'transform' }).replaceAll('export ', '')
  + ';window.fidelityCoordinates = { latLonToTile, localMetersToGeo };})()';
const out = path.resolve('.review-cache/fidelity'); fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4187', '--strictPort'], { stdio: 'pipe', windowsHide: true });
let browser;
const currentOnly = process.argv.includes('--current-only');
const savedBaseline = fs.existsSync(path.join(out, 'browser.json')) ? path.join(out, 'browser.json') : new URL('./browser.json', import.meta.url);
const previousResult = currentOnly ? JSON.parse(fs.readFileSync(savedBaseline, 'utf8')).variants[0] : null;
const result = { condition: 'Quest user-agent and Quest High policy in desktop Edge; no native immersive session or headset timing', variants: previousResult ? [previousResult] : [] };
try {
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (d.toString().includes('4187')) resolve(); }); server.on('error', reject); setTimeout(() => reject(Error('preview timeout')), 15000); });
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const baselineUrl = process.env.TREK_BASELINE_URL ?? 'https://trekviewer.surge.sh/?profile=1&fidelity=previous';
  for (const [name, url] of [['previous', baselineUrl], ['current', 'https://127.0.0.1:4187/?profile=1']]) {
    if (currentOnly && name === 'previous') continue;
    const context = await browser.newContext({ viewport: { width: 1233, height: 821 }, ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/40.0 Chrome/138.0.0.0 Mobile VR Safari/537.36' });
    const page = await context.newPage(); const errors = [], warnings = [];
    page.on('pageerror', error => errors.push(String(error))); page.on('console', message => { if (['warning', 'error'].includes(message.type())) warnings.push(message.text()); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'), null, { timeout: 90000 });
    await page.addScriptTag({ content: coordinates });
    await page.evaluate(() => {
      document.getElementById('profile-controls')?.remove(); const app = window.__trekViewerApp;
      app.controls.enableDamping = false;
      const point = app.trailResult.routeGeometry.getTelemetryAtProgress(.4).position.clone();
      point.y = app.terrainResult.sampleBaseSurfaceY(point.x, point.z); app.sceneManager.dioramaRoot.localToWorld(point);
      app.controls.target.copy(point); app.sceneManager.camera.position.copy(point).add(point.clone().set(0, .015, .02));
      app.controls.update(); app.sceneManager.updateCameraClipping(app.controls.getDistance());
    });
    const settle = async () => {
      await page.waitForFunction(() => {
        const app = window.__trekViewerApp, s = app.activeTrek.localTerrainStreamer, d = app.activeTrek.imageryLOD.getDiagnostics();
        return !s.busy && !s.ready && !s.readyRemoval && s.wanted.size > 0 && [...s.wanted.keys()].every(key => s.chunks.has(key)) && d.coveragePercent === 100 && d.inFlightRequests === 0 && d.requestQueueLength === 0;
      }, null, { timeout: 240000 });
      await page.waitForTimeout(1200);
    };
    const snapshot = () => page.evaluate(() => {
      const app = window.__trekViewerApp, lod = app.activeTrek.imageryLOD, terrain = app.terrainResult, camera = app.sceneManager.camera, root = app.sceneManager.dioramaRoot;
      const V = camera.position.constructor, R = lod.terrainRaycast.localRay.constructor;
      const { latLonToTile, localMetersToGeo } = window.fidelityCoordinates;
      const surfaces = terrain.terrainMesh.parent.children.filter(mesh => mesh.isMesh && mesh.visible && (mesh === terrain.terrainMesh || mesh.name === 'LocalHighResTerrainMesh'));
      root.updateWorldMatrix(true, true); camera.updateWorldMatrix(true, false);
      const forward = camera.getWorldDirection(new V()), right = new V(1, 0, 0).applyQuaternion(camera.quaternion), up = new V(0, 1, 0).applyQuaternion(camera.quaternion);
      const halfTan = Math.tan(camera.fov * Math.PI / 360), samples = [];
      for (const y of [-.85, -.4, 0, .4, .85]) for (const x of [-.85, -.4, 0, .4, .85]) {
        const direction = forward.clone().addScaledVector(right, x * halfTan * camera.aspect).addScaledVector(up, y * halfTan).normalize();
        const hit = lod.terrainRaycast.closest({ ray: new R(camera.position.clone(), direction), near: 0, far: Infinity }, surfaces);
        if (!hit) continue;
        const local = root.worldToLocal(hit.point.clone()), geo = localMetersToGeo(local.x, local.z, terrain.terrainGeoBounds.centerLat, terrain.terrainGeoBounds.centerLon);
        let bestZoom = 0;
        for (let zoom = 19; zoom >= 13; zoom--) { const tile = latLonToTile(geo.lat, geo.lon, zoom); if (lod.patches.get(`satellite:${zoom}:${tile.x}:${tile.y}`)?.mesh.visible) { bestZoom = zoom; break; } }
        const chunk = terrain.localChunks.find(c => { const b = c.getSurfaceBounds(); return local.x >= b.minX && local.x <= b.maxX && local.z >= b.minZ && local.z <= b.maxZ; });
        const cell = chunk?.getCellSize();
        samples.push({ x, y, imageryZoom: bestZoom || terrain.tileGrid?.zoom || 0, detailedTerrain: Boolean(chunk), cellXM: cell?.x ?? terrain.baseMeshGrid.width / terrain.baseMeshGrid.segmentsX, cellZM: cell?.z ?? terrain.baseMeshGrid.depth / terrain.baseMeshGrid.segmentsZ });
      }
      const diagnostics = lod.getDiagnostics(), gl = app.sceneManager.renderer.getContext();
      const summary = { hitSamples: samples.length, highImagerySamples: samples.filter(s => s.imageryZoom === 19).length, minImageryZoom: Math.min(...samples.map(s => s.imageryZoom)), meanImageryZoom: samples.reduce((n, s) => n + s.imageryZoom, 0) / samples.length, detailedDemSamples: samples.filter(s => s.detailedTerrain).length, maxSampleCellM: Math.max(...samples.flatMap(s => [s.cellXM, s.cellZM])), meanSampleCellM: samples.reduce((n, s) => n + (s.cellXM + s.cellZM) / 2, 0) / samples.length };
      return { summary, samples, diagnostics, profile: lod.getQualityProfile().name, chunks: terrain.localChunks.length, detailedVertices: terrain.localChunks.reduce((n, c) => n + c.totalVertices, 0), cellSizes: terrain.localChunks.map(c => c.getCellSize()), camera: camera.position.toArray(), quaternion: camera.quaternion.toArray(), progress: app.session.getState().progress, glError: gl.getError(), drawCalls: app.sceneManager.renderer.info.render.calls, textures: app.sceneManager.renderer.info.memory.textures, renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) };
    });
    await settle(); const tabletop = await snapshot();
    assert.equal(tabletop.profile, 'quest-high'); assert.equal(tabletop.glError, 0);
    await page.screenshot({ path: path.join(out, `${name}-tabletop.png`) });
    await page.evaluate(() => { const app = window.__trekViewerApp; app.flyoverController.setProgress(.4); app.session.setProgress(.4); });
    await page.click('#btnViewToggle'); await settle(); const walking = await snapshot();
    assert.equal(walking.glError, 0); assert(walking.summary.hitSamples > 0);
    await page.screenshot({ path: path.join(out, `${name}-walking.png`) });
    await page.evaluate(() => {
      const app = window.__trekViewerApp, original = app.flyoverController.update.bind(app.flyoverController);
      app.flyoverController.update = (...args) => { original(...args); app.sceneManager.camera.rotateY(25 * Math.PI / 180); };
      app.activeTrek.imageryLOD.evaluationDirty = true;
    });
    await settle(); const turned = await snapshot(); assert.equal(turned.glError, 0);
    await page.screenshot({ path: path.join(out, `${name}-turned.png`) });
    await page.evaluate(() => window.__trekViewerApp.startProfile()); await page.waitForTimeout(5000);
    const profile = await page.evaluate(() => { const app = window.__trekViewerApp; app.stopProfile(); return app.completedProfile; });
    fs.writeFileSync(path.join(out, `${name}-profile.json`), JSON.stringify(profile, null, 2) + '\n');
    assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
    const entry = { name, url, tabletop, walking, turned, errors, warnings }; result.variants.push(entry);
    fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ name, tabletop: tabletop.summary, walking: walking.summary, turned: turned.summary, chunks: turned.chunks, patches: turned.diagnostics.activePatchesCount }));
    await context.close();
  }
  const [previous, current] = result.variants;
  assert(current.tabletop.detailedVertices > previous.tabletop.detailedVertices);
  assert(current.walking.cellSizes.every(c => c.x <= 5.001 && c.z <= 5.001));
  assert(current.walking.summary.highImagerySamples >= previous.walking.summary.highImagerySamples);
  assert(current.walking.summary.meanImageryZoom >= previous.walking.summary.meanImageryZoom);
  assert(current.tabletop.summary.meanSampleCellM < previous.tabletop.summary.meanSampleCellM);
  assert(current.walking.chunks <= 64 && current.walking.detailedVertices <= 800000);
  assert(current.turned.diagnostics.activePatchesCount <= 512);
  for (const view of [current.tabletop, current.walking, current.turned]) {
    assert.equal(view.summary.highImagerySamples, view.summary.hitSamples);
    assert.equal(view.summary.detailedDemSamples, view.summary.hitSamples);
    assert(view.summary.maxSampleCellM <= 5.001);
  }
  result.checksPassed = true; fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
} finally { await browser?.close(); server.kill(); }
