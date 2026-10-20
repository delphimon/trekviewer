import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_TERRAIN_IMAGERY_URL ?? 'https://127.0.0.1:4213/';
const out = process.env.TREK_TERRAIN_IMAGERY_OUT ?? '.review-cache/direct-terrain/controlled';
const expected = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
let browser, server;
try {
  if (!process.env.TREK_TERRAIN_IMAGERY_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4213', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview timeout')), 15000);
      server.stdout.on('data', d => { if (d.toString().includes('4213')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 800, height: 600 } });
  const errors = [], shaderErrors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (/INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM|VALIDATE_STATUS|Shader Error/.test(message.text())) shaderErrors.push(message.text().slice(0, 2000)); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === new URL(base).origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await page.goto(base + '?profile=1&terrainImagery=1&terrainTiles=0&regionalBase=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 60000 });
  const build = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json()); assert.equal(build.id, expected.id);
  const result = await page.evaluate(async () => {
    const app = window.__trekViewerApp, terrain = app.activeTrek.terrainResult, renderer = app.sceneManager.renderer, lod = app.activeTrek.imageryLOD;
    renderer.setAnimationLoop(null); app.activeTrek.localTerrainStreamer?.dispose();
    // Canonical metre-space fixture: camera distances below are geographical
    // metres, not the application's normal sub-metre tabletop coordinates.
    app.sceneManager.dioramaRoot.position.set(0, 0, 0); app.sceneManager.dioramaRoot.scale.setScalar(1);
    app.sceneManager.dioramaRoot.rotation.set(0, 0, 0); app.sceneManager.dioramaRoot.updateMatrixWorld(true);
    app.sceneManager.skyMesh.visible = false;
    app.sceneManager.scene.background = app.sceneManager.sunLight.color.clone().setHex(0x243347);
    for (const pending of lod.pendingRequests.values()) pending.abortController.abort();
    lod.pendingRequests.clear(); lod.requestQueue.length = 0; lod.update = () => {}; lod.clearAllPatches(); lod.enableFadeIn = false; await lod.releaseBatches();
    // Keep production terrain ownership for recovery, but hide unrelated draws.
    for (const child of app.activeTrek.group.children) if (child !== terrain.group && child !== lod.group) child.visible = false;
    for (const child of terrain.group.children) if (child !== terrain.terrainMesh) child.visible = false;
    renderer.shadowMap.enabled = false;
    const source = terrain.terrainMesh, b = terrain.terrainGeoBounds;
    const positions = source.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) positions.setY(i, 200 * Math.sin(positions.getX(i) * 0.0003) * Math.cos(positions.getZ(i) * 0.0003));
    positions.needsUpdate = true; source.geometry.computeVertexNormals(); source.geometry.computeBoundingSphere(); source.geometry.dispose();
    const toTile = (lat, lon, z) => ({ x: Math.floor((lon + 180) / 360 * 2 ** z), y: Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z) });
    const add = (z, x, y, index) => {
      const image = document.createElement('canvas'); image.width = image.height = 256;
      const ctx = image.getContext('2d'); ctx.fillStyle = `hsl(${index * 47 % 360},80%,50%)`; ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#ffffff'; for (let i = 0; i < 256; i += 16) { ctx.fillRect(i, 0, 2, 256); ctx.fillRect(0, i, 256, 2); }
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 35, 75); ctx.fillStyle = '#00ff00'; ctx.fillRect(190, 0, 66, 30);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 220, 80, 36); ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px sans-serif'; ctx.fillText(z + ':' + index, 55, 140);
      lod.createAndMountPatch(`satellite:${z}:${x}:${y}`, z, x, y, image, 0, performance.now());
    };
    const nw = toTile(b.maxLat, b.minLon, 13), se = toTile(b.minLat, b.maxLon, 13);
    let index = 0;
    for (let y = nw.y; y <= se.y; y++) for (let x = nw.x; x <= se.x; x++) add(13, x, y, index++);
    const center = toTile(b.centerLat, b.centerLon, 19);
    for (let y = center.y; y <= center.y + 1; y++) for (let x = center.x; x <= center.x + 1; x++) add(19, x, y, index++);
    // The fixture keeps all coarse and fine patches present to exercise overlap.
    for (const p of lod.patches.values()) p.mesh.visible = true;
    const gl = renderer.getContext(), camera = app.sceneManager.camera;
    renderer.setPixelRatio(1); renderer.setSize(800, 600, false); camera.aspect = 800 / 600;
    const snapshots = {}, results = [];
    const capture = (view = camera) => {
      renderer.setViewport(0, 0, 800, 600);
      renderer.render(app.sceneManager.scene, view); const pixels = new Uint8Array(800 * 600 * 4);
      gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let nonUniformPixels = 0;
      for (let i = 4; i < pixels.length; i += 4) if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) nonUniformPixels++;
      return { pixels, nonUniformPixels, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, error: gl.getError() };
    };
    const settle = () => { for (let i = 0; i < lod.patches.size + 2; i++) lod.syncRenderer(renderer); };
    const compare = (name, a, c) => {
      let sum = 0, square = 0, max = 0, changed = 0;
      for (let i = 0; i < a.pixels.length; i += 4) {
        let pixel = 0;
        for (let j = 0; j < 4; j++) { const e = Math.abs(a.pixels[i + j] - c.pixels[i + j]); sum += e; square += e * e; pixel = Math.max(pixel, e); }
        max = Math.max(max, pixel); if (pixel > 2) changed++;
      }
      return { name, mean: sum / a.pixels.length, rms: Math.sqrt(square / a.pixels.length), max, changed,
        calls: [a.calls, c.calls], triangles: [a.triangles, c.triangles], errors: [a.error, c.error], foreground: [a.nonUniformPixels, c.nonUniformPixels] };
    };
    const extent = Math.max(b.widthMeters, b.depthMeters);
    const views = [['whole', extent * 0.8, extent * 0.7, 0, 0], ['mip-distance', extent * 2, extent * 2, 0, 0],
      ['fine-inspection', 140, 160, 0, 0], ['fine-top', 200, 0.001, 0, 0]];
    for (const [name, height, distance, x, z] of views) {
      camera.position.set(x, height, z + distance); camera.lookAt(x, 0, z); camera.near = Math.max(0.1, height * 0.005); camera.far = extent * 10; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      await lod.releaseBatches(); const a = capture(); settle(); const c = capture(); results.push(compare(name, a, c));
      if (name === 'whole') for (const [label, frame] of [['legacy', a], ['terrain', c]]) {
        const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
        const ctx = canvas.getContext('2d'), data = ctx.createImageData(800, 600);
        for (let y = 0; y < 600; y++) data.data.set(frame.pixels.subarray(y * 3200, (y + 1) * 3200), (599 - y) * 3200);
        ctx.putImageData(data, 0, 0); snapshots[label] = canvas.toDataURL('image/png');
      }
    }
    const fine = [...lod.patches.values()].find(p => p.zoom === 19);
    fine.isFading = true; fine.mesh.material.transparent = true; fine.mesh.material.opacity = 0.4; fine.mesh.material.depthWrite = false;
    await lod.releaseBatches(); const fade = capture(); settle(); results.push(compare('coarse-fine-fade', fade, capture()));
    fine.isFading = false; fine.mesh.material.transparent = false; fine.mesh.material.opacity = 1; fine.mesh.material.depthWrite = true;
    const eyes = [-0.04, 0.04].map((offset, i) => {
      const eye = camera.clone(); eye.position.x += offset; eye.aspect = 400 / 600; eye.viewport = { x: i * 400, y: 0, z: 400, w: 600 };
      eye.updateProjectionMatrix(); eye.updateMatrixWorld(); return eye;
    });
    const stereo = new (renderer.xr.getCamera().constructor)(eyes);
    stereo.position.copy(camera.position); stereo.quaternion.copy(camera.quaternion); stereo.projectionMatrix.copy(camera.projectionMatrix); stereo.updateMatrixWorld();
    await lod.releaseBatches(); const stereoBefore = capture(stereo); settle(); results.push(compare('stereo-close-inspection', stereoBefore, capture(stereo)));
    const loss = gl.getExtension('WEBGL_lose_context');
    const savedCamera = camera.clone();
    const before = capture();
    const lost = new Promise(resolve => renderer.domElement.addEventListener('webglcontextlost', resolve, { once: true })); loss.loseContext(); await lost;
    await new Promise(resolve => setTimeout(resolve, 250));
    const restored = new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('Restore timeout')), 15000); renderer.domElement.addEventListener('webglcontextrestored', () => { clearTimeout(t); resolve(); }, { once: true }); });
    loss.restoreContext(); await restored;
    const deadline = performance.now() + 20000;
    while (app.graphicsRecovery.isSuspended && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (app.graphicsRecovery.isSuspended) throw Error('Recovery did not complete');
    renderer.setAnimationLoop(null); camera.copy(savedCamera); camera.updateMatrixWorld();
    settle(); results.push(compare('context-recovery', before, capture()));
    const range = mesh => { const a = mesh.geometry.attributes.position; let min = Infinity, max = -Infinity; for (let i = 0; i < a.count; i++) { min = Math.min(min, a.getY(i)); max = Math.max(max, a.getY(i)); } return { type: mesh.geometry.type, min, max }; };
    return { results, snapshots, batch: lod.getBatchDiagnostics(), surfaceAudit: { base: range(source), patch: range([...lod.patches.values()][0].mesh), sameBase: lod.options.terrainMesh === source } };
  });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, png] of Object.entries(result.snapshots)) fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
  delete result.snapshots;
  const evidence = { build, condition: 'Production direct-terrain shader; generated native-size labeled imagery, actual geographic UVs and clipped reference geometry, hilly source terrain, Z13/Z19 overlap, distant mip and close inspection views, real context recovery. No native XR claim.', result, errors, shaderErrors };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
  assert.deepEqual(errors, []); assert.deepEqual(shaderErrors, []);
  assert.ok(result.results.every(row => row.errors.every(e => e === 0)));
  assert.ok(result.results.every(row => row.foreground.every(count => count > 500)), 'Every compared view must actually see the textured terrain');
  // Native geographic UV interpolation and removing clipped triangle edges
  // change a small number of rasterized pixels. State the tolerance explicitly.
  assert.ok(result.results.every(row => row.mean <= 0.1 && row.rms <= 2 && row.changed <= 480000 * 0.006), 'Controlled geographic rendering differs beyond edge tolerance');
} finally { await browser?.close(); server?.kill(); }
