import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { resolveRouteLandmarks } from '../src/gpx/RouteLandmarks.ts';
import { daySplits } from '../src/gpx/DaySplits.ts';

it('splits a two-day route at its day boundary and the parts add up', () => {
  const track = GPXParser.parse(readFileSync('public/routes/MountRainierViaEmmons.gpx', 'utf8'), 'Rainier');
  const splits = daySplits(track, resolveRouteLandmarks(track));
  expect(splits.length).toBeGreaterThanOrEqual(2);
  expect(splits[0].startProgress).toBe(0); expect(splits.at(-1)!.endProgress).toBe(1);
  const sum = (key: 'distanceMeters' | 'gainMeters' | 'lossMeters') => splits.reduce((n, s) => n + s[key], 0);
  expect(sum('distanceMeters')).toBeCloseTo(track.totalDistance, 0);
  expect(sum('gainMeters')).toBeGreaterThan(track.elevationGain * 0.9);
  expect(splits.every(s => s.seconds > 0)).toBe(true);
});

it('returns no splits for a single-day route', () => {
  const track = GPXParser.parse(`<gpx><trk><name>Day</name><trkseg>
<trkpt lat="47" lon="-121"><ele>100</ele></trkpt><trkpt lat="47.01" lon="-121"><ele>200</ele></trkpt></trkseg></trk></gpx>`, 'Day');
  expect(daySplits(track, resolveRouteLandmarks(track))).toEqual([]);
});
