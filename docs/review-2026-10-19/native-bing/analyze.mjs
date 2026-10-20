import fs from 'node:fs';
import assert from 'node:assert/strict';
const report = JSON.parse(fs.readFileSync(new URL('profile.json', import.meta.url), 'utf8'));
const native = report.windows.filter(w => w.xrPresenting && w.xrEyeCount === 2);
const baseline = native.filter(w => w.elapsedSeconds - w.durationSeconds >= 10);
const mean = key => baseline.reduce((sum, w) => sum + w[key], 0) / baseline.length;
const frames = baseline.reduce((sum, w) => sum + w.frames, 0);
const increase = key => native.slice(1).reduce((sum, w, i) => sum + Math.max(0, w[key] - native[i][key]), 0);
const playback = report.events.filter(e => e.name === 'playback-context').map(e => ({ ...e, ...JSON.parse(e.value) }));
const playingSeconds = playback.reduce((sum, e, i) => sum + (e.playing
  ? (playback[i + 1]?.elapsedSeconds ?? report.summary.durationSeconds) - e.elapsedSeconds : 0), 0);
assert.equal(native.length, 268); assert.ok(native.every(w => w.imageryProvider === 'cesium-bing'));
const summary = {
  build: report.buildId, durationSeconds: report.summary.durationSeconds, nativeWindows: native.length,
  nativeProviders: [...new Set(native.map(w => w.imageryProvider))],
  reportedTargetHz: [...new Set(native.map(w => w.targetHz))],
  afterFirstTenSeconds: { windows: baseline.length, seconds: baseline.reduce((sum, w) => sum + w.durationSeconds, 0),
    meanWindowCallbackHz: mean('callbackHz'), meanWindowCpuSubmitP95Ms: mean('cpuSubmitP95Ms'),
    frameWeightedPhaseMs: Object.fromEntries(Object.keys(baseline[0].phaseMeanMs).map(key => [key,
      baseline.reduce((sum, w) => sum + w.phaseMeanMs[key] * w.frames, 0) / frames])) },
  playingSeconds, fullTourCaptured: false, nativeGpuTraceCaptured: false,
  drawCallsPeak: Math.max(...native.map(w => w.drawCalls)),
  trianglesPeak: Math.max(...native.map(w => w.triangles)),
  incompleteSelectedCoverageWindows: native.filter(w => w.imageryCoveragePercent < 100).length,
  imageryCreatedSampledIncrease: increase('imageryCreatedTotal'), imageryDisposedSampledIncrease: increase('imageryDisposedTotal'),
  hudUploadRequestsSampledIncrease: increase('hudUploadRequestsTotal'),
  terrainPlanChangesSampledIncrease: increase('localTerrainFocusChangesTotal'),
  tileFailuresPeak: Math.max(...native.map(w => w.tileCacheFailures)),
  subjectiveResult: 'Failed: user reports about the same, less detailed DEM, slow loading and no camera follow.',
  limitations: ['Callback Hz is not compositor FPS; mean window CPU p95 is not global p95.',
    'Selected coverage counts are not visible missing-pixel percentages.',
    'Terrain plan changes are not chunk rebuilds. This run cannot isolate source or individual code-change effects.'],
};
fs.writeFileSync(new URL('analysis.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
