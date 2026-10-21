import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as Lerc from 'lerc';
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { localMetersToGeo, geoToLocalMeters } = await import('../src/gpx/Coordinates.ts');
const { TextureBudget } = await import('../src/terrain/TextureBudget.ts');
const { planTerrainTiles } = await import('../src/terrain/TerrainTileLayout.ts');
const { elevationRasterRequest, paddedElevationFootprint, requiredElevationWindow } = await import('../src/terrain/BestAvailableElevation.ts');
const { ElevationTileService } = await import('../src/terrain/ElevationTiles.ts');
const { readBoundedBlob } = await import('../src/terrain/PersistentResourceCache.ts');
const out = process.env.TREK_FOOTPRINT_OUT ?? '.review-cache/terrain-footprint';
fs.mkdirSync(out, { recursive: true });
const routes = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8'));
const results = [], representatives = [];
let checkedAxes = 0;
for (const route of routes) {
  const track = GPXParser.parse(fs.readFileSync('public' + route.file, 'utf8'));
  const b = track.bounds, width = Math.max(1500, b.widthMeters * 1.5), depth = Math.max(1500, b.depthMeters * 1.5);
  for (const constrained of [true, false]) {
    const resolution = TextureBudget.getTerrainMeshResolution(width, depth, constrained, 60);
    const parent = { width, depth, segmentsX: resolution.segX, segmentsZ: resolution.segZ };
    const all = planTerrainTiles({ parent, focusX: 0, focusZ: 0, radiusM: Math.hypot(width, depth),
      parentCellsPerTile: 8, targetCellM: 5, maxTiles: 100000, maxVertices: 1e10 });
    let previousPixels = 0, currentPixels = 0, maxSpacingM = 0;
    const requests = new Map();
    for (const tile of all.tiles) {
      const bounds = tile.bounds, cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
      const center = localMetersToGeo(cx, cz, b.centerLat, b.centerLon);
      const nw = localMetersToGeo(bounds.minX, bounds.minZ, b.centerLat, b.centerLon), se = localMetersToGeo(bounds.maxX, bounds.maxZ, b.centerLat, b.centerLon);
      const required = { minLat: se.lat, maxLat: nw.lat, minLon: nw.lon, maxLon: se.lon };
      const radius = Math.max(tile.width, tile.depth) / 2 + 100;
      const oldNW = localMetersToGeo(-radius, -radius, center.lat, center.lon), oldSE = localMetersToGeo(radius, radius, center.lat, center.lon);
      const previous = elevationRasterRequest({ minLat: oldSE.lat, maxLat: oldNW.lat, minLon: oldNW.lon, maxLon: oldSE.lon }, 1);
      const current = elevationRasterRequest(paddedElevationFootprint(required), 1, 1024, true);
      assert.ok(current.sampleSpacingMeters <= 1.00000001, 'Bundled High exports must meet the 1 m requested sample spacing');
      const window = requiredElevationWindow(current, required), r = current.rasterBounds;
      // Coordinates are separable; check every stored Float32 column/row,
      // covering all combinations without constructing full large meshes.
      for (let i = 0; i <= tile.segmentsX; i++) {
        const point = localMetersToGeo(cx + Math.fround(i * (tile.width / tile.segmentsX) - tile.width / 2), cz, b.centerLat, b.centerLon);
        const gx = (point.lon * Math.PI * 6378137 / 180 - r.west) * (current.width - 1) / (r.east - r.west);
        assert.ok(Math.floor(gx) >= window.minX && Math.floor(gx) + 1 <= window.maxX && gx >= 0 && gx < current.width - 1); checkedAxes++;
      }
      for (let i = 0; i <= tile.segmentsZ; i++) {
        const point = localMetersToGeo(cx, cz + Math.fround(i * (tile.depth / tile.segmentsZ) - tile.depth / 2), b.centerLat, b.centerLon);
        const gy = (r.north - Math.asinh(Math.tan(point.lat * Math.PI / 180)) * 6378137) * (current.height - 1) / (r.north - r.south);
        assert.ok(Math.floor(gy) >= window.minY && Math.floor(gy) + 1 <= window.maxY && gy >= 0 && gy < current.height - 1); checkedAxes++;
      }
      previousPixels += previous.width * previous.height; currentPixels += current.width * current.height;
      maxSpacingM = Math.max(maxSpacingM, current.sampleSpacingMeters);
      requests.set(tile.id, { tile, previous, current, required });
    }
    results.push({ route: route.id, constrained, parent, tiles: all.tiles.length, previousPixels, currentPixels,
      decodedBytesSaved: (previousPixels - currentPixels) * 4, maxSpacingM });
    if (route.id === 'olympus-bailey-2026' && constrained) for (const fraction of [0, 0.5, 1]) {
      const point = track.points[Math.min(track.points.length - 1, Math.floor((track.points.length - 1) * fraction))];
      const local = geoToLocalMeters(point.lat, point.lon, 0, b.centerLat, b.centerLon);
      const tile = all.tiles.find(tile => local.x >= tile.bounds.minX && local.x <= tile.bounds.maxX && local.z >= tile.bounds.minZ && local.z <= tile.bounds.maxZ);
      representatives.push({ fraction, centerLat: b.centerLat, centerLon: b.centerLon, ...requests.get(tile.id) });
    }
  }
}
const total = key => results.reduce((sum, row) => sum + row[key], 0);
const report = { condition: 'Pure footprint/Float32 support audit across every tiled layout of all eight bundled routes, current High 60 m target with constrained/desktop vertex caps. Same layout/detail/target sampling and limits; no network or native frame claim.',
  checkedAxes, totalTiles: total('tiles'), previousPixels: total('previousPixels'), currentPixels: total('currentPixels'),
  pixelReductionPercent: 100 * (1 - total('currentPixels') / total('previousPixels')), results };
fs.writeFileSync(path.join(out, 'plans.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (process.env.TREK_FOOTPRINT_NETWORK !== '1') process.exit(0);
await Lerc.load({ locateFile: () => createRequire(import.meta.url).resolve('lerc/lerc-wasm.wasm') });
const pairs = [];
for (const sample of representatives) {
  const grids = {}, bytes = {}, errors = [], spacing = {};
  for (const name of ['previous', 'current']) {
    const request = sample[name], requestHash = createHash('sha256').update(request.url).digest('hex').slice(0, 12);
    const filename = path.join(out, `olympus-${sample.fraction}-${name}-${requestHash}.lerc`);
    if (!fs.existsSync(filename)) {
      const blob = await readBoundedBlob(await fetch(request.url, { signal: AbortSignal.timeout(35000) }), 32 * 1024 * 1024);
      fs.writeFileSync(filename, Buffer.from(await blob.arrayBuffer()));
    }
    const encoded = fs.readFileSync(filename), buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const info = Lerc.getBlobInfo(buffer), decoded = Lerc.decode(buffer);
    assert.equal(info.width, request.width); assert.equal(info.height, request.height); assert.equal(info.maxZerror, 0);
    const data = Float32Array.from(decoded.pixels[0], (value, i) => decoded.mask && !decoded.mask[i] ? NaN : value);
    grids[name] = { ...request, data, zoom: 0, numTilesX: 1, numTilesY: 1, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0, tileValidity: new Uint8Array([1]), isRealDEM: true };
    bytes[name] = encoded.length; spacing[name] = request.sampleSpacingMeters;
  }
  const { tile } = sample, cx = (tile.bounds.minX + tile.bounds.maxX) / 2, cz = (tile.bounds.minZ + tile.bounds.maxZ) / 2;
  for (let row = 0; row <= tile.segmentsZ; row++) for (let column = 0; column <= tile.segmentsX; column++) {
    const geo = localMetersToGeo(cx + Math.fround(column * (tile.width / tile.segmentsX) - tile.width / 2), cz + Math.fround(row * (tile.depth / tile.segmentsZ) - tile.depth / 2), sample.centerLat, sample.centerLon);
    const a = ElevationTileService.sampleElevation(grids.previous, geo.lat, geo.lon), b = ElevationTileService.sampleElevation(grids.current, geo.lat, geo.lon);
    assert.ok(a.isValid && b.isValid); errors.push(Math.abs(a.elevation - b.elevation));
  }
  errors.sort((a, b) => a - b);
  const row = { fraction: sample.fraction, id: tile.id, bytes, spacing, samples: errors.length,
    maxHeightDifferenceM: errors.at(-1), p95HeightDifferenceM: errors[Math.floor(errors.length * 0.95)],
    rmsHeightDifferenceM: Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length) };
  assert.ok(row.maxHeightDifferenceM < 2, 'Investigate source-grid phase change above 2 m before release');
  pairs.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(out, 'live-pairs.json'), JSON.stringify({ condition: 'Three sequential paired real USGS zero-loss exports around the same Olympus tile meshes. Request grid phase changes; compare every rendered vertex sample. Not exact height parity, native survey-resolution certification or loading/frame timing.', pairs }, null, 2) + '\n');
