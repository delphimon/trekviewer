import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { RouteLoader } from '../src/core/RouteLoader.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';

// Test GPX containing a missing elevation point in the middle
const GPX_WITH_MISSING_ELE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrekViewer Production Pipeline Test">
  <wpt lat="46.850" lon="-121.750"><name>Camp One (No Ele)</name></wpt>
  <trk>
    <name>Two-Phase Production Pipeline Test</name>
    <trkseg>
      <trkpt lat="46.840" lon="-121.740"><ele>1500.0</ele><time>2026-09-20T10:00:00Z</time></trkpt>
      <!-- Missing elevation on point 1: must be repaired from DEM in production RouteLoader -->
      <trkpt lat="46.850" lon="-121.750"><time>2026-09-20T11:00:00Z</time></trkpt>
      <trkpt lat="46.860" lon="-121.760"><ele>3200.0</ele><time>2026-09-20T12:00:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('Production RouteLoader Two-Phase Elevation Pipeline (Stage K)', () => {
  let origDocument: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;

    const mockCtx = {
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      measureText: () => ({ width: 50 }),
      roundRect: () => {},
      drawImage: () => {},
      setLineDash: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 512,
            height: 512,
            getContext: () => mockCtx,
          };
        }
        return {};
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    vi.restoreAllMocks();
  });

  it('production RouteLoader repairs missing elevations from DEM, snaps waypoints, and fetches DEM only once', async () => {
    const DEM_SURFACE_ELE = 2450.0;

    // Construct mock DEM grid covering the test coordinates
    // Lat ~46.85, Lon ~-121.75 at zoom 12
    const mockGrid: ElevationGrid = {
      width: 512,
      height: 512,
      zoom: 12,
      tileXMin: 662,
      tileXMax: 663,
      tileYMin: 1442,
      tileYMax: 1443,
      numTilesX: 2,
      numTilesY: 2,
      data: new Float32Array(512 * 512).fill(DEM_SURFACE_ELE),
      tileValidity: new Uint8Array([1, 1, 1, 1]),
      minElevation: DEM_SURFACE_ELE,
      maxElevation: DEM_SURFACE_ELE,
      isRealDEM: true,
    };

    // Spy on fetchElevationGrid to verify single-fetch constraint
    const fetchDemSpy = vi.spyOn(ElevationTileService, 'fetchElevationGrid').mockResolvedValue(mockGrid);

    const dioramaRoot = new THREE.Group();
    let committedTrek: LoadedTrek | null = null;

    const loader = new RouteLoader({
      dioramaRoot,
      getIsXR: () => false,
      onTrekCommitted: (trek) => {
        committedTrek = trek;
      },
    });

    // Run production RouteLoader pipeline end-to-end
    const loadedTrek = await loader.loadRouteFromXml(GPX_WITH_MISSING_ELE, 'Pipeline Test');

    if (!loadedTrek) {
      throw new Error('LoadedTrek must be created successfully');
    }
    assert.strictEqual(loadedTrek === committedTrek, true, 'Loaded trek must match committed trek');

    // 1. Verify Single DEM Network Fetch Invariant
    assert.strictEqual(
      fetchDemSpy.mock.calls.length,
      1,
      `DEM must be fetched exactly once (got ${fetchDemSpy.mock.calls.length} calls)`
    );
    console.log('✓ Verified: Exactly one DEM fetch performed during route loading transaction');

    // 2. Verify Point 1 Missing Elevation was normalized from DEM
    const track = loadedTrek.track;
    assert.strictEqual(track.points.length, 3);

    // Point 0: GPX elevation
    assert.strictEqual(track.points[0].ele, 1500.0);
    assert.strictEqual(track.points[0].elevationProvenance, 'gpx');

    // Point 1: Repaired from DEM
    assert.strictEqual(track.points[1].elevationProvenance, 'dem');
    assert.strictEqual(track.points[1].ele, DEM_SURFACE_ELE);
    assert.strictEqual(track.points[1].rawEle, undefined, 'rawEle should remain undefined for missing original');

    // Point 2: GPX elevation
    assert.strictEqual(track.points[2].ele, 3200.0);
    assert.strictEqual(track.points[2].elevationProvenance, 'gpx');

    console.log(`✓ Point 1 repaired with authentic DEM elevation: ${track.points[1].ele}m (provenance=${track.points[1].elevationProvenance})`);

    // 3. Verify Waypoint Snapping to DEM
    assert.strictEqual(track.waypoints.length, 1);
    assert.strictEqual(
      track.waypoints[0].ele,
      DEM_SURFACE_ELE,
      'Waypoint missing elevation must be snapped to DEM surface elevation'
    );
    console.log(`✓ Waypoint "${track.waypoints[0].name}" snapped to DEM height: ${track.waypoints[0].ele}m`);

    // 4. Verify Aggregate Elevation Provenance Statistics
    const provStats = track.elevationProvenanceStats;
    assert(provStats, 'elevationProvenanceStats must be attached to TrackStats');
    assert.strictEqual(provStats.gpxCount, 2);
    assert.strictEqual(provStats.demCount, 1);
    assert.strictEqual(provStats.interpolatedCount, 0);
    assert.strictEqual(provStats.fallbackCount, 0);
    assert.strictEqual(provStats.gpxPercent, 67);
    assert.strictEqual(provStats.demPercent, 33);
    console.log(`✓ Elevation Provenance Stats verified: ${provStats.gpxPercent}% GPX, ${provStats.demPercent}% DEM`);

    // 5. Cleanup
    loader.dispose();
    console.log('✓ Production RouteLoader Two-Phase Elevation Pipeline integration test passed successfully!');
  });
});
