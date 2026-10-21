import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_TOUR_OUT ?? '.review-cache/diorama-tour');
fs.mkdirSync(out, { recursive: true });
const expectedBuild = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'));
const expectedEntry = path.posix.basename(fs.readFileSync('dist/index.html', 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
const fixture = `<gpx><trk><name>Diorama tour fixture</name><trkseg>
  <trkpt lat="47" lon="-122"><ele>100</ele><time>2026-10-19T00:00:00Z</time></trkpt>
  <trkpt lat="47.001" lon="-122.001"><ele>250</ele><time>2026-10-19T00:02:00Z</time></trkpt>
  <trkpt lat="47.004" lon="-122.002"><ele>300</ele><time>2026-10-20T00:00:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
let browser, server;
const results = [];
try {
  const base = process.env.TREK_TOUR_URL ?? 'https://127.0.0.1:4202/';
  if (!process.env.TREK_TOUR_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4202', '--strictPort'], { stdio: 'pipe', windowsHide: true });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Preview timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4202')) { clearTimeout(timeout); resolve(); } });
      server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    // Deterministic control/lifecycle validation with synthetic fallback terrain.
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === new URL(base).origin || url.protocol === 'data:' || url.protocol === 'blob:' ? route.continue() : route.abort();
    });
    const diagnostics = viewport.width < 600 ? 'profile' : 'debug';
    await page.goto(`${base}?${diagnostics}=1&terrainTiles=0&regionalBase=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__trekViewerApp, null, { timeout: 20000 });
    const actualEntries = await page.evaluate(() => [...document.scripts].map(script => script.src));
    assert.ok(actualEntries.some(source => source && new URL(source).pathname.endsWith('/' + expectedEntry)), `Expected actual client entry ${expectedEntry}; got ${actualEntries.join(', ')}`);
    const build = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
    assert.equal(build.id, expectedBuild.id, 'Hosted metadata must match the local build being verified');
    await page.evaluate(xml => window.__trekViewerApp.loadTrackFromXML(xml), fixture);
    await page.waitForFunction(() => window.__trekViewerApp.currentTrack?.name === 'Diorama tour fixture', null, { timeout: 60000 });
    assert.equal(await page.locator('#playbackMode').inputValue(), 'tour');
    assert.deepEqual(await page.locator('.speed-btn').allTextContents(), ['0.5x', '1x', '2x', '3x']);
    await page.locator('#btnPlay').click();
    await page.waitForFunction(() => window.__trekViewerApp.session.getState().progress > 0.001);
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), true, 'Play starts camera following');
    await page.locator('#btnFollowRoute').click();
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
    await page.locator('#btnPlay').click();
    await page.evaluate(() => {
      const slider = document.querySelector('#scrubberInput');
      slider.value = '40'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const progress = await page.evaluate(() => window.__trekViewerApp.session.getState().progress);
    assert.equal(progress, 0.4);
    await page.locator('#playbackMode').selectOption('recorded');
    assert.deepEqual(await page.locator('.speed-btn').allTextContents(), ['1x', '5x', '20x', '60x']);
    await page.locator('.speed-btn').last().click();
    await page.locator('#playbackMode').selectOption('tour');
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().playbackSpeed), 1);
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().progress), progress);

    // Exercise the production XR follow branch with controlled frame inputs.
    // This validates wiring only, not native headset tracking or comfort.
    const xrFollow = await page.evaluate(() => {
      const app = window.__trekViewerApp, xr = app.sceneManager.renderer.xr;
      const camera = app.sceneManager.camera, root = app.sceneManager.dioramaRoot;
      const saved = { presenting: xr.isPresenting, getCamera: xr.getCamera, input: app.xrManager.update,
        render: app.sceneManager.render, imagery: app.activeTrek.imageryLOD.update,
        terrain: app.activeTrek.updateHikerProgress, enabled: app.controls.enabled,
        position: root.position.clone(), quaternion: root.quaternion.clone(), scale: root.scale.clone() };
      const initialCamera = camera.position.clone(), rotation = camera.quaternion.clone();
      let terrainFocus, upcomingProgress;
      const anchor = camera.getWorldPosition(camera.position.clone());
      const direction = camera.getWorldDirection(camera.position.clone()); direction.y = 0;
      if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1);
      anchor.addScaledVector(direction.normalize(), 0.8); anchor.y -= 0.45;
      try {
        xr.isPresenting = true; xr.getCamera = () => camera;
        app.xrManager.update = app.sceneManager.render = app.activeTrek.imageryLOD.update = () => {};
        app.activeTrek.updateHikerProgress = (_progress, focus, _detail, upcoming) => { terrainFocus = focus; upcomingProgress = upcoming; };
        app.controls.enabled = false;
        app.togglePlay();
        const startedFollowing = app.session.getState().followRoute;
        for (let i = 0; i < 300; i++) {
          app.lastTimestamp = performance.now() - 1000 / 60;
          app.animate(performance.now());
        }
        const upcomingGroundHint = Number.isFinite(upcomingProgress) && upcomingProgress > app.flyoverController.getProgress();
        app.togglePlay();
        const hiker = app.trailResult.hikerMarker.getWorldPosition(camera.position.clone());
        const result = { startedFollowing, upcomingGroundHint, targetError: hiker.distanceTo(anchor),
          modelMoved: root.position.distanceTo(saved.position), cameraMoved: camera.position.distanceTo(initialCamera),
          cameraTurned: camera.quaternion.angleTo(rotation), modelTurned: root.quaternion.angleTo(saved.quaternion),
          modelRescaled: root.scale.distanceTo(saved.scale),
            terrainFollowsHiker: Math.hypot(
              (terrainFocus.lon - app.currentTrack.bounds.centerLon) * Math.PI / 180 * 6371000 * Math.cos(app.currentTrack.bounds.centerLat * Math.PI / 180) - app.trailResult.hikerMarker.position.x,
              -(terrainFocus.lat - app.currentTrack.bounds.centerLat) * Math.PI / 180 * 6371000 - app.trailResult.hikerMarker.position.z) < 0.000001 };
        app.animate(performance.now());
        result.pausedHintCleared = upcomingProgress === undefined;
        // Spatial toggle releases ownership without requiring a DOM control.
        app.spatialHUD.onPointerClick({ x: 315 / 1024, y: 1 - 514 / 768 });
        result.spatialStopped = !app.session.getState().followRoute;
        app.spatialHUD.onPointerClick({ x: 315 / 1024, y: 1 - 514 / 768 });
        result.spatialStarted = app.session.getState().followRoute;
        app.xrManager.callbacks.onDioramaManipulation();
        result.manualStopped = !app.session.getState().followRoute;
        return result;
      } finally {
        xr.isPresenting = saved.presenting; xr.getCamera = saved.getCamera;
        app.xrManager.update = saved.input; app.sceneManager.render = saved.render;
        app.activeTrek.imageryLOD.update = saved.imagery; app.activeTrek.updateHikerProgress = saved.terrain;
        app.controls.enabled = saved.enabled; app.session.setFollowRoute(false);
        root.position.copy(saved.position); root.quaternion.copy(saved.quaternion); root.scale.copy(saved.scale);
        app.flyoverController.setProgress(0.4); app.frameDesktopDiorama();
      }
    });
    assert.equal(xrFollow.startedFollowing, true);
    assert.ok(xrFollow.targetError < 0.02);
    assert.ok(xrFollow.modelMoved > 0.01);
    assert.equal(xrFollow.cameraMoved, 0); assert.ok(xrFollow.cameraTurned < 1e-7);
    assert.ok(xrFollow.modelTurned < 1e-7); assert.equal(xrFollow.modelRescaled, 0);
    assert.equal(xrFollow.terrainFollowsHiker, true);
    assert.equal(xrFollow.upcomingGroundHint, true); assert.equal(xrFollow.pausedHintCleared, true);
    assert.equal(xrFollow.spatialStopped, true); assert.equal(xrFollow.spatialStarted, true);
    assert.equal(xrFollow.manualStopped, true);

    const spatial = await page.evaluate(() => {
      const app = window.__trekViewerApp, hud = app.spatialHUD;
      hud.onPointerClick({ x: 800 / 1024, y: 1 - 645 / 768 });
      const mode = app.session.getState().playbackMode;
      hud.onPointerClick({ x: 665 / 1024, y: 1 - 439 / 768 });
      const speed = app.session.getState().playbackSpeed;
      app.session.setPlaybackMode('tour');
      return { mode, speed };
    });
    assert.deepEqual(spatial, { mode: 'recorded', speed: 20 });
    const hudLayout = await page.evaluate(async () => {
      const app = window.__trekViewerApp, hud = app.spatialHUD;
      hud.group.visible = true;
      hud.clearStatus();
      await new Promise(resolve => setTimeout(resolve, 100)); hud.update();
      const controls = hud.ctx.getImageData(35, 620, 955, 54).data;
      const footer = hud.ctx.getImageData(35, 680, 955, 36).data;
      hud.showStatus('Jumped to: Camp (Upper)', 0.5);
      await new Promise(resolve => setTimeout(resolve, 100)); hud.update();
      const changed = (before, after) => {
        let pixels = 0;
        for (let i = 0; i < before.length; i += 4) {
          if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) pixels++;
        }
        return pixels;
      };
      const result = {
        controlsChangedPixels: changed(controls, hud.ctx.getImageData(35, 620, 955, 54).data),
        footerChangedPixels: changed(footer, hud.ctx.getImageData(35, 680, 955, 36).data),
        png: hud.canvas.toDataURL('image/png'),
        diagnostics: hud.getUploadDiagnostics?.() ?? null,
        counters: app.getProfileCounters(),
      };
      hud.group.visible = false;
      const requests = hud.getUploadDiagnostics?.().requests;
      hud.showStatus('Hidden status'); hud.update();
      result.hiddenUploadRequests = (hud.getUploadDiagnostics?.().requests ?? 0) - (requests ?? 0);
      return result;
    });
    fs.writeFileSync(path.join(out, `${viewport.width}-hud-status.png`), Buffer.from(hudLayout.png.split(',')[1], 'base64'));
    delete hudLayout.png;
    if (process.env.TREK_HUD_BASELINE) {
      assert.ok(hudLayout.controlsChangedPixels > 0, 'The baseline should reproduce the control obstruction');
      fs.writeFileSync(path.join(out, 'hud-baseline.json'), JSON.stringify(hudLayout, null, 2) + '\n');
      console.log(JSON.stringify({ baseline: true, ...hudLayout }));
      await context.close();
      break;
    }
    assert.equal(hudLayout.controlsChangedPixels, 0);
    assert.ok(hudLayout.footerChangedPixels > 0);
    assert.equal(hudLayout.hiddenUploadRequests, 0);
    assert.equal(hudLayout.counters.playbackMode, 'tour');
    assert.equal(hudLayout.counters.playbackSpeed, 1);
    assert.equal(hudLayout.counters.isPlaying, false);
    assert.equal(hudLayout.counters.hudVisible, true);
    assert.ok(hudLayout.diagnostics.requests > 0);
    assert.equal(hudLayout.diagnostics.requestedBytes, hudLayout.diagnostics.requests * 1024 * 768 * 4);
    assert.equal(hudLayout.counters.hudUploadRequestsTotal, hudLayout.diagnostics.requests);
    if (diagnostics === 'profile') await page.evaluate(() => window.__trekViewerApp.startProfile());
    await page.locator('#btnFollowRoute').click();
    await page.waitForTimeout(1800);
    const following = await page.evaluate(() => {
      const app = window.__trekViewerApp;
      const focus = app.trailResult.hikerMarker.getWorldPosition(app.sceneManager.camera.position.clone());
      return { active: app.session.getState().followRoute, targetError: app.controls.target.distanceTo(focus) };
    });
    assert.equal(following.active, true);
    assert.ok(following.targetError < 0.02);
    await page.screenshot({ path: path.join(out, `${viewport.width}-follow.png`) });
    const canvas = page.locator('#canvas-container canvas');
    const rect = await canvas.boundingBox();
    await page.mouse.move(rect.x + rect.width * 0.55, rect.y + rect.height * 0.45);
    await page.mouse.wheel(0, -100);
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
    await page.locator('#btnFollowRoute').click();
    // Fit must stop following without resetting route progress.
    await page.evaluate(() => window.__trekViewerApp.frameDesktopDiorama());
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().progress), progress);
    if (diagnostics === 'profile') {
      const report = await page.evaluate(() => {
        const app = window.__trekViewerApp;
        app.stopProfile(); return app.completedProfile;
      });
      assert.ok(report.windows.length > 0);
      assert.ok(report.windows.every(window => window.playbackMode === 'tour' && window.playbackSpeed === 1 && window.isPlaying === false));
      assert.ok(report.events.filter(event => event.name === 'playback-context').length >= 3);
      fs.writeFileSync(path.join(out, `${viewport.width}-profile.json`), JSON.stringify(report, null, 2) + '\n');
    }
    // Shape the fixture's real rendered base mesh into a ridge, retaining the
    // production triangle sampler rather than substituting an analytic height.
    await page.evaluate(() => {
      const app = window.__trekViewerApp, terrain = app.activeTrek.terrainResult;
      const group = terrain.group, camera = app.sceneManager.camera;
      group.updateWorldMatrix(true, false);
      const focus = app.trailResult.hikerMarker.getWorldPosition(camera.position.clone());
      const local = group.worldToLocal(focus.clone());
      const worldScale = Math.hypot(...[0, 1, 2].map(row => group.matrixWorld.elements[8 + row]));
      const heights = terrain.baseSurfaceData.heights;
      const original = heights.slice();
      const vertices = terrain.terrainMesh.geometry.attributes.position;
      for (let i = 0; i < heights.length; i++) {
        const z = (vertices.getZ(i) - local.z) * worldScale;
        heights[i] = local.y + (z >= 0.1 && z <= 0.2 ? 0.3 / worldScale : 0);
      }
      const exaggeration = terrain.getVerticalExaggeration();
      terrain.setVerticalExaggeration(exaggeration);
      app.controls.target.copy(focus);
      camera.position.copy(focus); camera.position.y += 0.18; camera.position.z += 0.25;
      app.controls.update();
      window.__followRidge = { original, exaggeration, focus: focus.clone() };
    });
    const measureClearance = async () => page.evaluate(() => {
      const app = window.__trekViewerApp, terrain = app.activeTrek.terrainResult, group = terrain.group;
      const camera = app.sceneManager.camera, focus = window.__followRidge.focus;
      const a = group.worldToLocal(focus.clone()), b = group.worldToLocal(camera.position.clone());
      const scale = Math.hypot(...[0, 1, 2].map(row => group.matrixWorld.elements[4 + row]));
      let minimum = Infinity;
      for (let i = 1; i <= 16; i++) {
        const point = a.clone().lerp(b, i / 16);
        minimum = Math.min(minimum, (point.y - terrain.sampleRenderedSurfaceY(point.x, point.z) * terrain.getVerticalExaggeration()) * scale);
      }
      return { minimum, camera: camera.position.toArray(), active: app.session.getState().followRoute };
    });
    const obstructed = await measureClearance();
    assert.ok(obstructed.minimum < -0.05, 'Real ridge fixture must obstruct the original offset');
    await page.screenshot({ path: path.join(out, `${viewport.width}-ridge-before.png`) });
    await page.locator('#btnFollowRoute').click();
    await page.waitForTimeout(1200);
    const cleared = await measureClearance();
    const clearance = { obstructed, cleared };
    await page.screenshot({ path: path.join(out, `${viewport.width}-ridge-after.png`) });
    if (process.env.TREK_FOLLOW_BASELINE) {
      assert.ok(cleared.minimum < 0, 'Baseline must reproduce the obstructed follow view');
      fs.writeFileSync(path.join(out, 'follow-baseline.json'), JSON.stringify({ clearance, build }, null, 2) + '\n');
      console.log(JSON.stringify({ baseline: true, clearance, build }));
      await context.close();
      break;
    }
    assert.ok(cleared.minimum > 0, 'Follow must clear the sampled ridge sightline');
    assert.equal(cleared.active, true);
    await page.evaluate(() => {
      const app = window.__trekViewerApp, terrain = app.activeTrek.terrainResult;
      app.session.setFollowRoute(false);
      terrain.baseSurfaceData.heights.set(window.__followRidge.original);
      terrain.setVerticalExaggeration(window.__followRidge.exaggeration);
      delete window.__followRidge;
      app.frameDesktopDiorama();
    });
    await page.locator('#btnFollowRoute').click();
    await page.locator('#btnViewToggle').click();
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
    assert.equal(await page.locator('#playbackMode').isVisible(), false);
    await page.locator('#btnViewToggle').click();
    assert.equal(await page.locator('#playbackMode').isVisible(), true);
    await page.locator('#btnFollowRoute').click();
    await page.evaluate(xml => window.__trekViewerApp.loadTrackFromXML(xml.replace('Diorama tour fixture', 'Second route')), fixture);
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
    const xmlImport = await page.evaluate(async () => {
      const app = window.__trekViewerApp;
      const xml = `<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" xmlns:f="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
        <g:wpt lon="-122.001" lat="47.001"><g:name><![CDATA[Camp <Upper> & East]]></g:name><g:ele>200</g:ele></g:wpt>
        <g:trk><g:name>Prefixed &amp; encoded</g:name><g:trkseg>
        <g:trkpt lon="-122" lat="47"><g:ele>100</g:ele><g:extensions><f:TrackPointExtension><f:hr>144</f:hr><f:cad>82</f:cad></f:TrackPointExtension></g:extensions></g:trkpt>
        <g:trkpt lon="-122.001" lat="47.001"><g:ele>200</g:ele></g:trkpt></g:trkseg>
        <g:trkseg><g:trkpt lon="-122.002" lat="47.002"/><g:trkpt lon="-122.003" lat="47.003"/></g:trkseg></g:trk></g:gpx>`;
      await app.loadTrackFromXML(xml);
      const committed = app.currentTrack;
      const result = { name: committed.name, segments: committed.segments.length, points: committed.points.length,
        hr: committed.points[0].hr, cad: committed.points[0].cad,
        waypoint: committed.waypoints.find(point => !point.isDerivedLandmark)?.name };
      await app.loadTrackFromXML('<gpx><trk></gpx>');
      return { ...result, preservedOnError: app.currentTrack === committed,
        importError: app.session.getState().loadingPhase };
    });
    assert.deepEqual(xmlImport, { name: 'Prefixed & encoded', segments: 2, points: 4, hr: 144, cad: 82,
      waypoint: 'Camp <Upper> & East', preservedOnError: true, importError: 'error' });
    const loop = `<gpx><wpt lat="47" lon="-122"><name>Trailhead (Loop)</name><ele>100</ele></wpt>
      <wpt lat="47.001" lon="-122.001"><name>Camp (Upper)</name><ele>250</ele></wpt>
      <wpt lat="47.00105" lon="-122.001"><name>Camp (Lower)</name><ele>240</ele></wpt>
      <trk><name>Loop landmarks</name><trkseg>
      <trkpt lat="47" lon="-122"><ele>100</ele></trkpt>
      <trkpt lat="47.001" lon="-122.001"><ele>250</ele></trkpt>
      <trkpt lat="47.004" lon="-122.002"><ele>300</ele></trkpt>
      <trkpt lat="47" lon="-122"><ele>100</ele></trkpt>
      </trkseg></trk></gpx>`;
    await page.evaluate(xml => window.__trekViewerApp.loadTrackFromXML(xml), loop);
    const landmarks = await page.evaluate(() => {
      const app = window.__trekViewerApp;
      return { shared: app.overlay.routeLandmarks === app.spatialHUD.allLandmarksSorted,
        list: app.routeLandmarks.map(item => ({ name: item.name, progress: item.progress })) };
    });
    assert.equal(landmarks.shared, true);
    assert.equal(landmarks.list[0].progress, 0);
    assert.equal(landmarks.list.at(-1).name, 'Finish');
    assert.equal(landmarks.list.at(-1).progress, 1);
    assert.ok(landmarks.list.some(item => item.name === 'Camp (Upper)'));
    assert.ok(landmarks.list.some(item => item.name === 'Camp (Lower)'));
    if (viewport.width < 900) await page.locator('#btnSettings').click();
    await page.locator('#selectLandmark').selectOption(String(landmarks.list.findIndex(item => item.name === 'Camp (Upper)')));
    assert.ok((await page.locator('#statusText').textContent()).includes('Camp (Upper)'));
    await page.locator('#selectLandmark').selectOption(String(landmarks.list.length - 1));
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().progress), 1);
    await page.locator('#landmarksList button').filter({ hasText: 'Trailhead (Loop)' }).click();
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().progress), 0);
    await page.evaluate(() => {
      const app = window.__trekViewerApp;
      app.flyoverController.setProgress(0.9);
      app.spatialHUD.jumpToNextLandmark();
    });
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().progress), 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    if (diagnostics === 'profile') {
      const panel = await page.locator('#profile-controls').boundingBox();
      const player = await page.locator('.player-bar').boundingBox();
      assert.ok(panel.y + panel.height < player.y, 'Profiling controls must clear the player bar');
    }
    assert.deepEqual(errors, []);
    results.push({ viewport, progress, spatial, hudLayout, following, xrFollow, clearance, xmlImport, landmarks, overflow, pageErrors: errors, build });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ fixture: 'synthetic terrain; external sources deliberately unavailable', results }, null, 2) + '\n');
} finally {
  await browser?.close(); server?.kill();
}
