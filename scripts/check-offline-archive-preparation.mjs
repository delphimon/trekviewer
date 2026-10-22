import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { openOfflinePreparationValidator } from './offline-preparation-validator.mjs';
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
  const files = [], records = [];
  for (let index = 0; index < input.length; index++) {
    const s = input[index]; await validator.validate(s.resource, s.bytes);
    const encoding = index === 0 ? 'gzip' : 'identity', stored = index === 0 ? gzipSync(s.bytes) : s.bytes;
    const file = path.join(out, index + '.bin'); fs.writeFileSync(file, stored); files.push(file);
    records.push({ index, sourceIndex: 0, encoding, bytes: s.bytes.length, sha256: sha(s.bytes), storedBytes: stored.length, storedSha256: sha(stored), ...await archiveRequestProvenance(s.resource.urls[0]) });
  }
  const archive = path.join(out, 'controlled-source-components.trekpack.tar');
  const result = await writeOfflineRouteArchive(plan, records, files, archive);
  const names = execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  assert.deepEqual(names, ['trekviewer-pack.json', 'sources/000000.bin.gz', 'sources/000001.bin', 'sources/000002.bin']);
  const failed = path.join(out, 'damaged-source-must-not-publish.tar'), damaged = Buffer.from(fs.readFileSync(files[0])); damaged[0] ^= 1; fs.writeFileSync(files[0], damaged);
  await assert.rejects(() => writeOfflineRouteArchive(plan, records, files, failed), /Cached source changed/);
  assert.equal(fs.existsSync(failed), false);
  const report = { condition: 'Three real public-source components under an explicitly controlled fixture identity. Not a full Rainier or Enchantments pack. Actual PC producer, production browser validators, lazy file header check, independent system tar listing and damaged-source publication rejection.',
    plan, archive, ...result, names, damagedSourceRejected: true };
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, archiveBytes: result.archiveBytes, names, out }));
} finally { await validator.close(); }
