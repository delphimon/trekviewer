// Node 24 + --experimental-transform-types. Read-only local archive/source work;
// no source downloads, IndexedDB import, headset access or automatic publication.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openOfflinePreparationValidator } from './offline-preparation-validator.mjs';
import { verifyOfflineRoutePack } from './offline-pack-verification.mjs';
import { writePackProgress } from './offline-pack-progress.mjs';
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(['--file', '--route', '--out', '--stop-file'].includes(key), `Unknown option ${key}`);
  assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key} value`); options.set(key, args[++i]);
}
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { DEFAULT_OFFLINE_ROUTES, planOfflineRoute } = await import('../src/offline/OfflinePlan.ts');
const routeId = options.get('--route'); assert.ok(DEFAULT_OFFLINE_ROUTES.includes(routeId), 'Choose --route rainier-emmons or enchantments-dragontail');
assert.ok(options.has('--file'), 'Choose --file <complete route .tar>');
const file = path.resolve(options.get('--file'));
assert.ok(file.endsWith('.tar') && fs.statSync(file).isFile(), 'Choose a completed .tar file, not a partial archive');
const route = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8')).find(r => r.id === routeId);
const xml = fs.readFileSync('public' + route.file, 'utf8').replace(/\r\n?/g, '\n');
const plan = planOfflineRoute(GPXParser.parse(xml), routeId, createHash('sha256').update(xml).digest('hex'));
const out = path.resolve(options.get('--out') ?? '.review-cache/verified-route-packs'); fs.mkdirSync(out, { recursive: true });
const lock = path.join(out, routeId + '.verify.lock'), fd = fs.openSync(lock, 'wx');
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), file }) + '\n');
const controller = new AbortController(), stop = () => controller.abort();
const stopFile = options.has('--stop-file') ? path.resolve(options.get('--stop-file')) : undefined;
const checkpoint = () => { if (stopFile && fs.existsSync(stopFile)) stop(); controller.signal.throwIfAborted(); };
const poll = stopFile ? setInterval(() => { if (fs.existsSync(stopFile)) stop(); }, 250) : undefined; poll?.unref();
const progressFile = path.join(out, routeId + '.verification.progress.json'); let validator;
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  checkpoint(); await writePackProgress(progressFile, { phase: 'starting', file, pid: process.pid });
  validator = await openOfflinePreparationValidator(path.join(out, routeId + '-validator'));
  const report = await verifyOfflineRoutePack(validator, file, plan, { signal: controller.signal, async onProgress(value) {
    checkpoint(); await writePackProgress(progressFile, { ...value, file, pid: process.pid, updated: new Date().toISOString() });
    if (value.validated % 32 === 0 || value.phase !== 'validating') console.log(JSON.stringify(value));
  } });
  checkpoint();
  const final = path.join(out, routeId + '.verified.json');
  fs.writeFileSync(final + '.partial', JSON.stringify({ ...report, file }, null, 2) + '\n');
  checkpoint(); fs.renameSync(final + '.partial', final);
  await writePackProgress(progressFile, { ...report, file, pid: process.pid });
  console.log(JSON.stringify({ verified: true, report: final, archiveSha256: report.archiveSha256 }));
} catch (error) {
  await writePackProgress(progressFile, { phase: controller.signal.aborted ? 'paused' : 'failed', error: error.message, file, pid: process.pid });
  console.error(error.message); process.exitCode = controller.signal.aborted ? 2 : 1;
} finally {
  clearInterval(poll); await validator?.close(); fs.closeSync(fd); fs.unlinkSync(lock);
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
