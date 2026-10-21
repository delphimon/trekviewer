import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [directory, output] = process.argv.slice(2);
assert.ok(directory && output, 'Usage: node scripts/summarize-playback-cpu.mjs run-directory output.json');
const bytes = fs.readFileSync(path.join(directory, 'cpu-profile.json')), profile = JSON.parse(bytes);
const report = JSON.parse(fs.readFileSync(path.join(directory, 'browser.json'), 'utf8'));
assert.equal(report.provider, 'public-default');
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const maskNodes = new Set();
const pending = profile.nodes.filter(node => node.callFrame.functionName === 'getCellMask').map(node => node.id);
while (pending.length) {
  const id = pending.pop(); if (maskNodes.has(id)) continue;
  maskNodes.add(id); pending.push(...(nodes.get(id).children ?? []));
}
const names = new Map(); let totalUs = 0, maskInclusiveUs = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const name = nodes.get(profile.samples[i]).callFrame.functionName || '(anonymous)';
  const us = profile.timeDeltas[i]; totalUs += us;
  names.set(name, (names.get(name) ?? 0) + us);
  if (maskNodes.has(profile.samples[i])) maskInclusiveUs += us;
}
const result = { condition: 'Main-thread CDP CPU sampling during the first 15 seconds of normal desktop tour playback, before the first legacy/direct comparison. Function names aggregate all matching frames. Includes idle/browser/native samples; excludes worker CPU and native XR. Sampling overhead and service/phasing variation apply.',
  build: report.build, entry: report.entry, input: path.join(directory, 'cpu-profile.json').replaceAll('\\', '/'),
  inputSha256: createHash('sha256').update(bytes).digest('hex'), samples: profile.samples.length, totalMs: totalUs / 1000,
  maskInclusiveMs: maskInclusiveUs / 1000,
  pickingMask: ['getCellMask', 'retainedTerrainCellMask', 'publishTerrainCellMask'].map(name => ({ name, selfMs: (names.get(name) ?? 0) / 1000 })),
  topSelf: [...names].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([name, us]) => ({ name, selfMs: us / 1000, samplePercent: 100 * us / totalUs })) };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, build: result.build.id, maskInclusiveMs: result.maskInclusiveMs, pickingMask: result.pickingMask }));
