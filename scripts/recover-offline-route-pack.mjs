// Node 24 + --experimental-transform-types. Recover only a completed producer's
// assembled local file; verify current-plan provenance and every body hash.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectAssembledArchive } from './offline-pack-recovery.mjs';
import { writePackProgress } from './offline-pack-progress.mjs';
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { DEFAULT_OFFLINE_ROUTES, planOfflineRoute } = await import('../src/offline/OfflinePlan.ts');
const { archiveInventoryHash } = await import('../src/offline/OfflineArchive.ts');
const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i]; assert.ok(['--route', '--packs', '--stop-file'].includes(key), `Unknown option ${key}`);
  assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key} value`); options.set(key, args[++i]);
}
const routeId = options.get('--route'); assert.ok(DEFAULT_OFFLINE_ROUTES.includes(routeId), 'Choose a default route');
const root = path.resolve(options.get('--packs') ?? '.review-cache/prepared-route-packs/output');
const final = path.join(root, routeId + '.trekpack.tar'), partial = final + '.partial';
const lock = path.join(root, routeId + '.prepare.lock'), fd = fs.openSync(lock, 'wx');
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, routeId, phase: 'recovering', started: new Date().toISOString() }));
const controller = new AbortController(), stop = () => controller.abort();
const stopFile = options.has('--stop-file') ? path.resolve(options.get('--stop-file')) : undefined;
const checkpoint = () => { if (stopFile && fs.existsSync(stopFile)) stop(); controller.signal.throwIfAborted(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  checkpoint();
  const inventoryFile = path.join(root, routeId + '.inventory.json'), progressFile = path.join(root, routeId + '.progress.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile)), progress = JSON.parse(fs.readFileSync(progressFile));
  assert.ok(inventory.complete !== true && progress.state === 'failed' && progress.validated === progress.total, 'Recovery requires a failed producer with every source validated');
  const route = JSON.parse(fs.readFileSync('public/routes/manifest.json')).find(r => r.id === routeId);
  const xml = fs.readFileSync('public' + route.file, 'utf8').replace(/\r\n?/g, '\n');
  const plan = planOfflineRoute(GPXParser.parse(xml), routeId, createHash('sha256').update(xml).digest('hex'));
  assert.equal(inventory.routeId, routeId); assert.equal(inventory.routeHash, plan.routeHash);
  assert.equal(progress.routeId, routeId); assert.equal(progress.planId, plan.id);
  assert.equal(inventory.planId, plan.id); assert.equal(inventory.inventorySha256, await archiveInventoryHash(plan));
  assert.equal(progress.validated, plan.resources.length); assert.equal(inventory.sources, plan.resources.length);
  const candidate = fs.existsSync(final) ? final : partial;
  assert.ok(fs.lstatSync(candidate).isFile(), 'Assembled archive must be a regular file');
  const report = await inspectAssembledArchive(candidate, plan, controller.signal, async value => {
    checkpoint();
    if (value.checked % 32 === 0 || value.checked === value.sources) {
      await writePackProgress(path.join(root, routeId + '.recovery.progress.json'), { phase: 'checking-source-hashes', ...value, pid: process.pid });
      console.log(JSON.stringify({ checked: value.checked, total: value.sources }));
    }
  });
  assert.equal(report.originalSourceBytes, progress.originalSourceBytes); assert.equal(report.storedSourceBytes, progress.storedSourceBytes);
  checkpoint();
  const recovery = { ...report, recoveredAt: new Date().toISOString(), file: final,
    condition: 'Recovered a fully assembled local producer archive using bounded 64-bit file reads, current-plan provenance and all stored/original hashes. No source acquisition, pixel/height changes or re-encoding. Independent native-browser coverage verification and import acceptance follow.' };
  if (candidate === partial) fs.renameSync(partial, final);
  checkpoint();
  const published = { ...inventory, complete: true, missingSources: 0, archiveBytes: report.archiveBytes,
    originalSourceBytes: report.originalSourceBytes, manifestSha256: report.manifestSha256, recovered: true };
  assert.ok(await writePackProgress(inventoryFile, published), 'Required publication inventory could not be replaced; rerun recovery after releasing its reader');
  fs.writeFileSync(path.join(root, routeId + '.recovery.json'), JSON.stringify(recovery, null, 2) + '\n');
  await writePackProgress(progressFile, { ...progress, state: 'complete', recovered: true, recoveryPid: process.pid, updated: new Date().toISOString() });
  console.log(JSON.stringify({ recovered: true, archiveBytes: report.archiveBytes, file: final, sources: report.sources }));
} finally {
  fs.closeSync(fd); fs.unlinkSync(lock); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
