import { describe, it } from 'vitest';
import assert from 'node:assert';
import { GPXParser } from '../src/gpx/GPXParser.ts';

describe('Missing Elevation Normalization & Fallbacks', () => {
  it('verifies missing elevation interpolation and fallbacks', () => {
    // Case 1: GPX with intermittently missing elevation tags
    const intermittentEleGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Intermittent Elevation Trail</name>
    <trkseg>
      <trkpt lat="46.850" lon="-121.750"><ele>1000.0</ele></trkpt>
      <trkpt lat="46.851" lon="-121.751"></trkpt>
      <trkpt lat="46.852" lon="-121.752"></trkpt>
      <trkpt lat="46.853" lon="-121.753"><ele>1300.0</ele></trkpt>
      <trkpt lat="46.854" lon="-121.754"></trkpt>
      <trkpt lat="46.855" lon="-121.755"><ele>1500.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const trackIntermittent = GPXParser.parse(intermittentEleGpx, 'Intermittent');
    assert.strictEqual(trackIntermittent.points.length, 6);

    // Point 0: had raw elevation 1000
    assert.strictEqual(trackIntermittent.points[0].ele, 1000.0);
    assert.strictEqual(trackIntermittent.points[0].rawEle, 1000.0);

    // Point 1: linearly interpolated (1/3 of the way between 1000 and 1300 = 1100)
    assert.strictEqual(trackIntermittent.points[1].rawEle, undefined, 'rawEle should be undefined when missing');
    assert(Math.abs(trackIntermittent.points[1].ele - 1100.0) < 0.01, `Expected 1100.0, got ${trackIntermittent.points[1].ele}`);

    // Point 2: linearly interpolated (2/3 of the way between 1000 and 1300 = 1200)
    assert.strictEqual(trackIntermittent.points[2].rawEle, undefined);
    assert(Math.abs(trackIntermittent.points[2].ele - 1200.0) < 0.01, `Expected 1200.0, got ${trackIntermittent.points[2].ele}`);

    // Point 3: had raw elevation 1300
    assert.strictEqual(trackIntermittent.points[3].ele, 1300.0);
    assert.strictEqual(trackIntermittent.points[3].rawEle, 1300.0);

    // Point 4: midpoint between 1300 and 1500 = 1400
    assert.strictEqual(trackIntermittent.points[4].rawEle, undefined);
    assert(Math.abs(trackIntermittent.points[4].ele - 1400.0) < 0.01, `Expected 1400.0, got ${trackIntermittent.points[4].ele}`);

    // Point 5: had raw elevation 1500
    assert.strictEqual(trackIntermittent.points[5].ele, 1500.0);

    // Verify warning was logged
    assert(trackIntermittent.warnings.some(w => w.includes('elevation')), 'Expected warning about missing elevation');

    // Case 2: GPX with completely missing elevation tags
    const zeroEleGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Flat 2D GPX</name>
    <trkseg>
      <trkpt lat="47.600" lon="-122.330"></trkpt>
      <trkpt lat="47.601" lon="-122.331"></trkpt>
      <trkpt lat="47.602" lon="-122.332"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const trackZero = GPXParser.parse(zeroEleGpx, 'Flat 2D');
    assert.strictEqual(trackZero.points.length, 3);
    for (const pt of trackZero.points) {
      assert(!isNaN(pt.ele), 'Normalized elevation must not be NaN');
      assert(pt.ele > 0, 'Fallback elevation must be positive');
      assert.strictEqual(pt.rawEle, undefined, 'rawEle should be undefined');
    }
    assert(trackZero.warnings.some(w => w.includes('missing') || w.includes('elevation')));

    // Case 3: DEM elevation sampler resolution for missing tags
    const demSampledGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>DEM Sampled GPX</name>
    <trkseg>
      <trkpt lat="46.850" lon="-121.750"></trkpt>
      <trkpt lat="46.860" lon="-121.760"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const demSampler = (lat: number, _lon: number) => {
      return lat > 46.855 ? 3500.0 : 1800.0;
    };

    const trackDEM = GPXParser.parse(demSampledGpx, 'DEM Track', demSampler);
    assert.strictEqual(trackDEM.points[0].ele, 1800.0);
    assert.strictEqual(trackDEM.points[1].ele, 3500.0);
  });
});
