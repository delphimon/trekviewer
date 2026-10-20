import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = process.env.TREK_BATCH_OUT ?? '.review-cache/imagery-batch';
const base = process.env.TREK_BATCH_URL ?? 'https://127.0.0.1:4211/';
const expected = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
const entry = path.posix.basename(fs.readFileSync('dist/index.html', 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
let browser, server;
try {
  if (!process.env.TREK_BATCH_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4211', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4211')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 } });
  const errors = [], shaderErrors = [], glWarnings = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', message => { if (message.type() === 'error' && /Shader|VALIDATE_STATUS|GL_INVALID|program|compile/i.test(message.text())) shaderErrors.push(message.text()); });
  page.on('console', message => { if (/INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM/.test(message.text())) glWarnings.push(message.text()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === new URL(base).origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await page.goto(base + '?debug=1&imageryBatch=1&terrainTiles=0&regionalBase=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.activeTrek && window.__trekViewerApp.session.getState().loadingPhase === 'ready', null, { timeout: 60000 });
  assert.ok(await page.evaluate(entry => [...document.scripts].some(script => script.src.endsWith('/' + entry)), entry));
  const build = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
  assert.equal(build.id, expected.id);
  const result = await page.evaluate(async () => {
    const app = window.__trekViewerApp, renderer = app.sceneManager.renderer;
    renderer.setAnimationLoop(null); app.activeTrek.localTerrainStreamer?.dispose(); app.flyoverController.pause();
    const lod = app.activeTrek.imageryLOD;
    for (const pending of lod.pendingRequests.values()) pending.abortController.abort();
    lod.pendingRequests.clear(); lod.requestQueue.length = 0; lod.clearAllPatches();
    lod.update = () => {};
    lod.syncRenderer(renderer);
    const gl = renderer.getContext();
    const capability = { multiDraw: !!gl.getExtension('WEBGL_multi_draw'), arrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), status: lod.getBatchDiagnostics().status };
    if (capability.status !== 'active') return { capability };
    const scene = new app.sceneManager.scene.constructor();
    scene.background = app.sceneManager.sunLight.color.clone().setHex(0x243347);
    for (const light of app.sceneManager.scene.children.filter(child => child.isLight)) scene.add(light.clone());
    lod.group.removeFromParent(); scene.add(lod.group);
    const source = app.activeTrek.terrainResult.terrainMesh, patches = new Map();
    for (let i = 0; i < 64; i++) {
      const image = document.createElement('canvas'); image.width = image.height = 256;
      const ctx = image.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 256, 256);
      gradient.addColorStop(0, `hsl(${i * 17 % 360},85%,70%)`); gradient.addColorStop(1, `hsl(${(i * 17 + 150) % 360},70%,22%)`);
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#ff2222'; ctx.fillRect(0, 0, 35, 75);
      ctx.fillStyle = '#22ff33'; ctx.fillRect(190, 0, 66, 30);
      ctx.fillStyle = '#2233ff'; ctx.fillRect(0, 220, 80, 36);
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 50px sans-serif'; ctx.fillText(String(i), 85, 145);
      const texture = new source.material.map.constructor(image);
      // CanvasTexture semantics from the production imagery path.
      texture.colorSpace = 'srgb'; texture.minFilter = 1008; texture.magFilter = 1006; texture.generateMipmaps = true;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); texture.needsUpdate = true;
      const geometry = new source.geometry.constructor(1, 1, 6, 6); geometry.rotateX(-Math.PI / 2);
      const positions = geometry.attributes.position;
      for (let v = 0; v < positions.count; v++) positions.setY(v, 0.18 * Math.sin(positions.getX(v) * 5) + 0.1 * Math.cos(positions.getZ(v) * 4));
      geometry.computeVertexNormals(); geometry.computeBoundingSphere();
      const material = source.material.clone(); material.map = texture; material.roughness = 0.9; material.metalness = 0;
      material.polygonOffset = true; material.polygonOffsetFactor = material.polygonOffsetUnits = -1.75;
      material.transparent = false; material.opacity = 1; material.depthWrite = true; material.visible = true;
      // Production imagery stores world-local coordinates in each vertex and
      // uses identity member transforms; the diorama parent owns room placement.
      geometry.translate(i % 8 - 3.5, 0, Math.floor(i / 8) - 3.5);
      const mesh = new source.constructor(geometry, material); mesh.renderOrder = 1.75;
      lod.group.add(mesh);
      const patch = { key: `fixture-${i}`, zoom: 19, x: i % 8, y: Math.floor(i / 8), mesh, texture, isFading: false,
        dispose() { mesh.geometry.dispose(); material.dispose(); texture.dispose(); } };
      patches.set(patch.key, patch);
    }
    lod.patches = patches;
    renderer.setSize(640, 480, false); renderer.setPixelRatio(1);
    const camera = app.sceneManager.camera.clone(); camera.position.set(0, 6.5, 8.5); camera.lookAt(0, 0, 0);
    camera.aspect = 640 / 480; camera.near = 0.1; camera.far = 100; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const capture = view => {
      renderer.render(scene, view);
      const pixels = new Uint8Array(640 * 480 * 4); gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, error: gl.getError() };
    };
    const compare = (name, a, b) => {
      let maxError = 0, differingPixels = 0;
      for (let i = 0; i < a.pixels.length; i += 4) {
        let difference = 0;
        for (let c = 0; c < 4; c++) difference = Math.max(difference, Math.abs(a.pixels[i + c] - b.pixels[i + c]));
        maxError = Math.max(maxError, difference); if (difference > 2) differingPixels++;
      }
      return { name, maxError, differingPixels, legacyCalls: a.calls, batchedCalls: b.calls,
        legacyTriangles: a.triangles, batchedTriangles: b.triangles, errors: [a.error, b.error], diagnostics: lod.getBatchDiagnostics() };
    };
    const settle = () => { for (let i = 0; i < patches.size + 2; i++) lod.syncRenderer(renderer); };
    const baseline = capture(camera); settle(); const batched = capture(camera);
    const results = [compare('opaque', baseline, batched)];
    const snapshots = {};
    for (const [name, frame] of [['legacy', baseline], ['batched', batched]]) {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'), data = ctx.createImageData(640, 480);
      for (let row = 0; row < 480; row++) data.data.set(frame.pixels.subarray(row * 640 * 4, (row + 1) * 640 * 4), (479 - row) * 640 * 4);
      ctx.putImageData(data, 0, 0); snapshots[name] = canvas.toDataURL('image/png');
    }
    // Promotion changes every source before a single frame; only two can be rebatched.
    lod.releaseBatches();
    for (const p of patches.values()) {
      p.mesh.geometry.attributes.position.setY(20, 0.8); p.mesh.geometry.attributes.position.needsUpdate = true;
      p.mesh.geometry.computeVertexNormals(); p.mesh.geometry.computeBoundingSphere();
    }
    const promoted = capture(camera); settle();
    // Invalidate all existing batch copies once more to exercise same-frame fallback.
    for (const p of patches.values()) { p.mesh.geometry.attributes.position.needsUpdate = true; }
    lod.syncRenderer(renderer); results.push(compare('promotion-fallback', promoted, capture(camera)));
    settle(); results.push(compare('promotion-settled', promoted, capture(camera)));
    const fade = [...patches.values()][11]; fade.isFading = true; fade.mesh.material.transparent = true; fade.mesh.material.opacity = 0.4; fade.mesh.material.depthWrite = false;
    for (const [i, p] of [...patches.values()].entries()) p.mesh.visible = i % 5 !== 0;
    lod.releaseBatches(); const mixed = capture(camera); settle(); results.push(compare('fade-and-visibility', mixed, capture(camera)));
    fade.isFading = false; fade.mesh.material.transparent = false; fade.mesh.material.opacity = 1; fade.mesh.material.depthWrite = true;
    for (const p of patches.values()) p.mesh.visible = true;
    const eyes = [-0.04, 0.04].map((offset, i) => {
      const eye = camera.clone(); eye.position.x += offset; eye.aspect = 320 / 480; eye.updateProjectionMatrix(); eye.updateMatrixWorld();
      eye.viewport = { x: i * 320, y: 0, z: 320, w: 480 }; return eye;
    });
    const array = new (renderer.xr.getCamera().constructor)(eyes);
    array.position.copy(camera.position); array.quaternion.copy(camera.quaternion); array.projectionMatrix.copy(camera.projectionMatrix); array.updateMatrixWorld();
    lod.releaseBatches(); const stereo = capture(array); settle(); results.push(compare('stereo', stereo, capture(array)));
    // Room placement belongs to the common parent, including non-unit scale.
    lod.group.position.set(0.3, -0.2, 0.4); lod.group.rotation.y = 0.61; lod.group.scale.setScalar(0.65);
    for (const [name, height, distance] of [['placed-oblique', 1.3, 6], ['placed-distant-mips', 17, 27]]) {
      camera.position.set(0, height, distance); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      lod.releaseBatches(); const before = capture(camera); settle(); results.push(compare(name, before, capture(camera)));
    }
    lod.group.position.set(0, 0, 0); lod.group.rotation.y = 0; lod.group.scale.setScalar(1);
    camera.position.set(0, 6.5, 8.5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    // Coarse coverage remains underneath opaque and fading finer patches.
    lod.releaseBatches();
    for (let i = 0; i < 8; i++) {
      const original = [...patches.values()][i];
      const material = original.mesh.material.clone(), geometry = original.mesh.geometry.clone();
      geometry.translate(0, -0.04, 0);
      material.polygonOffsetFactor = material.polygonOffsetUnits = -1.375;
      const mesh = new source.constructor(geometry, material); mesh.renderOrder = 1.375; lod.group.add(mesh);
      const coarse = { ...original, key: 'coarse-' + i, mesh, zoom: 16 };
      // Separate texture object, as in independently downloaded source tiles.
      coarse.texture = original.texture.clone(); coarse.texture.needsUpdate = true; material.map = coarse.texture;
      patches.set(coarse.key, coarse);
    }
    fade.isFading = true; fade.mesh.material.transparent = true; fade.mesh.material.opacity = 0.4; fade.mesh.material.depthWrite = false;
    const overlap = capture(camera); settle(); results.push(compare('zoom-overlap-and-fade', overlap, capture(camera)));
    fade.isFading = false; fade.mesh.material.transparent = false; fade.mesh.material.opacity = 1; fade.mesh.material.depthWrite = true;
    // Put tiles across different eye-frustum edges rather than testing only a centered model.
    for (let i = 0; i < eyes.length; i++) { eyes[i].position.x = i === 0 ? -3 : 3; eyes[i].lookAt(i === 0 ? -3 : 3, 0, 0); eyes[i].updateMatrixWorld(); }
    lod.releaseBatches(); const edges = capture(array); settle(); results.push(compare('stereo-frustum-edges', edges, capture(array)));
    // Exercise the production loss handler, which must destroy batch internals
    // before the generic resource release and recreate them from retained sources.
    const loss = gl.getExtension('WEBGL_lose_context');
    if (!loss) throw Error('Context-loss fixture requires WEBGL_lose_context');
    const beforeLoss = capture(camera), revision = app.graphicsRecovery.revision;
    // The isolated render fixture normally lives outside the app scene. Put it
    // under its owning trek for loss so production traversal can release every
    // source handle, exactly as it does for real imagery. Detach before readback.
    app.activeTrek.group.add(scene);
    const lost = new Promise(resolve => renderer.domElement.addEventListener('webglcontextlost', resolve, { once: true }));
    loss.loseContext(); await lost;
    const clearedOnLoss = lod.getBatchDiagnostics().patches === 0;
    // Browsers defer making a deliberately lost context restorable until a
    // subsequent task; restoring inside the loss dispatch can be ignored.
    await new Promise(resolve => setTimeout(resolve, 250));
    const restored = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Context restore event timeout')), 15000);
      renderer.domElement.addEventListener('webglcontextrestored', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    loss.restoreContext(); await restored;
    const deadline = performance.now() + 15000;
    while (app.graphicsRecovery.isSuspended && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (app.graphicsRecovery.isSuspended) throw Error('Application graphics recovery did not finish');
    renderer.setAnimationLoop(null); scene.removeFromParent();
    const recoverySetupError = gl.getError();
    settle();
    results.push(compare('context-recovery', beforeLoss, capture(camera)));
    const recovery = { clearedOnLoss, revisionAdvanced: app.graphicsRecovery.revision > revision, setupError: recoverySetupError };
    // High-sized working set: do not silently drop source coverage at the cap.
    lod.releaseBatches();
    const template = [...patches.values()][0];
    for (let i = patches.size; i < 448; i++) {
      const geometry = template.mesh.geometry.clone(); geometry.translate((i % 8) * 0.025, -0.1 - i * 0.002, 0);
      const material = template.mesh.material.clone(), texture = template.texture.clone(); texture.needsUpdate = true; material.map = texture;
      const mesh = new source.constructor(geometry, material); mesh.renderOrder = template.mesh.renderOrder; lod.group.add(mesh);
      patches.set('stress-' + i, { ...template, key: 'stress-' + i, mesh, texture });
    }
    const high = capture(camera); settle(); results.push(compare('448-source-patches-budget-fallback', high, capture(camera)));
    const budget = lod.getBatchDiagnostics();
    const lifecycle = [];
    for (let i = 0; i < 3; i++) {
      lod.releaseBatches(); capture(camera);
      lifecycle.push({ ...lod.getBatchDiagnostics(), geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });
      settle(); capture(camera);
    }
    // A missing extension must keep every source tile and its native texture.
    const has = renderer.extensions.has.bind(renderer.extensions);
    lod.releaseBatches(); renderer.extensions.has = name => name === 'WEBGL_multi_draw' ? false : has(name);
    lod.syncRenderer(renderer); const unsupported = lod.getBatchDiagnostics().status;
    const fallback = capture(camera); renderer.extensions.has = has; lod.releaseBatches();
    const sourceAgain = capture(camera); results.push(compare('unsupported-fallback', sourceAgain, fallback));
    const sourceImagesRetained = [...patches.values()].every(p => p.texture.image.width === 256 && p.texture.image.height === 256);
    return { capability, results, unsupported, sourceImagesRetained, recovery, budget, lifecycle, snapshots };
  });
  fs.mkdirSync(out, { recursive: true });
  for (const [name, png] of Object.entries(result.snapshots ?? {})) fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
  delete result.snapshots;
  const evidence = { condition: 'Production desktop WebGL2 renderer; generated native-size 256px color/label tiles and lit, deformed source meshes, growing from 64 to 448 patches. ArrayCamera stereo is a controlled browser test, not native headset delivery. Readback compares every RGBA pixel.', build, entry, result, errors, shaderErrors, glWarnings };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
  assert.equal(result.capability.status, 'active', 'Desktop prototype requires actual array and multi-draw support');
  assert.deepEqual(errors, []); assert.deepEqual(shaderErrors, []);
  assert.deepEqual(glWarnings, []);
  for (const row of result.results) { assert.equal(row.differingPixels, 0, row.name); assert.deepEqual(row.errors, [0, 0]); }
  assert.ok(result.results[0].batchedCalls < result.results[0].legacyCalls / 4);
  assert.equal(result.unsupported, 'unsupported'); assert.equal(result.sourceImagesRetained, true);
  assert.deepEqual(result.recovery, { clearedOnLoss: true, revisionAdvanced: true, setupError: 0 });
  assert.ok(result.budget.arrayBytes <= 128 * 1024 * 1024 && result.budget.geometryBytes <= 32 * 1024 * 1024);
  assert.ok(result.budget.patches < 448 && result.budget.patches > 0);
  assert.ok(result.lifecycle.every(row => row.pages === 0 && row.patches === 0 && row.arrayBytes === 0 && row.geometryBytes === 0));
  assert.equal(new Set(result.lifecycle.map(row => row.geometries + '/' + row.textures)).size, 1, 'Released geometry/texture counts must plateau');
} finally { await browser?.close(); server?.kill(); }
