import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_LIVE_BATCH_URL ?? 'https://127.0.0.1:4212/';
const out = process.env.TREK_LIVE_BATCH_OUT ?? '.review-cache/live-imagery-batch';
const expectedDist = process.env.TREK_LIVE_BATCH_EXPECTED_DIST ?? 'dist';
const expected = JSON.parse(fs.readFileSync(path.join(expectedDist, 'build-info.json'), 'utf8'));
const entry = path.posix.basename(fs.readFileSync(path.join(expectedDist, 'index.html'), 'utf8').match(/src="([^"]+\.js)"[^>]*data-trek-entry="true"/)[1]);
const route = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8')).find(row => row.id === 'olympus-bailey-2026');
const config = process.env.TREK_LOCAL_PROVIDERS_PATH ? JSON.parse(fs.readFileSync(process.env.TREK_LOCAL_PROVIDERS_PATH, 'utf8')) : null;
if (config) assert.ok(config.imageryAssetId === 2 && config.ionToken?.length > 10, 'Expected eligible local Bing configuration');
const recordCPU = process.env.TREK_CPU_PROFILE === '1';
assert.ok(!recordCPU || !config, 'CPU profiling is restricted to public-source runs');
fs.mkdirSync(out, { recursive: true });
let browser, server;
try {
  if (!process.env.TREK_LIVE_BATCH_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4212', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 15000);
      server.stdout.on('data', data => { if (data.toString().includes('4212')) { clearTimeout(timer); resolve(); } }); server.on('error', reject);
    });
  }
  browser = await chromium.launch({ executablePath: process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 }, userAgent: 'TrekViewer desktop live-source audit (Quest geometry budget)' });
  const page = await context.newPage(), errors = [], glErrors = [];
  if (process.env.TREK_TERRAIN_PIPELINE_AUDIT === '1') await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__terrainJobAudit = [];
    window.Worker = class extends NativeWorker {
      pendingAudit = null;
      surfaceSizes = [];
      baseSize = 0;
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data?.ready || !this.pendingAudit) return;
          this.pendingAudit.completedAtMs = performance.now();
          this.pendingAudit.elapsedMs = this.pendingAudit.completedAtMs - this.pendingAudit.startedAtMs;
          this.pendingAudit.failed = !!event.data?.error;
          this.pendingAudit = null;
        });
      }
      postMessage(message, ...args) {
        if (!['lerc', 'decode', 'chunk', 'surface', 'finalize'].includes(message?.kind)) return super.postMessage(message, ...args);
        const sources = message.input?.sources ?? [];
        if (message.kind === 'surface' && !message.reuseSources) this.surfaceSizes = sources.map(source =>
          'reuseSource' in source ? this.surfaceSizes[source.reuseSource] : source.positions.byteLength + source.normals.byteLength);
        if (message.kind === 'chunk' && !message.reuseBase) this.baseSize = message.base?.heights?.byteLength ?? 0;
        const row = { kind: message.kind, startedAtMs: performance.now(),
          sourceBytes: sources.reduce((bytes, source) => bytes + (source.positions?.byteLength ?? 0) + (source.normals?.byteLength ?? 0), 0),
          uncachedSourceBytes: message.kind === 'surface' && !message.reuseSources ? this.surfaceSizes.reduce((a, b) => a + b, 0) : 0,
          baseBytes: message.base?.heights?.byteLength ?? 0, uncachedBaseBytes: message.kind === 'chunk' ? this.baseSize : 0,
          tileId: message.options?.layout?.id ?? null,
          gridBytes: message.options?.localGrid?.data?.byteLength ?? 0 };
        this.pendingAudit = row; window.__terrainJobAudit.push(row);
        const result = super.postMessage(message, ...args);
        row.postMs = performance.now() - row.startedAtMs;
        return result;
      }
    };
  });
  const workerLifecycle = { created: 0, closed: 0 };
  const elevationRequests = new Map();
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname === 'elevation.nationalmap.gov' && url.pathname.endsWith('/exportImage'))
      elevationRequests.set(url.href, (elevationRequests.get(url.href) ?? 0) + 1);
  });
  page.on('worker', worker => { workerLifecycle.created++; worker.on('close', () => workerLifecycle.closed++); });
  // No credential-bearing response URLs, exception messages, console text or
  // private bootstrap values enter the report.
  page.on('pageerror', () => errors.push('Page exception'));
  page.on('console', message => { if (/INVALID_OPERATION|INVALID_VALUE|INVALID_ENUM|VALIDATE_STATUS|Shader Error/.test(message.text())) {
    if (!config && glErrors.length === 0) console.log(message.text().slice(0, 9000));
    glErrors.push('GL validation error');
  } });
  await page.route('**/routes/manifest.json', request => request.fulfill({ contentType: 'application/json', body: JSON.stringify([route]) }));
  let bootstrap;
  const cdp = await context.newCDPSession(page); await cdp.send('Page.enable');
  if (config) bootstrap = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__TREK_VIEWER_PROVIDERS__=${JSON.stringify({ provider: 'cesium-bing', ionToken: config.ionToken })};` });
  const start = Date.now();
  await page.goto(base + '?profile=1&' + (process.env.TREK_DIRECT_TERRAIN === '1' ? 'terrainImagery=1' : 'imageryBatch=1'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__trekViewerApp?.session.getState().loadingPhase === 'ready', null, { timeout: 120000 });
  if (bootstrap) { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootstrap.identifier }); await page.evaluate(() => { delete window.__TREK_VIEWER_PROVIDERS__; }); }
  const build = await page.evaluate(async () => (await fetch('build-info.json', { cache: 'no-store' })).json());
  assert.equal(build.id, expected.id); assert.ok(await page.evaluate(entry => [...document.scripts].some(s => s.src.endsWith('/' + entry)), entry));
  const readyElapsedMs = Date.now() - start;
  console.log(JSON.stringify({ phase: 'ready', elapsedMs: readyElapsedMs, build: build.id }));
  await page.evaluate(() => {
    const app = window.__trekViewerApp;
    app.startProfile();
    window.__liveDetailStartedAt = performance.now();
    window.__liveDetailSamples = [];
    window.__terrainLifecycle = [];
    const terrain = app.activeTrek.terrainResult, grid = terrain.baseMeshGrid;
    let chunkConstructionObserved = false;
    const observeChunkConstruction = chunk => {
      if (chunkConstructionObserved || !window.__terrainJobAudit || !chunk?.constructor?.createAsync) return;
      chunkConstructionObserved = true;
      const Chunk = chunk.constructor, original = Chunk.createAsync;
      Chunk.createAsync = async function (...args) {
        const started = performance.now(), candidate = await original.apply(this, args);
        const completed = performance.now();
        const job = window.__terrainJobAudit.findLast(row => row.kind === 'chunk'
          && row.tileId === args[0]?.layout?.id && row.startedAtMs >= started && row.completedAtMs <= completed);
        if (job && !job.failed) job.mainConstructionMs = completed - job.completedAtMs;
        return candidate;
      };
    };
    observeChunkConstruction(terrain.localChunks?.[0]);
    const tileId = chunk => {
      const bounds = chunk.getSurfaceBounds();
      return `${Math.round((bounds.minX + grid.width / 2) / (grid.width / grid.segmentsX * 8))}:${Math.round((bounds.minZ + grid.depth / 2) / (grid.depth / grid.segmentsZ * 8))}`;
    };
    for (const method of ['attachLocalChunk', 'detachLocalChunk']) {
      const original = terrain[method];
      terrain[method] = function (chunk) {
        if (chunk) {
          observeChunkConstruction(chunk);
          window.__terrainLifecycle.push({ method, tileId: tileId(chunk), timeMs: performance.now() });
        }
        return original.apply(this, arguments);
      };
    }
    window.__liveDetailTimer = setInterval(() => {
      const state = app.session.getState(), terrain = app.activeTrek.terrainResult;
      const point = app.activeTrek.trailResult.routeGeometry.getTelemetryAtProgress(state.progress).position;
      const chunk = (terrain.localChunks ?? []).find(c => {
        const b = c.getSurfaceBounds();
        return c.mesh.visible && point.x >= b.minX && point.x <= b.maxX && point.z >= b.minZ && point.z <= b.maxZ;
      });
      const cell = chunk?.getCellSize(), grid = chunk?.currentGrid, streamer = app.activeTrek.localTerrainStreamer;
      const wanted = [...(streamer?.wanted?.values() ?? [])];
      const hikerTile = wanted.find(tile => point.x >= tile.bounds.minX && point.x <= tile.bounds.maxX
        && point.z >= tile.bounds.minZ && point.z <= tile.bounds.maxZ);
      const analytical = app.activeTrek.trailResult.routeGeometry.getTelemetryAtProgress(state.progress).currentPoint;
      const center = terrain.terrainGeoBounds;
      const analyticalX = (analytical.lon - center.centerLon) * Math.PI / 180 * 6371000 * Math.cos(center.centerLat * Math.PI / 180);
      const analyticalZ = -(analytical.lat - center.centerLat) * Math.PI / 180 * 6371000;
      window.__liveDetailSamples.push({ timeMs: performance.now(), progress: state.progress, playing: state.isPlaying, following: state.followRoute,
        fineAtHiker: !!(cell && Math.max(cell.x, cell.z) <= 10 && grid.isRealDEM),
        cellM: cell ? Math.max(cell.x, cell.z) : null, source: grid?.source ?? null,
        hikerWanted: !!hikerTile, hikerQueueIndex: hikerTile ? wanted.indexOf(hikerTile) : null,
        hikerAcquiring: hikerTile ? streamer.acquisitions.has(hikerTile.id) || streamer.acquiringTile === hikerTile.id || streamer.ready?.id === hikerTile.id : false,
        hikerStage: !hikerTile ? 'unplanned' : chunk ? 'visible' : streamer.ready?.id === hikerTile.id ? 'ready'
          : streamer.acquiringTile === hikerTile.id ? 'building' : streamer.acquisitions.get(hikerTile.id)?.settled ? 'decoded'
          : streamer.acquisitions.has(hikerTile.id) ? 'fetching' : 'queued',
        acquisitionCount: streamer?.acquisitions?.size ?? 0,
        settledAcquisitions: [...(streamer?.acquisitions?.values() ?? [])].filter(entry => entry.settled).length,
        upcomingTilePlanned: !!streamer?.prefetchTileId,
        focusToVisualM: streamer?.localFocus ? Math.hypot(streamer.localFocus.x - point.x, streamer.localFocus.z - point.z) : null,
        analyticalToVisualM: Math.hypot(analyticalX - point.x, analyticalZ - point.z),
        sourceSampleSpacingM: grid?.sampleSpacingMeters ?? null,
        overviewDifferenceM: chunk ? chunk.sampleLocalSurfaceY(point.x, point.z) - terrain.sampleBaseSurfaceY(point.x, point.z) : null });
    }, 250);
  });
  const checkpoints = [];
  async function sample(label) {
    const result = await page.evaluate(async label => {
      const app = window.__trekViewerApp, renderer = app.sceneManager.renderer, lod = app.activeTrek.imageryLOD, gl = renderer.getContext();
      renderer.setAnimationLoop(null);
      const capture = () => {
        const draws = new Map(), callbacks = [];
        app.sceneManager.scene.traverse(object => {
          if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
          const original = object.onBeforeRender; callbacks.push([object, original]);
          object.onBeforeRender = function (...args) {
            const name = object.name || object.type + ' (unnamed)'; draws.set(name, (draws.get(name) ?? 0) + 1);
            return original.apply(this, args);
          };
        });
        try { app.sceneManager.render(); } finally { for (const [object, original] of callbacks) object.onBeforeRender = original; }
        const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { pixels, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, error: gl.getError(),
          draws: [...draws].sort((a, b) => b[1] - a[1]) };
      };
      await lod.releaseBatches(); const before = capture();
      const t = performance.now(); for (let i = 0; i < lod.patches.size + 2; i++) lod.syncRenderer(renderer);
      const preparationMs = performance.now() - t, after = capture();
      let maxError = 0, differentPixels = 0, totalError = 0, squaredError = 0;
      for (let i = 0; i < before.pixels.length; i += 4) {
        let difference = 0;
        for (let c = 0; c < 4; c++) {
          const error = Math.abs(before.pixels[i + c] - after.pixels[i + c]);
          difference = Math.max(difference, error); totalError += error; squaredError += error * error;
        }
        maxError = Math.max(maxError, difference); if (difference > 2) differentPixels++;
      }
      const terrain = app.activeTrek.terrainResult;
      const frames = {};
      if (label === 'overview') for (const [name, frame] of [['legacy', before], ['direct', after]]) {
        const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'), data = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) data.data.set(frame.pixels.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
        ctx.putImageData(data, 0, 0); frames[name] = canvas.toDataURL('image/png');
      }
      const patches = [...lod.patches.values()];
      const visible = patches.filter(p => p.mesh.visible);
      const output = { label, batch: lod.getBatchDiagnostics(), counters: app.getProfileCounters(), preparationMs, frames,
        legacyCalls: before.calls, batchedCalls: after.calls, legacyTriangles: before.triangles, batchedTriangles: after.triangles,
        legacyObjects: before.draws, batchedObjects: after.draws,
        maxError, differentPixels, meanChannelError: totalError / before.pixels.length,
        pixelCount: before.pixels.length / 4,
        rmsChannelError: Math.sqrt(squaredError / before.pixels.length), glErrors: [before.error, after.error],
        patches: { total: patches.length, visible: visible.length, fading: visible.filter(p => p.isFading).length,
          vertices: visible.reduce((n, p) => n + p.mesh.geometry.attributes.position.count, 0),
          imageSizes: [...new Set(visible.map(p => p.texture.image.width + 'x' + p.texture.image.height))],
          zooms: [...new Set(visible.map(p => p.zoom))] },
        overview: { tileGrid: terrain.tileGrid, grid: terrain.demGrid && { width: terrain.demGrid.width, height: terrain.demGrid.height, source: terrain.demGrid.source, spacing: terrain.demGrid.sampleSpacingMeters },
          mesh: terrain.baseMeshGrid, chunks: terrain.localChunks?.map(c => ({ cell: c.getCellSize(), source: c.currentGrid.source, spacing: c.currentGrid.sampleSpacingMeters, bounds: c.getSurfaceBounds() })) },
      };
      renderer.setAnimationLoop(app.animateFrame); return output;
    }, label);
    for (const [name, png] of Object.entries(result.frames)) fs.writeFileSync(path.join(out, label + '-' + name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
    delete result.frames;
    checkpoints.push({ elapsedMs: Date.now() - start, ...result });
    fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify(checkpoints, null, 2));
    console.log(JSON.stringify({ phase: label, elapsedMs: Date.now() - start, calls: [result.legacyCalls, result.batchedCalls], batch: result.batch, pixels: [result.maxError, result.differentPixels], chunks: result.counters.localTerrainChunks }));
  }
  try {
    await page.waitForFunction(() => window.__trekViewerApp.activeTrek.imageryLOD.patches.size >= 16, null, { timeout: 90000 });
  } catch (error) {
    console.log(JSON.stringify({ phase: 'imagery-readiness-failed', errors: errors.length, glErrors: glErrors.length,
      diagnostics: await page.evaluate(() => {
        const app = window.__trekViewerApp, lod = app.activeTrek.imageryLOD, streamer = app.activeTrek.localTerrainStreamer;
        return { imagery: lod.getDiagnostics(), chunks: streamer.chunks.size, wanted: streamer.wanted.size,
          acquisitions: streamer.acquisitions.size, busy: streamer.busy, failed: streamer.failed.size,
          workerJobs: window.__terrainJobAudit?.slice(-4), lastDetail: window.__liveDetailSamples.at(-1) };
      }) }));
    throw error;
  }
  await sample('overview');
  const markerComparison = await page.evaluate(() => {
    const app = window.__trekViewerApp, trek = app.activeTrek, renderer = app.sceneManager.renderer, gl = renderer.getContext();
    renderer.setAnimationLoop(null);
    const pins = trek.dioramaBase.getObjectByName('Waypoints').children;
    const previous = pins.map(pin => ({ ...pin.userData }));
    const capture = enabled => {
      trek.setMarkerBatching(enabled); trek.updateWaypoints(app.sceneManager.camera, app.sceneManager.dioramaRoot.scale.x, 0, 800);
      renderer.render(app.sceneManager.scene, app.sceneManager.camera);
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, calls: renderer.info.render.calls, error: gl.getError() };
    };
    const results = [];
    for (const active of [false, true]) {
      pins.forEach((pin, i) => { pin.userData.isHovered = active && i % 2 === 0; pin.userData.isSelected = active && i % 2 === 1; });
      const a = capture(false), b = capture(true);
      let changed = 0, sum = 0, max = 0;
      for (let i = 0; i < a.pixels.length; i += 4) {
        let pixel = 0;
        for (let j = 0; j < 4; j++) { const e = Math.abs(a.pixels[i + j] - b.pixels[i + j]); sum += e; pixel = Math.max(pixel, e); }
        if (pixel > 2) changed++; max = Math.max(max, pixel);
      }
      results.push({ active, changed, max, mean: sum / a.pixels.length, calls: [a.calls, b.calls], errors: [a.error, b.error] });
    }
    pins.forEach((pin, i) => Object.assign(pin.userData, previous[i]));
    trek.updateWaypoints(app.sceneManager.camera, app.sceneManager.dioramaRoot.scale.x, 0, 800);
    renderer.setAnimationLoop(app.animateFrame);
    return results;
  });
  await page.locator('#btnPlay').click();
  if (recordCPU) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
  const fullTour = process.env.TREK_FULL_TOUR === '1';
  for (const label of (fullTour ? [15, 30, 45, 60, 75, 90] : [15, 30]).map(seconds => `following-${seconds}s`)) {
    await page.waitForTimeout(15000);
    if (recordCPU && label === 'following-15s') {
      const { profile } = await cdp.send('Profiler.stop'); await cdp.send('Profiler.disable');
      fs.writeFileSync(path.join(out, 'cpu-profile.json'), JSON.stringify(profile));
    }
    await sample(label);
  }
  if (fullTour) { await page.waitForFunction(() => window.__trekViewerApp.session.getState().progress >= 1, null, { timeout: 20000 }); await sample('finished'); }
  if (await page.evaluate(() => window.__trekViewerApp.session.getState().isPlaying)) await page.locator('#btnPlay').click();
  const playbackProfile = await page.evaluate(() => { const app = window.__trekViewerApp; app.stopProfile(); return app.completedProfile; });
  await page.screenshot({ path: path.join(out, 'scene.png') });
  let renderBenchmark;
  if (process.env.TREK_BENCHMARK_RENDER === '1') {
    renderBenchmark = await page.evaluate(async () => {
      const app = window.__trekViewerApp, renderer = app.sceneManager.renderer, lod = app.activeTrek.imageryLOD, gl = renderer.getContext();
      renderer.setAnimationLoop(null);
      for (const request of lod.pendingRequests.values()) request.abortController.abort();
      lod.pendingRequests.clear(); lod.requestQueue.length = 0;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const adapter = gl.getExtension('WEBGL_debug_renderer_info');
      const stats = values => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] };
      };
      const run = async mode => {
        await lod.releaseBatches();
        app.activeTrek.setMarkerBatching(mode === 'terrain');
        if (mode === 'terrain') for (let i = 0; i < lod.patches.size + 2; i++) lod.syncRenderer(renderer);
        for (let i = 0; i < 8; i++) renderer.render(app.sceneManager.scene, app.sceneManager.camera);
        const queries = [], times = [];
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame);
          const query = ext ? gl.createQuery() : null;
          if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
          const start = performance.now(); renderer.render(app.sceneManager.scene, app.sceneManager.camera); times.push(performance.now() - start);
          if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(query); }
        }
        const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
        const deadline = performance.now() + 3000;
        while (queries.some(query => !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) && performance.now() < deadline) await new Promise(requestAnimationFrame);
        const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null;
        const gpu = queries.filter(query => !disjoint && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)).map(query => gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        for (const query of queries) gl.deleteQuery(query);
        return { mode, submission: stats(times), gpu: stats(gpu), disjoint, calls, triangles, error: gl.getError() };
      };
      const passes = [];
      for (const mode of ['legacy', 'terrain', 'legacy', 'terrain']) passes.push(await run(mode));
      return { condition: 'Warmed fixed scene, 60 requestAnimationFrame-paced renders per pass; no simulation/LOD updates or native XR. Submission is main-thread elapsed render time. GPU samples use EXT_disjoint_timer_query_webgl2 when available.',
        adapter: adapter ? gl.getParameter(adapter.UNMASKED_RENDERER_WEBGL) : null, gpuTimerSupported: !!ext, passes };
    });
    console.log(JSON.stringify({ phase: 'render-benchmark', ...renderBenchmark }));
  }
  const { detailSamples, monitorStartedAtMs } = await page.evaluate(() => {
    clearInterval(window.__liveDetailTimer); return { detailSamples: window.__liveDetailSamples, monitorStartedAtMs: window.__liveDetailStartedAt };
  });
  const tour = detailSamples.filter(row => row.playing && row.following);
  const detailSummary = { samples: tour.length, fineAtHikerSamples: tour.filter(row => row.fineAtHiker).length,
    maxFocusToVisualM: tour.length ? Math.max(...tour.map(row => row.focusToVisualM ?? Infinity)) : null,
    maxAnalyticalToVisualM: tour.length ? Math.max(...tour.map(row => row.analyticalToVisualM)) : null,
    firstFineAfterMonitorMs: detailSamples.some(row => row.fineAtHiker)
      ? detailSamples.find(row => row.fineAtHiker).timeMs - monitorStartedAtMs : null };
  const evidence = { condition: 'Live Olympus route in desktop Edge with Quest base-geometry budget and profiling mode (no debug boundary meshes). Real network DEM and imagery, normal selection, worker terrain publication and tour following; paired images hold the same scene/state synchronously. CPU preparation is a synchronous batch-settle stress operation, not normal per-frame or native GPU timing. Detail monitoring samples at 250 ms; native acceptance remains separate.', fullTour: process.env.TREK_FULL_TOUR === '1', build, entry,
    provider: config ? 'private-cesium-bing' : 'public-default', readyElapsedMs, checkpoints, markerComparison, detailSummary, detailSamples, playbackProfile, workerLifecycle,
    terrainJobAudit: await page.evaluate(() => window.__terrainJobAudit),
    terrainLifecycle: await page.evaluate(() => window.__terrainLifecycle),
    elevationRequests: { total: [...elevationRequests.values()].reduce((a, b) => a + b, 0), unique: elevationRequests.size },
    renderBenchmark, errors, glErrors };
  fs.writeFileSync(path.join(out, 'browser.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert.deepEqual(errors, []); assert.deepEqual(glErrors, []);
  if (process.env.TREK_ASSERT_VISUAL_FOCUS === '1') assert.ok(tour.length > 0 && tour.every(row => row.focusToVisualM < 0.00001), 'Terrain focus must follow the displayed hiker');
  assert.ok(markerComparison.every(row => row.errors.every(e => e === 0) && row.mean < 0.02 && row.changed < 100), 'Marker instancing changed marker appearance');
  const direct = process.env.TREK_DIRECT_TERRAIN === '1';
  // Direct shading removes overlapping clipped geometry; close rasterized
  // triangle edges need a stated image-error gate, not a bitwise claim.
  assert.ok(checkpoints.every(c => c.glErrors.every(e => e === 0) && (direct
    ? c.meanChannelError <= 0.12 && c.rmsChannelError <= 2 && c.differentPixels <= c.pixelCount * 0.01
    : c.differentPixels === 0)), 'Live source image parity failed');
  assert.ok(checkpoints.some(c => c.batch.patches > 0 && c.batchedCalls < c.legacyCalls), 'Actual streamed patches did not batch');
  assert.ok(checkpoints.every(c => c.counters.baseElevationSource?.includes('USGS')), 'Expected real USGS overview');
} finally { await browser?.close(); server?.kill(); }
