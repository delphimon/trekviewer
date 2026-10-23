// Runs the two default routes sequentially. No acquisition without --download.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { writePackProgress } from './offline-pack-progress.mjs';
import { offlineSourceConcurrency } from './offline-pack-pipeline.mjs';

const options = new Map(), args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(['--cache', '--out', '--download', '--identity', '--source-concurrency'].includes(key), `Unknown option ${key}`);
  if (key === '--download' || key === '--identity') options.set(key, true);
  else { assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key} value`); options.set(key, args[++i]); }
}
const output = path.resolve(options.get('--out') ?? '.review-cache/prepared-route-packs/output');
const sourceConcurrency = offlineSourceConcurrency(options.get('--source-concurrency'));
const cache = path.resolve(options.get('--cache') ?? '.review-cache/prepared-route-packs');
fs.mkdirSync(output, { recursive: true });
const stopFile = path.join(output, 'defaults.stop'), progressFile = path.join(output, 'defaults.progress.json');
const lock = path.join(output, 'defaults.prepare.lock');
const routes = ['rainier-emmons', 'enchantments-dragontail'];
const active = routes.find(route => fs.existsSync(path.join(output, route + '.prepare.lock')));
assert.ok(!active, `Preparation already active or lock needs review: ${active}`);
assert.ok(!fs.existsSync(stopFile), `Pause file exists: ${stopFile}. Remove it only when ready to resume.`);
const fd = fs.openSync(lock, 'wx'), started = new Date().toISOString(), results = [];
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started }) + '\n');
const status = async (state, extra = {}) => {
  const value = { pid: process.pid, started, updated: new Date().toISOString(), state, sourceConcurrency, results, ...extra };
  await writePackProgress(progressFile, value);
};
const stop = () => { fs.writeFileSync(stopFile, 'Pause requested\n'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await status('starting');
  for (const route of routes) {
    if (fs.existsSync(stopFile)) { await status('paused'); process.exitCode = 2; break; }
    // Recheck the current plan, provenance and all stored/original hashes.
    // Existing archive bodies/publication metadata are never overwritten.
    const existing = fs.existsSync(path.join(output, route + '.trekpack.tar'));
    await status(existing ? 'checking-existing' : 'preparing', { route });
    const childArgs = ['--experimental-transform-types', fileURLToPath(new URL('./build-offline-route-pack.mjs', import.meta.url)),
      '--route', route, '--cache', cache, '--out', output, '--stop-file', stopFile, '--source-concurrency', String(sourceConcurrency)];
    if (existing) childArgs.push('--reuse-existing');
    else for (const flag of ['--download', '--identity']) if (options.has(flag)) childArgs.push(flag);
    const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const outputLines = createInterface({ input: child.stdout });
    outputLines.on('line', line => { console.log(line); });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const inventoryFile = path.join(output, route + '.inventory.json');
    let inventory;
    try { if (fs.statSync(inventoryFile).size <= 64 * 1024) inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8')); } catch { /* A failed source must not prevent checking the other route. */ }
    const complete = code === 0 && inventory?.complete === true && fs.existsSync(path.join(output, route + '.trekpack.tar'));
    results.push({ route, state: complete ? 'complete' : existing ? 'existing-archive-requires-review' : options.has('--download') ? 'unfinished' : 'inventory-only', code, reused: existing && complete,
      archiveBytes: complete ? inventory.archiveBytes : undefined, originalSourceBytes: complete ? inventory.originalSourceBytes : undefined });
    if (!complete) process.exitCode = code || 1;
    // An unavailable route does not prevent attempting the other default route.
    await status('between-routes');
  }
  await status(fs.existsSync(stopFile) ? 'paused' : results.every(r => r.state === 'complete') ? 'complete' : 'unfinished');
} catch (error) { await status('failed', { error: error.message }); throw error; }
finally { fs.closeSync(fd); fs.unlinkSync(lock); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
