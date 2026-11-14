import { expect, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';

// A trail running due north along a narrow ridge crest: centre 10 m above both ribbon edges.
const track = GPXParser.parse(`<gpx><trk><name>Ridge</name><trkseg>
<trkpt lat="47" lon="-121"><ele>100</ele></trkpt>
<trkpt lat="47.01" lon="-121"><ele>110</ele></trkpt>
<trkpt lat="47.02" lon="-121"><ele>100</ele></trkpt></trkseg></trk></gpx>`, 'Ridge');
const ridge = (crest: number) => (x: number) => Math.abs(x) < 0.2 ? crest : crest - 10;

function check(trail: ReturnType<typeof TrailMesh.create>, crestAboveEdges: number) {
  const geo = trail.trailMesh.geometry;
  const pos = geo.getAttribute('position'), center = geo.getAttribute('trailCenterY');
  expect(center).toBeDefined();
  for (const i of [0, 1, 10, 11, pos.count - 2, pos.count - 1]) {
    expect(Math.abs(center.getX(i) - pos.getY(i) - crestAboveEdges)).toBeLessThan(0.1);
  }
}

it('stores the draped centre-line height and rescales it with exaggeration', () => {
  const trail = TrailMesh.create(track, ridge(110), 0);
  check(trail, 10);
  trail.setVerticalExaggeration(2);
  check(trail, 20);
  trail.dispose();
});

it('re-drapes the centre height when terrain streams in, for both ribbons', () => {
  const trail = TrailMesh.create(track, ridge(110), 0);
  trail.reprojectToSurface!(ridge(150));
  check(trail, 10);
  const geo = trail.trailMesh.geometry;
  expect(geo.getAttribute('trailCenterY').getX(0)).toBeGreaterThan(150);
  trail.setViewMode('first-person');
  check(trail, 10);
  expect(trail.trailMesh.geometry.getAttribute('trailCenterY').getX(0)).toBeCloseTo(150.08, 2);
  trail.dispose();
});
