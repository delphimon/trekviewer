import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { GPXParser } from '../../src/gpx/GPXParser.ts';

const baseline = '412c9b3296c9462892ed547265e9f56331af5fa5';
const out = path.resolve(process.env.TREK_XML_OUT ?? '.review-cache/gpx-xml');
fs.mkdirSync(out, { recursive: true });
const previous = execFileSync('git', ['show', `${baseline}:src/gpx/GPXParser.ts`], { encoding: 'utf8', windowsHide: true })
  .replace(/from '(\.\/[^']+)'/g, (_, specifier) => `from '${pathToFileURL(path.resolve('src/gpx', specifier)).href}'`);
const oldFile = path.join(out, 'GPXParserBaseline.ts');
fs.writeFileSync(oldFile, previous);
const { GPXParser: OldParser } = await import(pathToFileURL(oldFile).href);
const results = [];
for (const file of fs.readdirSync('public/routes').filter(name => name.endsWith('.gpx')).sort()) {
  const xml = fs.readFileSync(path.join('public/routes', file), 'utf8');
  const oldTrack = OldParser.parse(xml), track = GPXParser.parse(xml);
  // Compare the entire finalized track, including coordinates, times, metrics,
  // warnings and derived landmarks; JSON omits irrelevant undefined keys.
  assert.deepEqual(JSON.parse(JSON.stringify(track)), JSON.parse(JSON.stringify(oldTrack)), file);
  results.push({ file, points: track.points.length, segments: track.segments.length,
    waypoints: track.waypoints.length, distanceMeters: track.totalDistance, exactFinalizedMatch: true });
}
fs.unlinkSync(oldFile);
fs.writeFileSync(path.join(out, 'curated-routes.json'), JSON.stringify({ baseline, results }, null, 2) + '\n');
console.log(JSON.stringify({ baseline, routes: results.length, points: results.reduce((sum, route) => sum + route.points, 0), exactFinalizedMatch: true }));
