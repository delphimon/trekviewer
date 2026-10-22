// Bounded real-source regression for the first Rainier export with tiny voids.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openOfflinePreparationValidator } from './offline-preparation-validator.mjs';
import { acquireOfflineSource } from './offline-pack-acquisition.mjs';
const sourceRoot = new URL('../src/', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
assert.ok(process.argv.slice(2).every(arg => arg === '--refresh'), 'Only --refresh is supported');
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { planOfflineRoute } = await import('../src/offline/OfflinePlan.ts');
const { offlineSourceAllowed } = await import('../src/offline/OfflineStore.ts');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve('.review-cache/offline-naip-gap'); fs.mkdirSync(root, { recursive: true });
const route = JSON.parse(fs.readFileSync('public/routes/manifest.json')).find(r => r.id === 'rainier-emmons');
const xml = fs.readFileSync('public' + route.file, 'utf8').replace(/\r\n?/g, '\n');
const plan = planOfflineRoute(GPXParser.parse(xml), route.id, sha(xml)), resource = plan.resources[1770];
assert.equal(resource.kind, 'image'); assert.equal(resource.width, 1024); assert.equal(resource.urls.length, 3);
assert.equal(new URL(resource.urls[0]).searchParams.get('bbox'), '-13553202.359301172,5920506.462856611,-13551979.36684861,5921729.455309175');
const reportFile = path.join(root, 'report.json');
const prior = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
const report = { condition: 'Three exact approved original PNG exports at one Rainier crop. Production coverage checks; not full-route coverage or a completed pack.',
  routeId: plan.routeId, planId: plan.id, index: 1770, resource, samples: [] };
const validator = await openOfflinePreparationValidator(path.join(root, 'validator'));
try {
  for (const [sourceIndex, url] of resource.urls.entries()) {
    assert.ok(offlineSourceAllowed(url));
    const file = `source-${sourceIndex}.png`, full = path.join(root, file), old = prior?.samples.find(s => s.url === url);
    let bytes, retained = false;
    if (!process.argv.includes('--refresh') && old && fs.existsSync(full) && fs.statSync(full).size <= 8 * 1024 * 1024) {
      bytes = fs.readFileSync(full); retained = bytes.length === old.bytes && sha(bytes) === old.sha256;
    }
    if (!retained) {
      bytes = await acquireOfflineSource(url, 8 * 1024 * 1024, undefined, { onRetry: retry => console.log(JSON.stringify({ sourceIndex, retry })) });
      fs.writeFileSync(full, bytes);
    }
    const sample = { sourceIndex, url, file, bytes: bytes.length, sha256: sha(bytes), retained, passed: false };
    try { await validator.validate(resource, bytes); sample.passed = true; }
    catch (error) { sample.error = error.message.split('\n')[0]; }
    report.samples.push(sample); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ sourceIndex, passed: sample.passed, retained, bytes: sample.bytes }));
  }
  assert.equal(report.samples[1].passed, true, 'Reviewed GeoPlatform export must provide complete original imagery at the regression crop');
} finally { await validator.close(); }
