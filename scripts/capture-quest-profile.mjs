#!/usr/bin/env node
// Attach to an already prepared Quest Browser tab through an existing ADB CDP
// forward. No navigation, proximity/Guardian changes, head poses or room images.
// Completed reports are copied immediately instead of waiting for a fixed test
// window to expire. Optional CPU sampling is marked in the app's report.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const port = Number(option('--port', '9231')), seconds = Number(option('--seconds', '1200'));
const cpuSeconds = Number(option('--cpu-seconds', '0'));
const build = option('--build', ''), script = option('--script', '');
const tabId = option('--tab', '');
const out = path.resolve(option('--out', '.review-cache/quest-current'));
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(seconds) || seconds < 10 || seconds > 1800
  || !Number.isFinite(cpuSeconds) || cpuSeconds < 0 || cpuSeconds > 15 || !build || !script) {
  throw Error('Usage: node scripts/capture-quest-profile.mjs --build <short-sha> --script <index-hash.js> [--out <dir>] [--port 9231] [--seconds 1200] [--cpu-seconds 8]');
}
fs.mkdirSync(out, { recursive: true });
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
const candidates = tabs.filter(t => t.type === 'page' && t.url?.startsWith('https://trekviewer.surge.sh/') && t.url.includes('profile=1'));
if (!tabId && candidates.length > 1) throw Error('Multiple profiling tabs exist; pass --tab <CDP-id> to select the prepared tab.');
const tab = candidates.find(t => !tabId || t.id === tabId);
if (!tab) throw Error('No prepared TrekViewer profiling tab is available; wake Quest Browser first.');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let next = 0, sampling = false, sampled = false, cpuStarted = 0, xrStarted = null;
let observedXR = false, nativeCompletedThisCapture = false;
const pending = new Map(), exceptions = [], consoleMessages = [], samples = [], saved = new Set();
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) {
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); return;
  }
  const at = new Date().toISOString();
  if (m.method === 'Runtime.exceptionThrown') exceptions.push({ at, source: 'runtime-event', details: m.params.exceptionDetails });
  if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) {
    consoleMessages.push({ at, type: m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ') });
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(`Diagnostic evaluation: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const persist = () => fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ expectedBuild: build, expectedScript: script, samples, exceptions, consoleMessages }, null, 2) + '\n');
const mark = name => evaluate(`window.__trekViewerApp.profileRecorder?.mark(performance.now(), ${JSON.stringify(name)})`);
const stopCPU = async () => {
  if (!sampling) return;
  const result = await send('Profiler.stop'); sampling = false;
  fs.writeFileSync(path.join(out, 'diagnostic.cpuprofile'), JSON.stringify(result.profile));
  await mark('diagnostic-cpu-stop');
};
try {
  await send('Runtime.enable');
  const scripts = await evaluate(`[...document.scripts].map(s=>s.src)`);
  if (!scripts.some(url => url.endsWith('/' + script))) throw Error('The actual client script does not match the expected build; no recording was started.');
  if (cpuSeconds) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 }); }
  console.log(JSON.stringify({ status: 'attached', build, script, cpuSeconds, durationSeconds: seconds }));
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const sample = await evaluate(`(()=>{
      const a=window.__trekViewerApp, r=a?.sceneManager.renderer, lod=a?.activeTrek?.imageryLOD;
      if(!a||!r||!lod) return {ready:false};
      return {ready:true, at:new Date().toISOString(), recording:a.profileRecorder.isRecording,
        recordingBuild:a.profileRecorder.buildId, xr:r.xr.isPresenting, blend:r.xr.getSession()?.environmentBlendMode??'none',
        quality:a.sceneManager.getXRRenderQuality(), state:{mode:a.session.getState().viewMode, quality:a.session.getState().qualityProfile, progress:a.session.getState().progress,
          playbackMode:a.session.getState().playbackMode, playbackSpeed:a.session.getState().playbackSpeed,
          isPlaying:a.session.getState().isPlaying, followRoute:a.session.getState().followRoute},
        hud:a.spatialHUD?.getUploadDiagnostics?.(),
        diagnostics:lod.getDiagnostics(), contextLost:r.getContext().isContextLost(), completed:a.completedProfile, savedOnDevice:a.profileSavedOnDevice};
    })()`);
    if (sample.recording && !sample.recordingBuild?.startsWith(build + '-')) throw Error('Recording build does not match the requested checkpoint.');
    if (sample.xr && sample.recording) observedXR = true;
    if (sample.completed?.buildId?.startsWith(build + '-') && sample.completed.windows?.length) {
      const key = sample.completed.endedAt;
      if (!saved.has(key)) {
        saved.add(key);
        const file = `profile-${key.replace(/[^0-9A-Za-z-]/g, '-')}.json`;
        fs.writeFileSync(path.join(out, file), JSON.stringify(sample.completed, null, 2) + '\n');
        const native = sample.completed.windows.some(w => w.xrPresenting && w.xrEyeCount === 2);
        if (observedXR && native) nativeCompletedThisCapture = true;
        console.log(JSON.stringify({ status: 'report-copied', file, build: sample.completed.buildId, windows: sample.completed.windows.length,
          native, observedThisCapture: observedXR, savedOnDevice: sample.savedOnDevice }));
      }
    }
    delete sample.completed; samples.push(sample); persist();
    if (sample.xr && sample.recording) xrStarted ??= Date.now();
    if (sampling && (!sample.xr || Date.now() - cpuStarted >= cpuSeconds * 1000)) await stopCPU();
    if (cpuSeconds && !sampled && sample.xr && sample.recording && Date.now() - xrStarted >= 30000) {
      await mark('diagnostic-cpu-start'); await send('Profiler.start'); sampled = sampling = true; cpuStarted = Date.now();
    }
    if (!sample.xr) xrStarted = null;
    if (nativeCompletedThisCapture && !sample.xr && sample.savedOnDevice && !sampling) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await stopCPU(); persist();
  console.log(JSON.stringify({ status: 'finished', reportsCopied: saved.size, observedXR, nativeCompletedThisCapture, samples: samples.length, exceptions: exceptions.length }));
} catch (error) {
  exceptions.push({ at: new Date().toISOString(), source: 'diagnostic', message: String(error) }); persist(); throw error;
} finally {
  if (sampling) { try { await stopCPU(); } catch { /* Keep already saved reports on device sleep/disconnect. */ } }
  for (const p of pending.values()) clearTimeout(p.timer);
  ws.close();
}
