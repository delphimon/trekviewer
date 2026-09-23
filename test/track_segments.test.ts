import assert from 'node:assert';
import { describe, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';

describe('Multi-Segment GPX Track Support (<trkseg>)', () => {
  it('evaluates multi-segment parsing, gap isolation, and trail ribbon generation', () => {
    // Multi-segment GPX with two separate segments (e.g. Day 1 and Day 2 separated by a night or gap)
    const multiSegXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Multi-Day Traverse</name>
    <trkseg>
      <!-- Segment 1: Trailhead to High Camp -->
      <trkpt lat="46.8500" lon="-121.7500"><ele>1500</ele><time>2026-07-01T08:00:00Z</time></trkpt>
      <trkpt lat="46.8550" lon="-121.7520"><ele>1800</ele><time>2026-07-01T09:00:00Z</time></trkpt>
      <trkpt lat="46.8600" lon="-121.7550"><ele>2200</ele><time>2026-07-01T10:30:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <!-- Segment 2: High Camp to Summit (Starts 10 hours later, discontinuous in time and space) -->
      <trkpt lat="46.8605" lon="-121.7555"><ele>2210</ele><time>2026-07-01T20:30:00Z</time></trkpt>
      <trkpt lat="46.8650" lon="-121.7600"><ele>3200</ele><time>2026-07-01T23:00:00Z</time></trkpt>
      <trkpt lat="46.8700" lon="-121.7650"><ele>4392</ele><time>2026-07-02T02:00:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const track = GPXParser.parse(multiSegXml, 'Multi-Day Traverse');

    // 1. Verify segments parsed
    assert.strictEqual(track.segments.length, 2, 'Should parse exactly 2 track segments');
    assert.strictEqual(track.points.length, 6, 'Total points across all segments should be 6');

    const seg1 = track.segments[0];
    const seg2 = track.segments[1];

    assert.strictEqual(seg1.points.length, 3);
    assert.strictEqual(seg2.points.length, 3);
    assert.strictEqual(seg1.startIndex, 0);
    assert.strictEqual(seg1.endIndex, 2);
    assert.strictEqual(seg2.startIndex, 3);
    assert.strictEqual(seg2.endIndex, 5);

    // 2. Verify segmentIndex on points
    assert.strictEqual(track.points[0].segmentIndex, 0);
    assert.strictEqual(track.points[1].segmentIndex, 0);
    assert.strictEqual(track.points[2].segmentIndex, 0);
    assert.strictEqual(track.points[3].segmentIndex, 1);
    assert.strictEqual(track.points[4].segmentIndex, 1);
    assert.strictEqual(track.points[5].segmentIndex, 1);

    // 3. Segment Distances & Elevation Stats
    assert(seg1.distance > 0, 'Segment 1 distance must be > 0');
    assert(seg2.distance > 0, 'Segment 2 distance must be > 0');
    assert(seg1.elevationGain > 0, 'Segment 1 elevation gain must be > 0');
    assert(seg2.elevationGain > 0, 'Segment 2 elevation gain must be > 0');

    const sumDist = seg1.distance + seg2.distance;
    assert(Math.abs(track.totalDistance - sumDist) < 1.0, 'Total distance must equal sum of segment distances without phantom gap jump');

    console.log(`✓ Parsed 2 segments: Seg1=${seg1.distance.toFixed(0)}m, Seg2=${seg2.distance.toFixed(0)}m, Total=${track.totalDistance.toFixed(0)}m`);

    // 4. RouteGeometry & TrailMesh Multi-Segment Construction
    const dummySampler = (_x: number, _z: number) => 0;
    const trailResult = TrailMesh.create(track, dummySampler);

    assert(trailResult.routeGeometry.segments.length === 2, 'RouteGeometry should retain 2 distinct segments');
    assert(trailResult.group.children.length > 0, 'TrailMesh group should contain ribbon mesh');

    // Verify that the ribbon geometry has vertices without NaN/crashes
    const ribbonMesh = trailResult.trailMesh;
    assert(ribbonMesh, 'Trail mesh must exist');
    const posAttr = ribbonMesh.geometry.getAttribute('position');
    assert(posAttr && posAttr.count > 0, 'Ribbon geometry position attribute must have vertices');

    for (let i = 0; i < posAttr.count; i++) {
      assert(!isNaN(posAttr.getX(i)), `Vertex ${i} X must not be NaN`);
      assert(!isNaN(posAttr.getY(i)), `Vertex ${i} Y must not be NaN`);
      assert(!isNaN(posAttr.getZ(i)), `Vertex ${i} Z must not be NaN`);
    }

    trailResult.dispose();
    console.log('✓ Multi-segment trail ribbon constructed and disposed without phantom bridges');
    console.log('✓ All Track Segment tests passed successfully!');
  });
});
