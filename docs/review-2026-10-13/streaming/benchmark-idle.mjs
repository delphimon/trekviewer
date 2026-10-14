import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
// Vite accepts these project JSON imports without native Node import attributes.
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${fs.readFileSync(new URL(url), 'utf8')};`, shortCircuit: true };
  return nextLoad(url, context);
} });
let old = stripTypeScriptTypes(fs.readFileSync(new URL('./TiledTerrainStreamer-before.ts', import.meta.url), 'utf8'), { mode: 'transform' });
old = old.replace(/from '([^']+)'/g, (_, specifier) => {
  const file = specifier === 'three' ? 'node_modules/three/build/three.module.js' : path.resolve('src/terrain', specifier);
  return `from '${pathToFileURL(path.resolve(file)).href}'`;
});
const { TiledTerrainStreamer: Previous } = await import('data:text/javascript;base64,' + Buffer.from(old).toString('base64'));
const { TiledTerrainStreamer: Current } = await import(pathToFileURL(path.resolve('src/terrain/TiledTerrainStreamer.ts')));
const { GPXParser } = await import(pathToFileURL(path.resolve('src/gpx/GPXParser.ts')));
const { RouteGeometry } = await import(pathToFileURL(path.resolve('src/visualization/RouteGeometry.ts')));
const { QUALITY_PROFILES } = await import(pathToFileURL(path.resolve('src/terrain/QualityProfile.ts')));
const { planTerrainTiles } = await import(pathToFileURL(path.resolve('src/terrain/TerrainTileLayout.ts')));
const { geoToLocalMeters } = await import(pathToFileURL(path.resolve('src/gpx/Coordinates.ts')));
const out = path.resolve('.review-cache/streaming'); fs.mkdirSync(out, { recursive: true });
const stats = samples => { samples.sort((a,b) => a-b); return { medianMsPerUpdate: samples[Math.floor(samples.length * .5)], p95MsPerUpdate: samples[Math.floor(samples.length * .95)], samples: samples.length }; };
const results = [];
for (const file of ['MountRainierViaEmmons.gpx', 'GlacierPeakTraverse2026.gpx']) {
  const track = GPXParser.parse(fs.readFileSync(path.join('public/routes', file), 'utf8'));
  const route = new RouteGeometry(track, 0, () => 0), point = route.getTelemetryAtProgress(.4).currentPoint;
  const parent = { width: Math.max(1000, track.bounds.widthMeters), depth: Math.max(1000, track.bounds.depthMeters), segmentsX: 160, segmentsZ: 160 };
  const local = geoToLocalMeters(point.lat, point.lon, 0, track.bounds.centerLat, track.bounds.centerLon, 0);
  const plan = planTerrainTiles({ parent, focusX: local.x, focusZ: local.z, radiusM: 3500, parentCellsPerTile: 8, targetCellM: 10, maxTiles: 24, maxVertices: 160000 });
  const setup = Constructor => {
    const counts = { probes: 0, telemetry: 0 };
    const streamer = new Constructor({ terrainResult: { baseMeshGrid: parent, terrainGeoBounds: track.bounds }, routeGeometry: { getTelemetryAtProgress: progress => { counts.telemetry++; return route.getTelemetryAtProgress(progress); } }, demGrid: {}, qualityProfile: QUALITY_PROFILES['desktop-high'] });
    streamer.wanted = new Map(plan.tiles.map(t => [t.id, t]));
    streamer.chunks = new Map(plan.tiles.map(t => [t.id, { mesh: { visible: true } }]));
    streamer.plannedAt = { x: local.x, z: local.z }; streamer.planKey = plan.tiles.map(t => t.id).sort().join('|');
    const prepare = streamer.prepareNext; streamer.prepareNext = function(...args) { counts.probes++; return prepare.apply(this, args); };
    streamer.update(.4); counts.probes = counts.telemetry = 0;
    return { streamer, counts };
  };
  const previous = setup(Previous), current = setup(Current), before = [], after = [];
  for (let sample = 0; sample < 240; sample++) {
    let start = performance.now(); for (let frame = 0; frame < 72; frame++) previous.streamer.update(.4); const oldMs = (performance.now() - start) / 72;
    start = performance.now(); for (let frame = 0; frame < 72; frame++) current.streamer.update(.4); const newMs = (performance.now() - start) / 72;
    if (sample >= 40) { before.push(oldMs); after.push(newMs); }
    await Promise.resolve();
  }
  assert.equal(current.counts.probes, 0); assert.equal(current.counts.telemetry, 0);
  assert.deepEqual([...current.streamer.chunks.keys()], [...previous.streamer.chunks.keys()]);
  results.push({ fixture: file, residentTiles: plan.tiles.length, updatesPerSample: 72, warmupSamples: 40, previous: stats(before), current: stats(after), totalCountersIncludingWarmup: { previous: previous.counts, current: current.counts }, sameResidentTileKeys: true });
}
fs.writeFileSync(path.join(out, 'idle-benchmark.json'), JSON.stringify({ runtime: process.version, fixture: 'paused production route telemetry, all planned chunks resident as inert placeholders; no network/rendering', results }, null, 2)); console.log(JSON.stringify(results));
