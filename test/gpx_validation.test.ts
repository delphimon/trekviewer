import assert from 'node:assert';
import { describe, it } from 'vitest';
import { GPXValidator, type RawTrackPoint } from '../src/gpx/GPXValidator.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';

describe('GPX Validation & Glitch Filtering', () => {
  it('validates GPS tracks, filters glitches, and handles non-monotonic timestamps', () => {
    // 1. Empty and Single-Point Tracks
    const emptyResult = GPXValidator.validate([]);
    assert.strictEqual(emptyResult.isValid, false);
    assert(emptyResult.fatalError?.includes('No GPS track points'));

    const singleResult = GPXValidator.validate([
      { lat: 46.85, lon: -121.75, ele: 1500 }
    ]);
    assert.strictEqual(singleResult.isValid, false);
    assert(singleResult.fatalError?.includes('only 1 GPS point'));

    // 2. Latitude & Longitude Bounds Filtering (-90..90, -180..180, NaN)
    const invalidCoordPoints: RawTrackPoint[] = [
      { lat: 46.850, lon: -121.750, ele: 1000 },
      { lat: 95.000, lon: -121.751, ele: 1050 }, // Lat > 90 out of bounds
      { lat: 46.852, lon: 195.000, ele: 1100 },  // Lon > 180 out of bounds
      { lat: NaN, lon: -121.753, ele: 1150 },    // NaN latitude
      { lat: 46.854, lon: NaN, ele: 1200 },      // NaN longitude
      { lat: 46.855, lon: -121.755, ele: 1250 }, // Valid point
    ];

    const coordResult = GPXValidator.validate(invalidCoordPoints);
    assert.strictEqual(coordResult.isValid, true);
    assert.strictEqual(coordResult.sanitizedPoints.length, 2, 'Should filter out 4 invalid points');
    assert(coordResult.warnings.some(w => w.includes('out-of-range') || w.includes('NaN')));

    // 3. Extreme / Non-Finite Elevation Filtering
    const extremeElePoints: RawTrackPoint[] = [
      { lat: 46.850, lon: -121.750, ele: 1000 },
      { lat: 46.851, lon: -121.751, ele: 25000 }, // > 9000m (Mt Everest is 8848m)
      { lat: 46.852, lon: -121.752, ele: -1000 }, // < -500m (Dead Sea is -430m)
      { lat: 46.853, lon: -121.753, ele: Infinity },
      { lat: 46.854, lon: -121.754, ele: 1500 },
    ];

    const eleResult = GPXValidator.validate(extremeElePoints);
    assert.strictEqual(eleResult.isValid, true);
    assert.strictEqual(eleResult.sanitizedPoints.length, 5);
    // Outlier elevations should be cleared to undefined so interpolation can reconstruct them
    assert.strictEqual(eleResult.sanitizedPoints[1].ele, undefined);
    assert.strictEqual(eleResult.sanitizedPoints[2].ele, undefined);
    assert.strictEqual(eleResult.sanitizedPoints[3].ele, undefined);
    assert(eleResult.warnings.some(w => w.includes('outlier')));

    // 4. Telemetry Coordinate Glitch (>50km jump to Null Island or another continent)
    const glitchPoints: RawTrackPoint[] = [
      { lat: 46.850, lon: -121.750, ele: 1000 },
      { lat: 46.851, lon: -121.751, ele: 1050 },
      { lat: 0.000, lon: 0.000, ele: 0 },         // Sudden 10,000km glitch jump to Null Island!
      { lat: 46.853, lon: -121.753, ele: 1100 },
      { lat: 46.854, lon: -121.754, ele: 1150 },
    ];

    const glitchResult = GPXValidator.validate(glitchPoints);
    assert.strictEqual(glitchResult.isValid, true);
    assert.strictEqual(glitchResult.sanitizedPoints.length, 4, 'Glitch jump point should be omitted');
    assert(glitchResult.warnings.some(w => w.includes('jump')));

    // 5. Non-monotonic Timestamps
    const timePoints: RawTrackPoint[] = [
      { lat: 46.850, lon: -121.750, ele: 1000, time: new Date('2026-07-01T10:00:00Z') },
      { lat: 46.851, lon: -121.751, ele: 1050, time: new Date('2026-07-01T09:00:00Z') }, // Time traveled backward
      { lat: 46.852, lon: -121.752, ele: 1100, time: new Date('2026-07-01T11:00:00Z') },
    ];

    const timeResult = GPXValidator.validate(timePoints);
    assert.strictEqual(timeResult.isValid, true);
    assert(timeResult.warnings.some(w => w.includes('non-monotonic')));

    // 6. Complete End-to-End GPXParser integration with invalid coordinates
    const mixedGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Mixed Quality Track</name>
    <trkseg>
      <trkpt lat="46.850" lon="-121.750"><ele>1000</ele></trkpt>
      <trkpt lat="150.00" lon="-121.751"><ele>1200</ele></trkpt> <!-- Invalid lat -->
      <trkpt lat="46.852" lon="-121.752"><ele>25000</ele></trkpt> <!-- Extreme ele -->
      <trkpt lat="46.854" lon="-121.754"><ele>1400</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const mixedTrack = GPXParser.parse(mixedGpx, 'Mixed');
    assert.strictEqual(mixedTrack.points.length, 3, 'Omitted invalid lat point');
    assert(mixedTrack.points[1].ele < 2000, 'Reconstructed extreme elevation with interpolation');
    assert(mixedTrack.warnings.length > 0, 'Preserved diagnostic warnings on track');
  });
});
