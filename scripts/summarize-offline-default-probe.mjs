// Local-only exact-byte compression audit. Does not alter the live renderer,
// browser storage format, source URLs or imagery/height precision.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import * as Lerc from 'lerc';
const require = createRequire(import.meta.url);
await Lerc.load({ locateFile: () => require.resolve('lerc/lerc-wasm.wasm') });
const root = path.resolve(process.env.TREK_OFFLINE_PROBE_OUT ?? '.review-cache/offline-real-defaults');
const input = fs.readFileSync(path.join(root, 'probe.json')), probe = JSON.parse(input);
assert.equal(probe.passed, true, 'Every selected real source must pass before sizing');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const route of probe.results) {
  const samples = [];
  for (const sample of route.samples) {
    const accepted = sample.attempts.find(attempt => attempt.passed);
    assert.ok(accepted);
    const bytes = fs.readFileSync(path.join(root, 'bodies', sha(accepted.url) + '.bin'));
    assert.equal(bytes.length, accepted.bytes); assert.equal(sha(bytes), accepted.sha256);
    let gzip, elevation;
    if (sample.resource.kind === 'elevation') {
      const decoded = Lerc.decode(bytes), header = Lerc.getBlobInfo(bytes);
      assert.equal(decoded.width, sample.resource.width); assert.equal(decoded.height, sample.resource.height);
      assert.equal(decoded.pixelType, 'F32'); assert.equal(header.maxZerror, 0);
      elevation = { pixelType: decoded.pixelType, width: decoded.width, height: decoded.height,
        validPixelCount: decoded.validPixelCount, maxZerror: header.maxZerror, minM: header.minValue, maxM: header.maxValue,
        rawFloat32Bytes: decoded.width * decoded.height * 4, originalEncodingOverheadBytes: bytes.length - decoded.width * decoded.height * 4,
        float32Sha256: sha(new Uint8Array(decoded.pixels[0].buffer, decoded.pixels[0].byteOffset, decoded.pixels[0].byteLength)) };
      const began = performance.now(), zipped = gzipSync(bytes, { level: 6 }), compressedMs = performance.now() - began;
      const decodeBegan = performance.now(), restored = gunzipSync(zipped, { maxOutputLength: bytes.length });
      const restoredMs = performance.now() - decodeBegan;
      assert.ok(restored.equals(bytes), 'Compression must preserve every original LERC byte');
      gzip = { bytes: zipped.length, sha256: sha(zipped), restoredSha256: sha(restored), compressedMs, restoredMs,
        savedFraction: 1 - zipped.length / bytes.length };
      fs.writeFileSync(path.join(root, 'bodies', sha(accepted.url) + '.lerc.gz'), zipped);
    }
    samples.push({ label: sample.label, resource: sample.resource, accepted, elevation, gzip });
  }
  const sum = (filter, value) => samples.filter(filter).reduce((n, s) => n + value(s), 0);
  results.push({ ...route, samples, sourceBytes: sum(() => true, s => s.accepted.bytes),
    terrainSourceBytes: sum(s => !!s.gzip, s => s.accepted.bytes), terrainGzipBytes: sum(s => !!s.gzip, s => s.gzip.bytes),
    imagerySourceBytes: sum(s => !s.gzip, s => s.accepted.bytes) });
}
const report = { ...probe, results, inputSha256: sha(input),
  compressionCondition: 'Node gzip level 6 for the eight real LERC samples. Decompression is bounded to each original byte length and every restored byte/SHA-256 matches. PNGs remain untouched. Timings are local preparation observations, not Quest read/decode performance. Gzip components are ignored local preparation artifacts, not ready renderer packs or a portable import format.',
  sizeCondition: 'Exactly sixteen selected sources, not representative proof of every source or the complete model. No extrapolation to a guaranteed archive size; existing full inventories and uncompressed budgets remain unchanged. Complete coverage, source-native baking, archive import and multi-GB/native acceptance remain open.' };
fs.writeFileSync(path.join(root, 'components.json'), JSON.stringify(report, null, 2) + '\n');
const mb = n => (n / 1e6).toFixed(2);
let markdown = `# Real default-route source and lossless component audit\n\nEight planned sources per route, validated with the production browser worker/Canvas code. ${probe.validatedBytes.toLocaleString('en-US')} bytes retained in the ignored local source cache. This is a bounded sample, not a complete route pack or a full-model native-resolution claim.\n\n`;
markdown += '| Route | Validated source total | DEM originals | Gzip DEM components | DEM reduction | Unchanged PNGs |\n|---|---:|---:|---:|---:|---:|\n';
for (const r of results) markdown += `| ${r.id} | ${mb(r.sourceBytes)} MB | ${mb(r.terrainSourceBytes)} MB | ${mb(r.terrainGzipBytes)} MB | ${(100 * (1 - r.terrainGzipBytes / r.terrainSourceBytes)).toFixed(1)}% | ${mb(r.imagerySourceBytes)} MB |\n`;
markdown += '\nAll selected imagery pixels are opaque. Both complete overview DEM rasters are valid, and all local DEM samples supporting their actual rendered footprints are valid. Local guard samples outside those footprints are not implied valid. Selected sources are the overview DEM, first/middle/last local DEM and Z16/17/18/19 imagery from the actual current full-model plans.\n\n';
markdown += 'The zero-tolerance LERC samples are effectively raw Float32 payloads. Node gzip level 6 reduces component-file sizes without changing source bytes: bounded decompression reproduces each original SHA-256 exactly. PNGs are kept unchanged. HTTP wire compression was not measured; this is not a claimed reduction versus current network transfer. The reduction is only 17–18% for these DEM components and says nothing about compressing the much larger full imagery inventory. This tests preparation components only; the current browser pack store still retains original LERC/PNG bodies and does not import gzip components. No full-pack size or headset speed improvement follows from these samples.\n\n';
markdown += '| Route overview DEM | Valid samples | Source elevation range |\n|---|---:|---:|\n';
for (const r of results) {
  const overview = r.samples.find(s => s.label === 'overview-dem').elevation;
  markdown += `| ${r.id} | ${overview.validPixelCount.toLocaleString('en-US')} | ${overview.minM.toFixed(1)}–${overview.maxM.toFixed(1)} m |\n`;
}
markdown += '\nEvery decoded DEM reports Float32 and zero LERC error tolerance. Source height ranges demonstrate relief in these requested rasters; they do not establish source-native survey spacing, fine mesh coverage, geographic accuracy against an independent survey or accepted headset appearance.\n\n';
markdown += 'Reproduce locally (network only in the first command; cached accepted bodies are reused):\n\n```powershell\n$env:TREK_OFFLINE_PROBE_COMMIT=(git rev-parse HEAD)\nnode --experimental-transform-types scripts/probe-offline-defaults.mjs\nnode scripts/summarize-offline-default-probe.mjs\n```\n\n';
markdown += 'The probe requests at most sixteen selected resources, one acquisition/validation lane, 35 seconds per approved public-source attempt and 32 MiB per DEM / 8 MiB per image. It never reads private provider configuration, publishes a ready pack or changes the installed application. The committed component report records source URLs, required windows, actual sizes, original/round-trip hashes and local timings. Complete source/native-resolution coverage, stable geographic indexing, portable streaming archives, full-route acquisition and installed/native acceptance remain unfinished.\n';
fs.writeFileSync(path.join(root, 'COMPONENTS.md'), markdown);
console.log(JSON.stringify({ validatedSources: results.reduce((n, r) => n + r.samples.length, 0),
  routes: results.map(r => ({ id: r.id, originalDemBytes: r.terrainSourceBytes, gzipDemBytes: r.terrainGzipBytes, imageryBytes: r.imagerySourceBytes })), out: root }));
