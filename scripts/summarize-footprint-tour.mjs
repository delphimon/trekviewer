import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { elevationRasterRequest } = await import('../src/terrain/BestAvailableElevation.ts');
const { localMetersToGeo } = await import('../src/gpx/Coordinates.ts');
const [input, output] = process.argv.slice(2), bytes = fs.readFileSync(input), raw = JSON.parse(bytes);
let count = 0, previousPixels = 0, currentPixels = 0;
for (const job of raw.terrainJobAudit) {
  const f = job.footprint;
  if (job.kind !== 'chunk' || !f || !f.tileWidth || !f.tileDepth) continue;
  const radius = Math.max(f.tileWidth, f.tileDepth) / 2 + 100;
  const a = localMetersToGeo(-radius, -radius, f.centerLat, f.centerLon), b = localMetersToGeo(radius, radius, f.centerLat, f.centerLon);
  const previous = elevationRasterRequest({ minLat: b.lat, maxLat: a.lat, minLon: a.lon, maxLon: b.lon }, 1);
  assert.equal(job.gridBytes, f.width * f.height * 4);
  previousPixels += previous.width * previous.height; currentPixels += f.width * f.height; count++;
}
assert.ok(count > 0);
const report = { input, inputSha256: createHash('sha256').update(bytes).digest('hex'), build: raw.build, entry: raw.entry,
  condition: 'Actual native raster buffers sent to chunk jobs, compared with the legacy padded request for those same exact tile meshes. Equivalent bytes are calculated, not a second network/device run; excludes encoded transfers, GPU and frame timing.',
  count, previousPixels, currentPixels, equivalentPreviousBytes: previousPixels * 4, actualGridBytes: currentPixels * 4,
  reductionPercent: 100 * (1 - currentPixels / previousPixels) };
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
