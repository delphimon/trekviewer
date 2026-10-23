// PC post-processing: observe atomic archive publication, then independently
// verify each complete default file. No downloads, headset access or auto-import.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writePackProgress } from './offline-pack-progress.mjs';
import { preparedArchiveReadiness, verifiedArchiveResult, acquisitionQueueState } from './offline-pack-readiness.mjs';

const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(['--packs', '--out', '--watch', '--stop-file'].includes(key), `Unknown option ${key}`);
  if (key === '--watch') options.set(key, true);
  else { assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key} value`); options.set(key, args[++i]); }
}
const packs = path.resolve(options.get('--packs') ?? '.review-cache/prepared-route-packs/output');
const out = path.resolve(options.get('--out') ?? '.review-cache/verified-route-packs');
fs.mkdirSync(out, { recursive: true });
const stopFile = path.resolve(options.get('--stop-file') ?? path.join(out, 'defaults.verification.stop'));
assert.ok(!fs.existsSync(stopFile), `Verification pause file exists: ${stopFile}`);
const lock = path.join(out, 'defaults.verify.lock'), fd = fs.openSync(lock, 'wx');
const started = new Date().toISOString(), results = [], pending = new Set(['rainier-emmons', 'enchantments-dragontail']);
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started, packs }) + '\n');
const controller = new AbortController();
const stop = () => { fs.writeFileSync(stopFile, 'Verification pause requested\n'); controller.abort(); };
const checkpoint = () => { if (fs.existsSync(stopFile)) controller.abort(); controller.signal.throwIfAborted(); };
const status = async (state, extra = {}) => writePackProgress(path.join(out, 'defaults.verification.progress.json'), {
  pid: process.pid, started, updated: new Date().toISOString(), state, results, pending: [...pending], ...extra,
});
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await status('starting'); let lastWaitingReport = 0;
  while (pending.size) {
    checkpoint();
    const candidates = [...pending].map(routeId => ({ routeId, readiness: preparedArchiveReadiness(packs, routeId) }));
    const candidate = candidates.find(c => c.readiness.ready);
    if (candidate) {
      const { routeId, readiness } = candidate;
      await status('verifying', { routeId });
      const childArgs = ['--experimental-transform-types', fileURLToPath(new URL('./verify-offline-route-pack.mjs', import.meta.url)),
        '--route', routeId, '--file', readiness.file, '--out', out, '--stop-file', stopFile];
      const child = spawn(process.execPath, childArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => process.stdout.write(bytes)); child.stderr.on('data', bytes => process.stderr.write(bytes));
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      checkpoint();
      try { results.push(verifiedArchiveResult(out, readiness, code)); }
      catch (error) { results.push({ routeId, state: 'failed', error: error.message }); process.exitCode = 1; }
      pending.delete(routeId); await status('between-routes'); continue;
    }
    const sourceQueue = acquisitionQueueState(packs);
    const waiting = candidates.map(c => ({ routeId: c.routeId, reason: c.readiness.reason }));
    if (!options.has('--watch') || ['complete', 'unfinished', 'failed', 'paused'].includes(sourceQueue)) {
      await status('unfinished', { acquisitionState: sourceQueue, waiting }); process.exitCode = 2; break;
    }
    if (Date.now() - lastWaitingReport >= 30000) {
      await status('waiting-archives', { acquisitionState: sourceQueue, waiting }); lastWaitingReport = Date.now();
    }
    await delay(5000, undefined, { signal: controller.signal });
  }
  if (!pending.size) await status(results.every(r => r.state === 'verified') ? 'verified' : 'unfinished');
} catch (error) {
  await status(controller.signal.aborted ? 'paused' : 'failed', { error: error.message });
  console.error(error.message); process.exitCode = controller.signal.aborted ? 2 : 1;
} finally {
  fs.closeSync(fd); fs.unlinkSync(lock); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
