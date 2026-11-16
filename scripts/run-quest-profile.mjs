#!/usr/bin/env node
// Automates the manual steps in docs/QUEST_PROFILE.md for a USB/ADB-connected,
// authorized Quest: forward Quest Browser's DevTools socket, open the app with
// ?profile=1, enter VR with a real user gesture, dwell, exit, copy the report
// the app's own recorder produced, and print `profile:summary` for it.
//
// Prerequisites: developer mode on, headset awake and tracking (a "Finding
// position in room" dialog blocks launches), proximity sensor disabled if the
// headset is not being worn (`metavr device proximity disable`).
// It changes no headset settings. It does not use or need your page's data.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const flag = name => args.includes(name);
const url = option('--url', 'https://trekviewer.surge.sh/');
const dwell = Number(option('--dwell', '60'));
const port = Number(option('--port', '9222'));
const serial = option('--device', process.env.METAVR_DEVICE ?? '');
const out = path.resolve(option('--out', '.review-cache/quest-auto'));
// Optional scenario applied right after XR entry (values are whitelisted, never interpolated raw).
const view = option('--view', '');                // diorama | first-person
const playbackMode = option('--playback-mode', ''); // tour | recorded
const speed = option('--speed', '');
const play = flag('--play'), follow = flag('--follow');
// Optional V8 CPU sampling (after --cpu-after seconds in XR) for attributing hitches; marked in the app's report.
const cpuSeconds = Number(option('--cpu-seconds', '0')), cpuAfter = Number(option('--cpu-after', '20'));
if (!Number.isFinite(cpuSeconds) || cpuSeconds < 0 || cpuSeconds > 120 || !Number.isFinite(cpuAfter) || cpuAfter < 0) throw Error('--cpu-seconds 0-120, --cpu-after >=0');
if ((view && !['diorama', 'first-person'].includes(view)) || (playbackMode && !['tour', 'recorded'].includes(playbackMode))
  || (speed && !(Number(speed) > 0 && Number(speed) <= 60))) {
  throw Error('--view diorama|first-person, --playback-mode tour|recorded, --speed 0-60');
}
if (!Number.isFinite(dwell) || dwell < 10 || dwell > 1800 || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw Error('Usage: node scripts/run-quest-profile.mjs [--url <https url>] [--dwell 60] [--port 9222] [--device <serial>] [--out <dir>] [--no-navigate] [--view diorama|first-person] [--playback-mode tour|recorded] [--speed N] [--play] [--follow] [--cpu-seconds N] [--cpu-after 20]');
}
fs.mkdirSync(out, { recursive: true });

const adb = process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : 'adb';
const adbArgs = a => (serial ? ['-s', serial, ...a] : a);
// The USB link can re-enumerate (dropping forwards), so forwarding is repeatable.
const forward = () => {
  const r = spawnSync(adb, adbArgs(['forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote']), { encoding: 'utf8' });
  if (r.status !== 0) throw Error(`adb forward failed: ${r.stderr || r.stdout || 'is the headset connected and authorized?'}`);
};
forward();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = u => { const x = new URL(u); x.searchParams.set('profile', '1'); return x.toString(); };
const listTabs = async () => {
  for (let attempt = 0; ; attempt++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json(); }
    catch (error) { if (attempt >= 3) throw Error(`Cannot reach Quest Browser DevTools on :${port} (browser closed, headset asleep, or USB reconnected): ${error.cause?.code ?? error}`); forward(); await sleep(2000); }
  }
};
const tabs = async () => (await listTabs())
  .filter(t => t.type === 'page' && new URL(t.url, 'about:blank').origin === new URL(url).origin);
let tab = (await tabs())[0];
if (!tab) throw Error(`No Quest Browser tab on ${new URL(url).origin}; open it once (metavr device browser ${url}) and retry.`);

let ws, next = 0; const pending = new Map(), problems = [];
const connect = async () => {
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
  });
  await send('Runtime.enable'); await send('Page.enable');
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 20000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, userGesture = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (what, expression, seconds) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { const v = await evaluate(expression).catch(() => null); if (v) return v; await sleep(1000); }
  throw Error(`Timed out after ${seconds}s waiting for ${what}.${problems.length ? ' Page problems: ' + problems.slice(-3).join(' | ') : ''}`);
};
const present = `!!window.__trekViewerApp?.sceneManager?.renderer?.xr?.isPresenting`;
const endSession = `window.__trekViewerApp?.sceneManager.renderer.xr.getSession()?.end().then(()=>true)`;

await connect();
try {
  if (await evaluate(present).catch(() => false)) { console.log('Leaving the existing XR session first'); await evaluate(endSession); await sleep(3000); }
  if (!flag('--no-navigate')) { await send('Page.navigate', { url: target(url) }); await sleep(2000); ws.close(); tab = (await tabs())[0]; await connect(); }
  await waitFor('the app and route to load (needs ?profile=1)', `!!(window.__trekViewerApp?.profile && window.__trekViewerApp.sceneManager?.renderer)`, 90);
  await waitFor('the Enter VR button to become available', `(()=>{const b=document.getElementById('btnEnterVR'); return !!b && !b.disabled;})()`, 60);
  console.log(JSON.stringify({ status: 'ready', url: await evaluate('location.href') }));

  const clicked = await evaluate(`(()=>{const b=document.getElementById('btnEnterVR'); if(!b) return 'missing'; if(b.disabled) return 'disabled'; b.click(); return 'clicked';})()`, true);
  if (clicked !== 'clicked') throw Error(`Enter VR button is ${clicked}`);
  await waitFor('an immersive session (is the headset awake and tracking?)', `${present} && !!window.__trekViewerApp.profile.isRecording`, 30);
  if (view || playbackMode || speed || play || follow) {
    // Order matters: view mode resets speed to 1x. Play goes through the app's togglePlay(), which starts
    // the flyover; TrekSession.setPlayback() alone only mirrors that state for the UI.
    const applied = await evaluate(`(()=>{const a=window.__trekViewerApp, s=a.session;
      ${view ? `s.setViewMode(${JSON.stringify(view)});` : ''}
      ${playbackMode ? `s.setPlaybackMode(${JSON.stringify(playbackMode)});` : ''}
      ${speed ? `s.setSpeed(${Number(speed)});` : ''}
      ${follow ? 's.setFollowRoute(true);' : ''}
      ${play ? "if(!a.flyoverController?.getIsPlaying()) a.togglePlay();" : ''}
      const x=s.getState(); return {viewMode:x.viewMode, playbackMode:x.playbackMode, speed:x.playbackSpeed, isPlaying:x.isPlaying, follow:x.followRoute, controllerPlaying:!!a.flyoverController?.getIsPlaying()};})()`);
    console.log(JSON.stringify({ status: 'scenario', applied }));
  }
  console.log(JSON.stringify({ status: 'in-xr', dwellSeconds: dwell }));
  const samples = []; const t0 = Date.now(); let cpu = 0; // 0 idle, 1 sampling, 2 done
  const stopCpu = async () => {
    if (cpu !== 1) return; cpu = 2;
    const { profile } = await send('Profiler.stop');
    fs.writeFileSync(path.join(out, 'diagnostic.cpuprofile'), JSON.stringify(profile));
    await evaluate(`window.__trekViewerApp.profile.mark('diagnostic-cpu-stop')`);
    console.log(JSON.stringify({ status: 'cpu-profile-saved', file: path.join(out, 'diagnostic.cpuprofile') }));
  };
  for (let end = t0 + dwell * 1000; Date.now() < end; await sleep(5000)) {
    const s = await evaluate(`(()=>{const a=window.__trekViewerApp; return {xr:${present}, rec:a.profile.isRecording}})()`);
    samples.push(s);
    if (!s.xr) { await stopCpu().catch(() => {}); throw Error('The XR session ended early (headset doffed, sleep, or app crash); report not completed by this run.'); }
    const elapsed = (Date.now() - t0) / 1000;
    if (cpuSeconds && cpu === 0 && elapsed >= cpuAfter) {
      await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 });
      await evaluate(`window.__trekViewerApp.profile.mark('diagnostic-cpu-start')`); await send('Profiler.start'); cpu = 1;
      console.log(JSON.stringify({ status: 'cpu-profile-started', atSeconds: Math.round(elapsed), seconds: cpuSeconds }));
    }
    if (cpu === 1 && elapsed >= cpuAfter + cpuSeconds) await stopCpu();
  }
  await stopCpu();
  await evaluate(endSession);
  const report = await waitFor('the completed report to save on the device',
    `(()=>{const p=window.__trekViewerApp?.profile; const c=p?.completed; return c?.windows?.length && p.savedOnDevice ? c : null;})()`, 60);
  const file = path.join(out, `profile-${String(report.endedAt).replace(/[^0-9A-Za-z-]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  if (problems.length) fs.writeFileSync(path.join(out, 'page-problems.txt'), problems.join('\n') + '\n');
  console.log(JSON.stringify({ status: 'report-copied', file, windows: report.windows.length, build: report.buildId, pageProblems: problems.length }));
  const here = path.dirname(fileURLToPath(import.meta.url));
  spawn(process.execPath, [path.join(here, 'summarize-profile.mjs'), file], { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0));
} finally { ws.close(); }
