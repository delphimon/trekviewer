import fs from 'node:fs';
import crypto from 'node:crypto';
const [input, output] = process.argv.slice(2);
const raw = fs.readFileSync(input), report = JSON.parse(raw);
const { plans, acquisitions } = report.terrainPlanAudit;
const percentile = (rows, fraction) => rows.length ? [...rows].sort((a, b) => a - b)[Math.min(rows.length - 1, Math.floor(rows.length * fraction))] : null;
const active = new Map(), intervals = [], seen = new Set();
let additions = 0, returns = 0;
for (const plan of plans) {
  const wanted = new Set(plan.wanted);
  for (const [id, start] of active) if (!wanted.has(id)) {
    intervals.push({ id, durationMs: plan.timeMs - start }); active.delete(id);
  }
  for (const id of wanted) if (!active.has(id)) {
    additions++; if (seen.has(id)) returns++; seen.add(id); active.set(id, plan.timeMs);
  }
}
const closedAcquisitions = acquisitions.filter(row => row.settledAtMs !== null);
const aborted = acquisitions.filter(row => row.abortedAtMs !== null);
const result = { input, inputSha256: crypto.createHash('sha256').update(raw).digest('hex'), build: report.build, entry: report.entry,
  condition: report.condition, detailSummary: report.detailSummary,
  plans: { count: plans.length, distinctTiles: seen.size, additions, returns, completedWantedIntervals: intervals.length,
    intervalsUnder250ms: intervals.filter(row => row.durationMs < 250).length,
    intervalsUnder1s: intervals.filter(row => row.durationMs < 1000).length,
    intervalsUnder5s: intervals.filter(row => row.durationMs < 5000).length,
    intervalMedianMs: percentile(intervals.map(row => row.durationMs), 0.5),
    minDesired: Math.min(...plans.map(row => row.wanted.length)), maxDesired: Math.max(...plans.map(row => row.wanted.length)) },
  acquisitions: { count: acquisitions.length, completed: closedAcquisitions.length,
    withGrid: closedAcquisitions.filter(row => row.hasGrid).length, aborted: aborted.length,
    abortedStillWanted: aborted.filter(row => row.wantedAtAbort).length,
    abortedAfterSettled: aborted.filter(row => row.settledAtAbort).length,
    abortMedianMs: percentile(aborted.map(row => row.abortedAtMs - row.startedAtMs), 0.5),
    completedMedianMs: percentile(closedAcquisitions.filter(row => row.hasGrid).map(row => row.settledAtMs - row.startedAtMs), 0.5) },
  workers: report.workerLifecycle, errors: report.errors, glErrors: report.glErrors };
if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
