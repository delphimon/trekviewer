// Inventory only by default. Optional bounded probe: TREK_PACK_SAMPLE=1.
// No pack download, application setting, source cache or private token is touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json')) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')))};` };
  return nextLoad(url, context);
} });
const { GPXParser } = await import('../src/gpx/GPXParser.ts');
const { localMetersToGeo, geoToLocalMeters } = await import('../src/gpx/Coordinates.ts');
const { TextureBudget } = await import('../src/terrain/TextureBudget.ts');
const { planTerrainTiles } = await import('../src/terrain/TerrainTileLayout.ts');
const { elevationRasterRequest, paddedElevationFootprint } = await import('../src/terrain/BestAvailableElevation.ts');
const { PublicImageryProvider, tileMercatorBounds } = await import('../src/terrain/providers/PublicImageryProvider.ts');
const { readBoundedBlob } = await import('../src/terrain/PersistentResourceCache.ts');
const out = process.env.TREK_PACK_ESTIMATE_OUT ?? '.review-cache/offline-packs';
fs.mkdirSync(out, { recursive: true });
const corridorM = 1000, routes = JSON.parse(fs.readFileSync('public/routes/manifest.json', 'utf8'));
const provider = new PublicImageryProvider(), results = [], allFullImages = new Set(), allCorridorImages = new Set();
const probeJobs = [];
const pointBoxDistance2 = (p, b) => Math.max(b.minX - p.x, 0, p.x - b.maxX) ** 2 + Math.max(b.minZ - p.z, 0, p.z - b.maxZ) ** 2;
function pointSegmentDistance2(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return (p.x - a.x - t * dx) ** 2 + (p.z - a.z - t * dz) ** 2;
}
function segmentBoxDistance2(a, b, box) {
  // Slab test detects intersections, including segments with both endpoints outside.
  let start = 0, end = 1;
  for (const [axis, min, max] of [['x', box.minX, box.maxX], ['z', box.minZ, box.maxZ]]) {
    const d = b[axis] - a[axis];
    if (!d) { if (a[axis] < min || a[axis] > max) { start = 2; break; } }
    else { const u = (min - a[axis]) / d, v = (max - a[axis]) / d; start = Math.max(start, Math.min(u, v)); end = Math.min(end, Math.max(u, v)); }
  }
  if (start <= end) return 0;
  return Math.min(pointBoxDistance2(a, box), pointBoxDistance2(b, box),
    ...[box.minX, box.maxX].flatMap(x => [box.minZ, box.maxZ].map(z => pointSegmentDistance2({ x, z }, a, b))));
}
// Sanity-check the counting geometry rather than trusting point-disc sampling.
assert.equal(segmentBoxDistance2({ x: -5, z: 0 }, { x: 5, z: 0 }, { minX: -1, maxX: 1, minZ: -1, maxZ: 1 }), 0);
assert.equal(segmentBoxDistance2({ x: 2, z: 3 }, { x: 4, z: 3 }, { minX: -1, maxX: 1, minZ: -1, maxZ: 1 }), 5);
function tileXY(lat, lon, zoom) {
  const n = 2 ** zoom;
  return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n) };
}
function tileGeoBox(zoom, x, y, reference) {
  const [w, s, e, n] = tileMercatorBounds(zoom, x, y);
  const nw = geoToLocalMeters(Math.atan(Math.sinh(n / 6378137)) * 180 / Math.PI, w / 6378137 * 180 / Math.PI, 0, reference.centerLat, reference.centerLon);
  const se = geoToLocalMeters(Math.atan(Math.sinh(s / 6378137)) * 180 / Math.PI, e / 6378137 * 180 / Math.PI, 0, reference.centerLat, reference.centerLon);
  return { minX: nw.x, maxX: se.x, minZ: nw.z, maxZ: se.z };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const route of routes) {
  const gpx = fs.readFileSync('public' + route.file), track = GPXParser.parse(gpx.toString()), b = track.bounds;
  const width = Math.max(1500, b.widthMeters * 1.5), depth = Math.max(1500, b.depthMeters * 1.5);
  const nw = localMetersToGeo(-width / 2, -depth / 2, b.centerLat, b.centerLon), se = localMetersToGeo(width / 2, depth / 2, b.centerLat, b.centerLon);
  const localSegments = track.segments.flatMap(segment => {
    const points = segment.points.map(p => geoToLocalMeters(p.lat, p.lon, 0, b.centerLat, b.centerLon));
    return points.slice(1).map((p, i) => [points[i], p]);
  });
  const intersectsCorridor = box => localSegments.some(([a, c]) => {
    if (Math.max(a.x, c.x) + corridorM < box.minX || Math.min(a.x, c.x) - corridorM > box.maxX ||
      Math.max(a.z, c.z) + corridorM < box.minZ || Math.min(a.z, c.z) - corridorM > box.maxZ) return false;
    return segmentBoxDistance2(a, c, box) <= corridorM ** 2;
  });
  const imagery = [];
  for (let zoom = 13; zoom <= 19; zoom++) {
    const groupZoom = zoom >= 17 ? zoom - 2 : zoom, imageSide = zoom >= 17 ? 1024 : 256;
    const first = tileXY(nw.lat, nw.lon, groupZoom), last = tileXY(se.lat, se.lon, groupZoom);
    let full = 0, corridor = 0;
    for (let y = first.y; y <= last.y; y++) for (let x = first.x; x <= last.x; x++) {
      const key = `${zoom}:${x}:${y}`; full++; allFullImages.add(key);
      if (zoom <= 16 || intersectsCorridor(tileGeoBox(groupZoom, x, y, b))) { corridor++; allCorridorImages.add(key); }
    }
    assert.ok(corridor <= full);
    imagery.push({ zoom, groupZoom, imageSide, fullImages: full, corridorImages: corridor });
  }
  const resolution = TextureBudget.getTerrainMeshResolution(width, depth, true, 60);
  const parent = { width, depth, segmentsX: resolution.segX, segmentsZ: resolution.segZ };
  const tiles = planTerrainTiles({ parent, focusX: 0, focusZ: 0, radiusM: Math.hypot(width, depth), parentCellsPerTile: 8,
    targetCellM: 5, maxTiles: 100000, maxVertices: 1e10 }).tiles;
  const full = { tiles: 0, sourceFloat32Bytes: 0, preparedGeometryBytes: 0 }, corridor = { ...full };
  for (const tile of tiles) {
    const a = localMetersToGeo(tile.bounds.minX, tile.bounds.minZ, b.centerLat, b.centerLon), c = localMetersToGeo(tile.bounds.maxX, tile.bounds.maxZ, b.centerLat, b.centerLon);
    const request = elevationRasterRequest(paddedElevationFootprint({ minLat: c.lat, maxLat: a.lat, minLon: a.lon, maxLon: c.lon }), 1, 1024, true);
    assert.ok(request.sampleSpacingMeters <= 1.00000001);
    // Same typed arrays as TerrainChunkData; metadata and small base grid excluded.
    const geometry = tile.vertexCount * 36 + tile.segmentsX * tile.segmentsZ * 6 * (tile.vertexCount > 65535 ? 4 : 2);
    for (const scope of intersectsCorridor(tile.bounds) ? [full, corridor] : [full]) {
      scope.tiles++; scope.sourceFloat32Bytes += request.width * request.height * 4; scope.preparedGeometryBytes += geometry;
    }
  }
  const record = { id: route.id, name: route.name, gpxBytes: gpx.length, gpxSha256: sha(gpx),
    distanceKm: track.totalDistance / 1000, modelWidthKm: width / 1000, modelDepthKm: depth / 1000,
    terrain: { parent, full, corridor }, imagery, samples: [] };
  results.push(record);
  if (process.env.TREK_PACK_SAMPLE === '1') {
    // Exactly three candidate images/route, one at each fine level and track index fraction.
    // Bounded 8 MiB/body; URL-hashed results are reused. No private source is loaded.
    for (const [zoom, fraction] of [[17, 0], [18, 0.5], [19, 1]]) {
      probeJobs.push(async () => {
      const point = track.points[Math.round((track.points.length - 1) * fraction)], xy = tileXY(point.lat, point.lon, zoom);
      let selected;
      for (const url of provider.getTileUrls(zoom, xy.x, xy.y)) {
        const filename = path.join(out, sha(url) + '.png');
        try {
          if (!fs.existsSync(filename)) {
            const response = await fetch(url, { signal: AbortSignal.timeout(35000) });
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const blob = await readBoundedBlob(response, 8 * 1024 * 1024);
            fs.writeFileSync(filename, Buffer.from(await blob.arrayBuffer()));
          }
          const image = fs.readFileSync(filename);
          assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          assert.equal(image.readUInt32BE(16), 1024); assert.equal(image.readUInt32BE(20), 1024);
          // PNG alpha/blank validation is performed separately in the browser before estimation.
          selected = { zoom, fraction, url, file: filename.replaceAll('\\', '/'), bytes: image.length, sha256: sha(image) };
          break;
        } catch (error) { console.error(`${route.id} Z${zoom} sample: ${error.message}`); }
      }
      if (selected) { record.samples.push(selected); console.error(`${route.id} Z${zoom}: ${selected.bytes} encoded bytes`); }
      });
    }
  }
  console.error(`Inventoried ${route.id}`);
}
// Two bounded network lanes. Keep catalogue/counting deterministic and avoid
// serial export latency without flooding the shared public service.
let nextProbe = 0;
await Promise.all([0, 1].map(async () => { while (nextProbe < probeJobs.length) await probeJobs[nextProbe++](); }));
for (const route of results) route.samples.sort((a, b) => a.zoom - b.zoom);
const report = { generatedAt: new Date().toISOString(), scope: 'All eight bundled GPX routes; complete model = max(1.5 x track bounds, 1500 m). Corridor = all full-model Z13-16 imagery, Z17-19 image groups and High terrain tiles intersecting a 1000 m buffer around each actual GPX segment, clipped to the model. No bridging GPX segment gaps.',
  units: 'bytes (decimal GB = 1e9 bytes)', corridorHalfWidthM: corridorM, maxZoom: 19,
  imageryMethod: 'Count unique source rasters (1024 px for Z17-19, 256 px for Z13-16), preserving all seven stored LOD levels. No duplicate storage of 16 crops of the same fine source image. No compression estimate until all sample images pass browser alpha/nonblank validation. Requested zoom does not certify native source resolution.',
  terrainMethod: 'One-metre requested Float32 source sample inventory of exact High Quest tile bounds plus 4 m guards, endpoint-inclusive. Proposed offline baking layout only; production network request identities unchanged. Raw budget, not measured LERC download size or a universal native 1 m survey claim. Prepared geometry = actual current <=5 m tile typed arrays; optional, uncompressed, single Quest profile. All source grids cannot be loaded in memory at once.',
  exclusions: 'Optional label/topographic layers, source masks, full pack manifest/index, filesystem overhead, staging copies, app shell/APK overhead, future finer meshes and desktop geometry variants. Estimate source rights and complete NoData coverage still require a pack audit.',
  crossRouteImageCounts: { full: allFullImages.size, corridor: allCorridorImages.size }, results };
fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ routes: results.length, images: report.crossRouteImageCounts, sourceFloat32GB: results.reduce((s, r) => s + r.terrain.full.sourceFloat32Bytes, 0) / 1e9 }));
