// Node 24 + --experimental-transform-types. Inventory/cache check only unless
// --download is explicit. Complete validated sources are required for an archive.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openOfflinePreparationValidator } from './offline-preparation-validator.mjs';
import { acquireOfflineSource, acquireOfflineResource, OfflineSourceHealth } from './offline-pack-acquisition.mjs';
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { DEFAULT_OFFLINE_ROUTES, planOfflineRoute } = await import('../src/offline/OfflinePlan.ts');
const { offlineSourceAllowed } = await import('../src/offline/OfflineStore.ts');
const { archiveInventoryHash, archiveRequestProvenance } = await import('../src/offline/OfflineArchive.ts');
const { writeOfflineRouteArchive } = await import('./offline-pack-writer.mjs');
const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  assert.ok(['--route', '--cache', '--out', '--download', '--identity', '--stop-file'].includes(key), `Unknown option ${key}`);
  if (key === '--download' || key === '--identity') options.set(key, true);
  else { assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${key} value`); options.set(key, args[++i]); }
}
const id = options.get('--route'); assert.ok(DEFAULT_OFFLINE_ROUTES.includes(id), 'Choose --route rainier-emmons or enchantments-dragontail');
const cache = path.resolve(options.get('--cache') ?? '.review-cache/prepared-route-packs'), bodies = path.join(cache, 'bodies');
const output = path.resolve(options.get('--out') ?? '.review-cache/prepared-route-packs/output');
fs.mkdirSync(bodies, { recursive: true }); fs.mkdirSync(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const route = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8')).find(r => r.id === id);
const xml = fs.readFileSync('public' + route.file, 'utf8').replace(/\r\n?/g, '\n'), plan = planOfflineRoute(GPXParser.parse(xml), id, sha(xml));
assert.ok(!fs.existsSync(path.join(output, id + '.trekpack.tar')), 'Output already exists; choose another --out directory');
const oldProbe = fs.existsSync(path.join(cache, 'probe.json')) ? JSON.parse(fs.readFileSync(path.join(cache, 'probe.json'), 'utf8')) : null;
const known = new Map(oldProbe?.results.flatMap(r => r.samples.flatMap(s => s.attempts.filter(a => a.passed).map(a => [a.url, a]))) ?? []);
const bodyPath = url => path.join(bodies, sha(url) + '.bin');
function metadata(url) {
  const file = path.join(bodies, sha(url) + '.json');
  if (!fs.existsSync(file)) return known.get(url);
  try {
    assert.ok(fs.statSync(file).size <= 16384, 'Invalid source metadata');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m.url === url && Number.isSafeInteger(m.bytes) && m.bytes > 0 && /^[a-f0-9]{64}$/.test(m.sha256) ? m : undefined;
  } catch { return undefined; }
}
const missing = plan.resources.filter(r => !r.urls.some(url => fs.existsSync(bodyPath(url)) && metadata(url)));
const inventory = { planId: plan.id, routeId: id, routeHash: plan.routeHash, inventorySha256: await archiveInventoryHash(plan),
  sources: plan.resources.length, missingSources: missing.length, uncompressedBudgetBytes: plan.estimatedBytes,
  mode: options.has('--download') ? 'Explicit bounded acquisition and complete archive preparation' : 'Local inventory/cache check only; no network acquisition',
  complete: false };
fs.writeFileSync(path.join(output, id + '.inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
fs.writeFileSync(path.join(output, id + '.plan.json'), JSON.stringify(plan) + '\n');
console.log(JSON.stringify(inventory));
if (missing.length && !options.has('--download')) { process.exitCode = 2; }
else {
  const lock = path.join(output, id + '.prepare.lock'), lockFd = fs.openSync(lock, 'wx');
  fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, routeId: id, started: new Date().toISOString() }) + '\n');
  let validator;
  const controller = new AbortController(), stop = () => controller.abort();
  const stopFile = options.has('--stop-file') ? path.resolve(options.get('--stop-file')) : undefined;
  const checkpoint = () => { if (stopFile && fs.existsSync(stopFile)) stop(); controller.signal.throwIfAborted(); };
  const pausePoll = stopFile ? setInterval(() => { if (fs.existsSync(stopFile)) stop(); }, 250) : undefined;
  pausePoll?.unref();
  const progressFile = path.join(output, id + '.progress.json'), started = Date.now();
  let validated = 0, originalSourceBytes = 0, storedSourceBytes = 0, retainedSources = 0, downloadedSources = 0, requestedAliases = 0, firstRequestedIndex;
  const progress = (state, extra = {}) => {
    const value = { routeId: id, planId: plan.id, pid: process.pid, state, validated, total: plan.resources.length,
      originalSourceBytes, storedSourceBytes, retainedSources, downloadedSources, requestedAliases, firstRequestedIndex,
      elapsedSeconds: (Date.now() - started) / 1000, updated: new Date().toISOString(), ...extra };
    fs.writeFileSync(progressFile + '.partial', JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(progressFile + '.partial', progressFile);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const free = (bytes, directory = output) => {
    const s = fs.statfsSync(directory, { bigint: true });
    if (s.bavail * s.bsize < BigInt(bytes) + 512n * 1024n * 1024n) throw Error('Not enough disk space. Retained sources can be reused after freeing space.');
  };
  try {
    checkpoint(); progress('preparing');
    validator = await openOfflinePreparationValidator(path.join(cache, 'validator'));
    const records = [], files = [], health = new OfflineSourceHealth();
    for (let index = 0; index < plan.resources.length; index++) {
      checkpoint();
      const resource = plan.resources[index], limit = (resource.kind === 'image' ? 8 : 32) * 1024 * 1024;
      assert.ok(resource.urls.every(offlineSourceAllowed));
      const accepted = await acquireOfflineResource(resource, controller.signal, {
        health,
        readRetained(url) {
          const meta = metadata(url);
          if (fs.existsSync(bodyPath(url)) && meta) {
            try {
              assert.ok(fs.statSync(bodyPath(url)).size <= limit); const bytes = fs.readFileSync(bodyPath(url));
              assert.equal(bytes.length, meta.bytes); assert.equal(sha(bytes), meta.sha256); return bytes;
            } catch { /* Invalid originals can be acquired again with --download. */ }
          }
        },
        download: options.has('--download') ? async url => {
          checkpoint(); free(limit * 2, bodies);
          requestedAliases++; firstRequestedIndex ??= index;
          return acquireOfflineSource(url, limit, controller.signal, { onRetry: retry => console.error(JSON.stringify({ index, source: resource.urls.indexOf(url), retry })) });
        } : undefined,
        async validate(bytes) {
          checkpoint(); await validator.validate(resource, bytes);
          checkpoint();
        },
        save(url, bytes, retained) {
          if (!retained) {
            free(bytes.length, bodies); fs.writeFileSync(bodyPath(url) + '.partial', bytes); fs.renameSync(bodyPath(url) + '.partial', bodyPath(url));
          }
          fs.writeFileSync(path.join(bodies, sha(url) + '.json'), JSON.stringify({ url, bytes: bytes.length, sha256: sha(bytes) }) + '\n');
        },
        onFailure: (url, error, retained) => console.error(JSON.stringify({ index, source: resource.urls.indexOf(url), retained, error: error.message })),
      });
      checkpoint();
      assert.ok(accepted, `Source ${index + 1} unavailable or invalid. Completed sources remain cached; retry to resume.`);
      const original = accepted.bytes;
      let stored = original, encoding = 'identity', file = bodyPath(accepted.url);
      if (resource.kind === 'elevation' && !options.has('--identity')) {
        const compressed = gzipSync(original, { level: 6 });
        assert.ok(gunzipSync(compressed, { maxOutputLength: original.length }).equals(original));
        if (compressed.length < original.length) {
          stored = compressed; encoding = 'gzip'; file = path.join(bodies, sha(accepted.url) + '.lerc.gz'); free(stored.length, bodies); fs.writeFileSync(file, stored);
        }
      }
      records.push({ index, sourceIndex: accepted.sourceIndex, encoding, bytes: original.length, sha256: sha(original), storedBytes: stored.length, storedSha256: sha(stored), ...await archiveRequestProvenance(accepted.url) });
      files.push(file);
      if (accepted.retained) retainedSources++; else downloadedSources++;
      validated = index + 1; originalSourceBytes += original.length; storedSourceBytes += stored.length; progress('acquiring');
      if ((index + 1) % 32 === 0 || index + 1 === plan.resources.length) console.log(JSON.stringify({ validated: index + 1, total: plan.resources.length }));
    }
    checkpoint(); progress('writing-archive');
    const final = path.join(output, id + '.trekpack.tar'), result = await writeOfflineRouteArchive(plan, records, files, final, controller.signal, checkpoint);
    fs.writeFileSync(path.join(output, id + '.inventory.json'), JSON.stringify({ ...inventory, complete: true, ...result }, null, 2) + '\n');
    console.log(JSON.stringify({ complete: true, ...result, file: final }));
    progress('complete', result);
  } catch (error) {
    progress(controller.signal.aborted ? 'paused' : 'failed', { error: error.message }); throw error;
  } finally { clearInterval(pausePoll); await validator?.close(); fs.closeSync(lockFd); fs.unlinkSync(lock); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
