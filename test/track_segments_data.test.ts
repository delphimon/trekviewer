import { describe, it } from 'vitest';
import assert from 'node:assert';
import { GPXParser } from '../src/gpx/GPXParser.ts';

describe('Multi-Segment GPX Track & Landmark Derivation', () => {
  it('parses multi-segment GPX files preserving segment boundaries', () => {
    const multiSegXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Multi-Day Traverse</name>
    <trkseg>
      <trkpt lat="46.8500" lon="-121.7500"><ele>1500</ele><time>2026-07-01T08:00:00Z</time></trkpt>
      <trkpt lat="46.8550" lon="-121.7520"><ele>1800</ele><time>2026-07-01T09:00:00Z</time></trkpt>
      <trkpt lat="46.8600" lon="-121.7550"><ele>2200</ele><time>2026-07-01T10:30:00Z</time></trkpt>
    </trkseg>
    <trkseg>
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
  });

  it('verifies factual landmark naming and 25m explicit waypoint merging', () => {
    const gpxWithExplicitSummit = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <wpt lat="46.8529" lon="-121.7604">
    <ele>4392.0</ele>
    <name>Columbia Crest Summit</name>
    <type>summit</type>
  </wpt>
  <trk>
    <name>Rainier Summit Push</name>
    <trkseg>
      <trkpt lat="46.8300" lon="-121.7300"><ele>1600.0</ele></trkpt>
      <trkpt lat="46.8400" lon="-121.7400"><ele>2800.0</ele></trkpt>
      <!-- Exactly at summit: 46.8529, -121.7604 -->
      <trkpt lat="46.8529" lon="-121.7604"><ele>4392.0</ele></trkpt>
      <trkpt lat="46.8500" lon="-121.7500"><ele>3200.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const track = GPXParser.parse(gpxWithExplicitSummit, 'Rainier');

    // Verify explicit waypoint exists
    assert.strictEqual(track.waypoints.length, 1);
    assert.strictEqual(track.waypoints[0].name, 'Columbia Crest Summit');

    // Verify derived landmarks:
    // Because explicit summit is within 25m of max elevation point,
    // NO redundant derived 'High Point' landmark should be created!
    const hasDuplicateHighPoint = track.landmarks.some((l) => l.name === 'High Point' || l.name.includes('Summit'));
    assert(!hasDuplicateHighPoint, 'Derived High Point must be merged with explicit summit waypoint within 25m');

    // Check Start and Finish factual names
    const startLandmark = track.landmarks.find((l) => l.type === 'start');
    assert(startLandmark, 'Must have Start landmark');
    assert.strictEqual(startLandmark.name, 'Start', 'Trailhead landmark must be factually named "Start"');

    const finishLandmark = track.landmarks.find((l) => l.type === 'finish');
    assert(finishLandmark, 'Must have Finish landmark');
    assert.strictEqual(finishLandmark.name, 'Finish', 'Finish landmark must be factually named "Finish"');
  });
});
