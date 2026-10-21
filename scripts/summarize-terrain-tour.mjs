import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [input, output] = process.argv.slice(2);
assert.ok(input && output, 'Usage: node scripts/summarize-terrain-tour.mjs input.json output.json');
const bytes = fs.readFileSync(input), report = JSON.parse(bytes);
const samples = report.detailSamples.filter(row => row.playing && row.following);
assert.equal(samples.length, report.detailSummary.samples);
const tiles = new Map(), stages = {}, jobs = {};
const tile = id => {
  if (!tiles.has(id)) tiles.set(id, { id, builds: 0, published: 0, removed: 0 });
  return tiles.get(id);
};
for (const row of samples) stages[row.hikerStage] = (stages[row.hikerStage] ?? 0) + 1;
for (const row of report.terrainJobAudit) {
  if (row.kind === 'chunk') { assert.equal(typeof row.tileId, 'string'); tile(row.tileId).builds++; }
  const group = jobs[row.kind] ??= { count: 0, postMs: 0, maxPostMs: 0, maxElapsedMs: 0,
    sourceBytes: 0, uncachedSourceBytes: 0, baseBytes: 0, uncachedBaseBytes: 0, gridBytes: 0 };
  group.count++; group.postMs += row.postMs;
  group.maxPostMs = Math.max(group.maxPostMs, row.postMs);
  group.maxElapsedMs = Math.max(group.maxElapsedMs, row.elapsedMs ?? 0);
  for (const key of ['sourceBytes', 'uncachedSourceBytes', 'baseBytes', 'uncachedBaseBytes', 'gridBytes']) group[key] += row[key] ?? 0;
}
for (const row of report.terrainLifecycle) tile(row.tileId)[row.method === 'attachLocalChunk' ? 'published' : 'removed']++;
const byTile = [...tiles.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const built = byTile.filter(row => row.builds), published = byTile.filter(row => row.published);
const total = key => byTile.reduce((sum, row) => sum + row[key], 0);
const summary = {
  condition: report.condition,
  evidence: 'Derived summary of the local raw report; tile IDs and counters are model data, not native headset performance.',
  inputReport: input.replaceAll('\\', '/'), inputSha256: createHash('sha256').update(bytes).digest('hex'),
  build: report.build, entry: report.entry, provider: report.provider, fullTour: report.fullTour,
  readyElapsedMs: report.readyElapsedMs ?? null, detail: report.detailSummary, stages,
  upcomingTilePlannedSamples: samples.some(row => 'upcomingTilePlanned' in row) ? samples.filter(row => row.upcomingTilePlanned).length : null,
  builds: { total: total('builds'), distinctTiles: built.length, repeats: total('builds') - built.length },
  publications: { total: total('published'), distinctTiles: published.length, repeats: total('published') - published.length, removals: total('removed') },
  elevationRequestEvents: report.elevationRequests, workers: report.workerLifecycle, jobs, byTile,
  comparisons: report.checkpoints.map(row => ({ label: row.label, elapsedMs: row.elapsedMs,
    legacyCalls: row.legacyCalls, batchedCalls: row.batchedCalls, mean: row.meanChannelError, rms: row.rmsChannelError,
    changedPixels: row.differentPixels, pixels: row.pixelCount, glErrors: row.glErrors,
    baseSource: row.counters.baseElevationSource, localSource: row.counters.localElevationSource,
    localExportSpacingM: row.counters.localElevationSampleSpacingM,
    baseMeshCellM: Math.max(row.counters.baseTerrainCellXM, row.counters.baseTerrainCellZM),
    localMeshCellM: Math.max(row.counters.visibleLocalCellXM, row.counters.visibleLocalCellZM),
    progress: row.counters.routeProgress, playing: row.counters.isPlaying,
    chunks: row.counters.localTerrainChunks, batch: row.batch })),
  markerComparison: report.markerComparison, profileSummary: report.playbackProfile.summary,
  errors: report.errors, glErrors: report.glErrors,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, builds: summary.builds, detail: summary.detail, stages }));
