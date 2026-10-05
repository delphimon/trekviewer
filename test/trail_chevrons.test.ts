import { describe, expect, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';

const track = GPXParser.parse(`<gpx><trk><name>Direction test</name>
<trkseg><trkpt lat="47" lon="-121"><ele>100</ele></trkpt>
<trkpt lat="47" lon="-120.99"><ele>100</ele></trkpt></trkseg>
<trkseg><trkpt lat="47.01" lon="-120.99"><ele>100</ele></trkpt>
<trkpt lat="47.01" lon="-121"><ele>100</ele></trkpt></trkseg>
</trk></gpx>`, 'Direction test');

describe('directional trail chevrons', () => {
  it('advances in travel order on eastbound and westbound segments without connecting gaps', () => {
    const trail = TrailMesh.create(track, () => 10);
    const geo = trail.trailMesh.geometry;
    const coord = geo.getAttribute('trailCoord');
    const position = geo.getAttribute('position');
    const indices = geo.index!;
    const directions = new Set<number>();
    for (let i = 0; i < indices.count; i += 6) {
      const a = indices.getX(i);
      const b = indices.getX(i + 2);
      expect(coord.getY(b)).toBeGreaterThan(coord.getY(a));
      expect(coord.getX(a)).toBe(-1);
      expect(coord.getX(a + 1)).toBe(1);
      directions.add(Math.sign(position.getX(b) - position.getX(a)));
    }
    expect(directions.has(1)).toBe(true);
    expect(directions.has(-1)).toBe(true);
    const starts = Array.from({ length: coord.count / 2 }, (_, i) => coord.getY(i * 2))
      .filter(distance => distance === 0);
    expect(starts).toHaveLength(2);
    trail.dispose();
  });

  it('retains directional coordinates through color, view, and terrain changes', () => {
    const trail = TrailMesh.create(track, () => 10);
    const tabletop = trail.trailMesh.geometry;
    const coordinates = Array.from(tabletop.getAttribute('trailCoord').array);
    trail.setColorMode('grade');
    trail.setVerticalExaggeration(2);
    trail.reprojectToSurface!(() => 30);
    expect(Array.from(tabletop.getAttribute('trailCoord').array)).toEqual(coordinates);
    expect(tabletop.getAttribute('position').getY(0)).toBeGreaterThanOrEqual(60);
    trail.setViewMode('first-person');
    expect(Array.from(trail.trailMesh.geometry.getAttribute('trailCoord').array)).toEqual(coordinates);
    expect(trail.trailMesh.geometry.getAttribute('position').getY(0)).toBeCloseTo(30.08);
    expect(trail.trailMesh.geometry.index!.count).toBe(tabletop.index!.count);
    trail.dispose();
  });
});
