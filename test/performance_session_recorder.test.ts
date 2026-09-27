import { afterEach, expect, it, vi } from 'vitest';
import { PerformanceSessionRecorder, PROFILE_PHASES, type ProfileCounters } from '../src/core/PerformanceSessionRecorder.ts';

const counters: ProfileCounters = {
  drawCalls: 84, triangles: 128000, geometries: 27, textures: 24,
  tileCacheEntries: 70, tileCacheDecodedMB: 18.2, imageryPatches: 28,
  imageryCoveragePercent: 100, imageryInFlight: 0, localTerrainChunks: 3,
  localTerrainFocusChangesTotal: 1,
  imageryTargetZoom: 19, imageryFocusSource: 'center', imageryDesiredTiles: 36, imageryVisiblePatches: 36,
  firstPersonViewSamples: 3, firstPersonHighResSamples: 2,
  firstPersonViewMinZoom: 17, firstPersonViewMeanZoom: 18.3,
  imageryCreatedTotal: 36, imageryDisposedTotal: 0, tileCacheFailures: 0,
  qualityProfile: 'quest-high', viewMode: 'diorama', textureStyle: 'satellite', imageryProvider: 'cesium-bing', routeName: 'Test route',
};
afterEach(() => vi.restoreAllMocks());

it('exports bounded one-second XR windows with CPU phase costs and explicit measurement limits', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const recorder = new PerformanceSessionRecorder();
  recorder.start(0, 'test-build', 'Test Quest', new Date('2026-09-26T00:00:00Z'));
  for (let i = 0; i <= 72; i++) {
    now = i * 1000 / 72;
    recorder.recordPhase('input', 1);
    recorder.recordPhase('render', 3);
    recorder.recordFrame(now, 5, 'xr/diorama/high/aerial', 72);
  }
  expect(recorder.due).toBe(true);
  recorder.captureWindow(now, counters);
  recorder.mark(now, 'view-mode', 'first-person');
  const report = recorder.stop(now, counters, new Date('2026-09-26T00:00:01Z'))!;
  expect(report).toMatchObject({schemaVersion:1,measurement:'webxr-callback-and-js-submission',buildId:'test-build',
    summary:{estimatedMissedCallbacks:0,maxDrawCalls:84,maxTextures:24},windowsDropped:0});
  expect(report.windows).toHaveLength(1);
  expect(report.windows[0]).toMatchObject({frames:73,callbackSamples:72,drawCalls:84,targetHz:72,
    cpuSubmitP95Ms:5,imageryProvider:'cesium-bing',phaseMeanMs:{input:1,render:3}});
  expect(report.windows[0].callbackHz).toBeCloseTo(72);
  expect(Object.keys(report.windows[0].phaseMeanMs)).toEqual([...PROFILE_PHASES]);
  expect(report.events.map(e=>e.name)).toEqual(['profile-start','view-mode','profile-stop']);
  expect(report.limitations.join(' ')).toContain('not GPU time');
});

it('retains long stalls, long tasks, pauses, and missing refresh-rate uncertainty', () => {
  const recorder = new PerformanceSessionRecorder();
  recorder.start(0,'build','browser');
  recorder.recordFrame(0,1,'desktop',null);
  recorder.recordFrame(16,2,'desktop',null);
  recorder.recordFrame(2016,100,'desktop',null);
  recorder.recordLongTask(120);
  recorder.pause(2016,counters);
  recorder.recordFrame(8000,2,'desktop',null);
  recorder.recordFrame(8016,2,'desktop',null);
  const report = recorder.stop(8016,counters)!;
  expect(report.windows).toHaveLength(2);
  expect(report.windows[0]).toMatchObject({intervalMaxMs:2000,cpuSubmitMaxMs:100,longTaskCount:1,longTaskMaxMs:120});
  expect(report.windows[1]).toMatchObject({callbackSamples:1,intervalMaxMs:16});
  expect(report.summary.estimatedMissedCallbacks).toBeNull();
});

it('caps an extended report without retaining unbounded sample windows', () => {
  const recorder = new PerformanceSessionRecorder(2);
  recorder.start(0,'build','browser');
  for (let i = 0; i < 5; i++) {
    recorder.recordFrame(i*1000,2,'xr',72);
    recorder.recordFrame(i*1000+14,2,'xr',72);
    recorder.captureWindow(i*1000+1000,counters);
  }
  const report = recorder.stop(5000,counters)!;
  expect(report.windows).toHaveLength(2);
  expect(report.windowsDropped).toBe(3);
});
