// Live, bounded check of requested sample centres against the service's export
// footprint. Run with Node's --experimental-transform-types flag from repo root.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as Lerc from 'lerc';
import { elevationRasterRequest } from '../src/terrain/BestAvailableElevation.ts';

const out = path.resolve(process.env.TREK_DEM_AUDIT_OUT ?? '.review-cache/dem-registration');
fs.mkdirSync(out, { recursive: true });
const native = JSON.parse(fs.readFileSync('docs/review-2026-10-19/native-tabletop/terrain.json', 'utf8'));
const t = native.terrainBounds;
const latMargin = (t.maxLat - t.minLat) * .05, lonMargin = (t.maxLon - t.minLon) * .05;
const bounds = { minLat: t.minLat - latMargin, maxLat: t.maxLat + latMargin,
  minLon: t.minLon - lonMargin, maxLon: t.maxLon + lonMargin };
const request = elevationRasterRequest(bounds, 5);
const groundScale = Math.cos((bounds.minLat + bounds.maxLat) * Math.PI / 360);
const results = [];
for (const mode of ['previous-default', 'preserve-footprint']) {
  const url = new URL(request.url); url.searchParams.set('f', 'pjson');
  if (mode === 'previous-default') url.searchParams.delete('adjustAspectRatio');
  else assert.equal(url.searchParams.get('adjustAspectRatio'), 'false');
  const start = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `Export metadata HTTP ${response.status}`);
  const data = await response.json(); assert.ok(!data.error, JSON.stringify(data.error));
  assert.equal(data.width, request.width); assert.equal(data.height, request.height);
  assert.equal(data.extent.spatialReference.latestWkid ?? data.extent.spatialReference.wkid, 3857);
  const e = data.extent;
  const dx = (e.xmax - e.xmin) / data.width, dy = (e.ymax - e.ymin) / data.height;
  const actualCentres = { west: e.xmin + dx / 2, east: e.xmax - dx / 2,
    south: e.ymin + dy / 2, north: e.ymax - dy / 2 };
  const errorMercatorM = Object.fromEntries(Object.keys(actualCentres).map(axis => [axis, actualCentres[axis] - request.rasterBounds[axis]]));
  const maxErrorGroundM = Math.max(...Object.values(errorMercatorM).map(Math.abs)) * groundScale;
  results.push({ mode, url: url.href, retrieved: new Date().toISOString(), elapsedMs: performance.now() - start,
    width: data.width, height: data.height, extent: data.extent, actualCentres, errorMercatorM, maxErrorGroundM });
  if (mode === 'preserve-footprint') assert.ok(maxErrorGroundM < 1e-6, 'Export changed the advertised sample-centre footprint');
  console.log(JSON.stringify({ mode, maxErrorGroundM }));
}
assert.ok(results[0].maxErrorGroundM > 1, 'Negative control no longer reproduces; investigate before reusing its evidence');
const require = createRequire(import.meta.url);
await Lerc.load({ locateFile: () => require.resolve('lerc/lerc-wasm.wasm') });
const start = performance.now();
const response = await fetch(request.url, { signal: AbortSignal.timeout(20000) });
assert.ok(response.ok, `LERC HTTP ${response.status}`);
const bytes = await response.arrayBuffer(); assert.ok(bytes.byteLength <= 32 * 1024 * 1024);
const info = Lerc.getBlobInfo(bytes);
assert.equal(info.width, request.width); assert.equal(info.height, request.height);
assert.equal(info.maxZerror, 0); assert.equal(info.bandCount, 1);
const image = Lerc.decode(bytes);
assert.ok(image.pixels[0].every(value => Number.isFinite(value) && value >= -1000 && value <= 9000));
assert.ok(!image.mask || image.mask.every(Boolean));
fs.writeFileSync(path.join(out, 'olympus-corrected.lerc'), new Uint8Array(bytes));
const raster = { retrieved: new Date().toISOString(), url: request.url, bytes: bytes.byteLength,
  elapsedMs: performance.now() - start, width: info.width, height: info.height,
  maxZerror: info.maxZerror, min: info.minValue, max: info.maxValue };
fs.writeFileSync(path.join(out, 'registration.json'), JSON.stringify({ condition: 'Live USGS export metadata; coordinate registration, not terrain accuracy or native performance.',
  bounds, groundScale, request, results, raster }, null, 2) + '\n');
console.log(JSON.stringify({ raster }));
