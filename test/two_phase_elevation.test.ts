import { describe, it } from 'vitest';
import assert from 'node:assert';
import { GPXParser } from '../src/gpx/GPXParser.ts';

describe('Two-Phase Missing Elevation Pipeline & Provenance', () => {
  it('enforces 25MB upload limit, extracts raw track, and validates bounds', () => {
    // 1. File size limit
    const hugeXml = 'x'.repeat(26 * 1024 * 1024);
    assert.throws(
      () => GPXParser.parseRaw(hugeXml),
      /25 MB limit/,
      'Must reject GPX files exceeding 25MB'
    );

    // 2. Raw parse and bounds
    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Two Phase Test Ridge</name>
    <trkseg>
      <trkpt lat="46.800" lon="-121.700"><ele>1500.0</ele></trkpt>
      <trkpt lat="46.850" lon="-121.750"></trkpt>
      <trkpt lat="46.900" lon="-121.800"><ele>2500.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const raw = GPXParser.parseRaw(sampleXml);
    assert.strictEqual(raw.trackName, 'Two Phase Test Ridge');
    assert.strictEqual(raw.rawSegments.length, 1);
    assert.strictEqual(raw.rawSegments[0].length, 3);

    const bounds = GPXParser.calculateRawBounds(raw);
    assert(bounds.widthMeters > 0, 'Width meters must be positive');
    assert(bounds.depthMeters > 0, 'Depth meters must be positive');
    assert(bounds.centerLat > 46.8 && bounds.centerLat < 46.9);
  });

  it('tracks elevation provenance hierarchy: gpx -> dem -> interpolated -> fallback and aggregates stats', () => {
    // Point 0: has GPX ele 1200
    // Point 1: missing, DEM sampler will provide 1600
    // Point 2: missing, DEM sampler will return undefined -> interpolated between 1600 and 2000 = 1800
    // Point 3: has GPX ele 2000
    const testXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Provenance Test</name>
    <trkseg>
      <trkpt lat="46.80" lon="-121.70"><ele>1200.0</ele></trkpt>
      <trkpt lat="46.81" lon="-121.71"></trkpt>
      <trkpt lat="46.82" lon="-121.72"></trkpt>
      <trkpt lat="46.83" lon="-121.73"><ele>2000.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const raw = GPXParser.parseRaw(testXml);

    const mockDemSampler = (lat: number, _lon: number) => {
      // DEM is only available for point 1 (lat 46.81)
      if (Math.abs(lat - 46.81) < 0.005) {
        return 1600.0;
      }
      return undefined;
    };

    const track = GPXParser.finalizeWithDEM(raw, mockDemSampler);
    assert.strictEqual(track.points.length, 4);

    // Point 0: gpx
    assert.strictEqual(track.points[0].ele, 1200.0);
    assert.strictEqual(track.points[0].elevationProvenance, 'gpx');

    // Point 1: dem
    assert.strictEqual(track.points[1].ele, 1600.0);
    assert.strictEqual(track.points[1].elevationProvenance, 'dem');

    // Point 2: interpolated between 1600 (pt1) and 2000 (pt3) = 1800
    assert.strictEqual(track.points[2].ele, 1800.0);
    assert.strictEqual(track.points[2].elevationProvenance, 'interpolated');

    // Point 3: gpx
    assert.strictEqual(track.points[3].ele, 2000.0);
    assert.strictEqual(track.points[3].elevationProvenance, 'gpx');

    // Provenance aggregate stats
    const stats = track.elevationProvenanceStats;
    assert(stats, 'elevationProvenanceStats must be defined');
    assert.strictEqual(stats.gpxCount, 2);
    assert.strictEqual(stats.demCount, 1);
    assert.strictEqual(stats.interpolatedCount, 1);
    assert.strictEqual(stats.fallbackCount, 0);
    assert.strictEqual(stats.gpxPercent, 50);
    assert.strictEqual(stats.demPercent, 25);
    assert.strictEqual(stats.interpolatedPercent, 25);
  });

  it('snaps waypoints missing elevation to DEM during finalizeWithDEM', () => {
    const waypointXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <wpt lat="46.85" lon="-121.75"><name>Camp Hazard</name></wpt>
  <wpt lat="46.86" lon="-121.76"><ele>3200.0</ele><name>Known Peak</name></wpt>
  <trk>
    <name>Waypoint Snapping</name>
    <trkseg>
      <trkpt lat="46.85" lon="-121.75"><ele>2000.0</ele></trkpt>
      <trkpt lat="46.86" lon="-121.76"><ele>3200.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const raw = GPXParser.parseRaw(waypointXml);
    assert.strictEqual(raw.waypoints.length, 2);
    assert.strictEqual(raw.waypoints[0].ele, undefined);

    const mockDemSampler = (lat: number, _lon: number) => {
      if (Math.abs(lat - 46.85) < 0.005) return 2450.0;
      return undefined;
    };

    const track = GPXParser.finalizeWithDEM(raw, mockDemSampler);
    assert.strictEqual(track.waypoints.length, 2);
    assert.strictEqual(track.waypoints[0].ele, 2450.0, 'Waypoint missing elevation must be filled from DEM');
    assert.strictEqual(track.waypoints[1].ele, 3200.0, 'Waypoint with existing elevation must be preserved');
  });

  it('interpolates entirely un-elevated segments from neighboring valid segments', () => {
    const multiSegXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Multi Segment Elevation Hierarchy</name>
    <trkseg>
      <trkpt lat="46.80" lon="-121.70"><ele>1500.0</ele></trkpt>
      <trkpt lat="46.81" lon="-121.71"><ele>1700.0</ele></trkpt>
    </trkseg>
    <trkseg>
      <!-- Entire segment missing elevation and no DEM coverage -->
      <trkpt lat="46.82" lon="-121.72"></trkpt>
      <trkpt lat="46.83" lon="-121.73"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const raw = GPXParser.parseRaw(multiSegXml);
    // Call finalize with no DEM available
    const track = GPXParser.finalizeWithDEM(raw, undefined);

    assert.strictEqual(track.segments.length, 2);
    // Segment 1 points must borrow nearest valid segment elevation (1700) instead of 1000m fallback
    assert.strictEqual(track.segments[1].points[0].ele, 1700.0);
    assert.strictEqual(track.segments[1].points[1].ele, 1700.0);
    assert.strictEqual(track.segments[1].points[0].elevationProvenance, 'interpolated');
    assert.strictEqual(track.segments[1].points[1].elevationProvenance, 'interpolated');
  });

  it('uses fallback with explicit warning when entire route has zero elevation and no DEM', () => {
    const zeroEleXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewerTest">
  <trk>
    <name>Total No Elevation</name>
    <trkseg>
      <trkpt lat="46.80" lon="-121.70"></trkpt>
      <trkpt lat="46.81" lon="-121.71"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const raw = GPXParser.parseRaw(zeroEleXml);
    const track = GPXParser.finalizeWithDEM(raw, undefined);

    for (const p of track.points) {
      assert.strictEqual(p.ele, 1000.0);
      assert.strictEqual(p.elevationProvenance, 'fallback');
    }
    assert(track.warnings.some((w) => w.includes('No elevation data found in GPS track or DEM terrain')));
    assert.strictEqual(track.elevationProvenanceStats?.fallbackPercent, 100);
  });
});
