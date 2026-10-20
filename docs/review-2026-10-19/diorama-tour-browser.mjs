import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = path.resolve(process.env.TREK_TOUR_OUT ?? '.review-cache/diorama-tour');
fs.mkdirSync(out, { recursive: true });
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
    await page.evaluate(xml => window.__trekViewerApp.loadTrackFromXML(xml), fixture);
    await page.waitForFunction(() => window.__trekViewerApp.currentTrack?.name === 'Diorama tour fixture', null, { timeout: 60000 });
    assert.equal(await page.locator('#playbackMode').inputValue(), 'tour');
    assert.deepEqual(await page.locator('.speed-btn').allTextContents(), ['0.5x', '1x', '2x', '3x']);
    await page.locator('#btnPlay').click();
    await page.waitForFunction(() => window.__trekViewerApp.session.getState().progress > 0.001);
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
    await page.locator('#btnFollowRoute').click();
    await page.locator('#btnViewToggle').click();
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
    assert.equal(await page.locator('#playbackMode').isVisible(), false);
    await page.locator('#btnViewToggle').click();
    assert.equal(await page.locator('#playbackMode').isVisible(), true);
    await page.locator('#btnFollowRoute').click();
    await page.evaluate(xml => window.__trekViewerApp.loadTrackFromXML(xml.replace('Diorama tour fixture', 'Second route')), fixture);
    assert.equal(await page.evaluate(() => window.__trekViewerApp.session.getState().followRoute), false);
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
    const build = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
    results.push({ viewport, progress, spatial, following, landmarks, overflow, pageErrors: errors, build });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify({ fixture: 'synthetic terrain; external sources deliberately unavailable', results }, null, 2) + '\n');
} finally {
  await browser?.close(); server?.kill();
}
