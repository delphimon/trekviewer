import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = name => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const report = read('profile.json');
const exclusions = [[0, 10]];
for (const name of ['cpu', 'perfetto']) {
  const start = report.events.find(event => event.name === `diagnostic-${name}-start`);
  const stop = report.events.find(event => event.name === `diagnostic-${name}-stop`);
  if (start && stop) exclusions.push([start.elapsedSeconds, stop.elapsedSeconds]);
}
const native = report.windows.filter(window => window.xrPresenting && window.xrEyeCount === 2);
const baseline = native.filter(window => !exclusions.some(([start, stop]) =>
  window.elapsedSeconds - window.durationSeconds < stop && window.elapsedSeconds > start));
const mean = key => baseline.reduce((sum, window) => sum + window[key], 0) / baseline.length;
const frames = baseline.reduce((sum, window) => sum + window.frames, 0);
const phases = Object.fromEntries(Object.keys(baseline[0].phaseMeanMs).map(key => [key,
  baseline.reduce((sum, window) => sum + window.phaseMeanMs[key] * window.frames, 0) / frames]));
const playback = report.events.filter(event => event.name === 'playback-context')
  .map(event => ({ ...event, ...JSON.parse(event.value) }));
const playingSeconds = playback.reduce((sum, event, index) => sum + (event.playing
  ? (playback[index + 1]?.elapsedSeconds ?? report.summary.durationSeconds) - event.elapsedSeconds : 0), 0);
const increase = key => native.at(-1)[key] - native[0][key];
const summary = {
  build: report.buildId, durationSeconds: report.summary.durationSeconds, nativeWindows: native.length,
  excludedIntervalsSeconds: exclusions,
  uninstrumented: { windows: baseline.length, seconds: baseline.reduce((sum, window) => sum + window.durationSeconds, 0),
    meanWindowCallbackHz: mean('callbackHz'), meanWindowCpuSubmitP95Ms: mean('cpuSubmitP95Ms'), phaseMeanMs: phases },
  playingSeconds, fullTourCaptured: false, drawCallsPeak: Math.max(...native.map(window => window.drawCalls)),
  hudUploadRequestsSampledIncrease: increase('hudUploadRequestsTotal'),
  imageryCreatedSampledIncrease: increase('imageryCreatedTotal'), imageryDisposedSampledIncrease: increase('imageryDisposedTotal'),
  incompleteSelectedCoverageWindows: native.filter(window => window.imageryCoveragePercent < 100).length,
  nativeTrace: read('trace-counters.json'),
};
fs.writeFileSync(new URL('analysis.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ file: fileURLToPath(new URL('analysis.json', import.meta.url)), ...summary }, null, 2));
