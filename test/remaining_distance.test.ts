import { expect, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { remainingAt } from '../src/gpx/Remaining.ts';

const track = GPXParser.parse(`<gpx><trk><name>R</name><trkseg>
<trkpt lat="47" lon="-121"><ele>100</ele><time>2026-07-01T08:00:00Z</time></trkpt>
<trkpt lat="47.01" lon="-121"><ele>200</ele><time>2026-07-01T09:00:00Z</time></trkpt>
<trkpt lat="47.02" lon="-121"><ele>300</ele><time>2026-07-01T10:00:00Z</time></trkpt></trkseg></trk></gpx>`, 'R');

it('reports the distance and recorded time still ahead', () => {
  expect(remainingAt(track, 0)).toEqual({ meters: track.totalDistance, seconds: 7200 });
  const half = remainingAt(track, 0.5);
  expect(half.meters).toBeCloseTo(track.totalDistance / 2);
  expect(half.seconds).toBeCloseTo(3600, -1);
  expect(remainingAt(track, 1)).toEqual({ meters: 0, seconds: 0 });
});
