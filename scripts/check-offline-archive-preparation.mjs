import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { openOfflinePreparationValidator } from './offline-preparation-validator.mjs';
import { acquireOfflineResource, acquireOfflineSource } from './offline-pack-acquisition.mjs';
import { orderedOfflineSources, offlineValidationLane } from './offline-pack-pipeline.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { writeOfflineRouteArchive } = await import('./offline-pack-writer.mjs');
const { archiveRequestProvenance } = await import('../src/offline/OfflineArchive.ts');
const root = path.resolve('.review-cache/portable-packs/preparation-fixture');
const out = path.join(root, String(Date.now())); fs.mkdirSync(out, { recursive: true });
const probeRoot = path.resolve('.review-cache/offline-real-defaults'), probe = JSON.parse(fs.readFileSync(path.join(probeRoot, 'probe.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const demMetadata = JSON.parse(fs.readFileSync('test/fixtures/elevation/rainier-3dep-window.json', 'utf8'));
const input = [{ resource: { kind: 'elevation', urls: [demMetadata.request.url], width: demMetadata.request.width, height: demMetadata.request.height },
  bytes: fs.readFileSync('test/fixtures/elevation/rainier-3dep-window.lerc') }];
for (const label of ['imagery-z17', 'imagery-z18']) {
  const sample = probe.results[0].samples.find(s => s.label === label), accepted = sample.attempts.find(a => a.passed);
  const bytes = fs.readFileSync(path.join(probeRoot, 'bodies', sha(accepted.url) + '.bin')); assert.equal(sha(bytes), accepted.sha256);
  input.push({ resource: sample.resource, bytes });
}
const plan = { id: 'controlled-archive-fixture-v1', routeId: 'controlled-archive-fixture', routeHash: 'a'.repeat(64),
  name: 'Real source component fixture — not a complete route', version: 1, coverage: 'full-model', maxZoom: 19,
  estimatedBytes: input.reduce((n, s) => n + s.bytes.length, 0), resources: input.map(s => s.resource) };
const validator = await openOfflinePreparationValidator(path.join(out, 'validator'));
try {
  const runs = [];
  for (const concurrency of [1, 2]) {
    const directory = path.join(out, `lanes-${concurrency}`); fs.mkdirSync(directory);
    const files = [], records = [], completed = []; let activeSources = 0, peakSources = 0, activeValidation = 0, peakValidation = 0;
    const validate = offlineValidationLane(async (resource, bytes) => {
      activeValidation++; peakValidation = Math.max(peakValidation, activeValidation);
      try { await validator.validate(resource, bytes); } finally { activeValidation--; }
    });
    for await (const { index, value: accepted } of orderedOfflineSources(input, async (s, index, signal) => {
      activeSources++; peakSources = Math.max(peakSources, activeSources);
      try {
        const result = await acquireOfflineResource(s.resource, signal, {
          readRetained: () => undefined,
          download: url => acquireOfflineSource(url, (s.resource.kind === 'image' ? 8 : 32) * 1024 * 1024, signal, {
            // Controlled delayed transport of hash-checked retained originals;
            // no external requests or public-service throughput claim.
            fetchSource: async (requested, options) => {
              assert.equal(requested, url); await delay(index === 0 ? 180 : 60, undefined, { signal: options.signal });
              return new Response(s.bytes);
            },
          }),
          validate: bytes => validate(s.resource, bytes, signal),
          save: (url, bytes) => { assert.equal(sha(bytes), sha(s.bytes)); },
        });
        completed.push(index); return result;
      } finally { activeSources--; }
    }, undefined, concurrency)) {
      const s = input[index]; assert.equal(sha(accepted.bytes), sha(s.bytes));
      const encoding = index === 0 ? 'gzip' : 'identity', stored = index === 0 ? gzipSync(accepted.bytes) : accepted.bytes;
      const file = path.join(directory, index + '.bin'); fs.writeFileSync(file, stored); files.push(file);
      records.push({ index, sourceIndex: accepted.sourceIndex, encoding, bytes: s.bytes.length, sha256: sha(s.bytes), storedBytes: stored.length, storedSha256: sha(stored), ...await archiveRequestProvenance(accepted.url) });
    }
    assert.equal(peakSources, concurrency); assert.equal(peakValidation, 1);
    const archive = path.join(directory, 'controlled-source-components.trekpack.tar');
    const result = await writeOfflineRouteArchive(plan, records, files, archive);
    runs.push({ concurrency, peakSources, peakValidation, completed, archive, files, records, ...result, archiveSha256: sha(fs.readFileSync(archive)) });
  }
  assert.equal(runs[0].archiveSha256, runs[1].archiveSha256, 'Source overlap changed archive bytes or inventory order');
  assert.deepEqual(runs[1].completed, [1, 0, 2]);
  const { archive, files, records, ...result } = runs[1];
  const names = execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  assert.deepEqual(names, ['trekviewer-pack.json', 'sources/000000.bin.gz', 'sources/000001.bin', 'sources/000002.bin']);
  const paused = path.join(out, 'paused-must-not-publish.tar'), controller = new AbortController(); let checkpoints = 0;
  await assert.rejects(() => writeOfflineRouteArchive(plan, records, files, paused, controller.signal, () => {
    if (++checkpoints === 2) controller.abort(); controller.signal.throwIfAborted();
  }), error => error.name === 'AbortError');
  assert.equal(checkpoints, 2); assert.equal(fs.existsSync(paused), false); assert.ok(fs.statSync(paused + '.partial').size > 0);
  const failed = path.join(out, 'damaged-source-must-not-publish.tar'), damaged = Buffer.from(fs.readFileSync(files[0])); damaged[0] ^= 1; fs.writeFileSync(files[0], damaged);
  await assert.rejects(() => writeOfflineRouteArchive(plan, records, files, failed), /Cached source changed/);
  assert.equal(fs.existsSync(failed), false);
  const report = { condition: 'Three real public-source components under an explicitly controlled fixture identity. Controlled delayed source responses, no external requests or public-service speed claim. One/two source lanes, one production browser validator, byte-identical ordered archives, lazy file header check, independent system tar listing and damaged-source publication rejection. Not a full Rainier or Enchantments pack.',
    plan, archive, ...result, pipelineRuns: runs.map(({ files, archive, records, ...r }) => r), identicalArchiveBytes: true, names, damagedSourceRejected: true, pausedArchiveNotPublished: true };
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, archiveBytes: result.archiveBytes, names, out }));
} finally { await validator.close(); }
