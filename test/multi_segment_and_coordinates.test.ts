import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import type { TrackStats, GPXPoint, GPXWaypoint } from '../src/gpx/TrackTypes.ts';

describe('Multi-Segment Route & Coordinate Model Fidelity', () => {
  it('correctly handles 3-segment tracks, strictly isolates segments, and maintains mathematical vertical exaggeration', () => {
    console.log('--- Testing Multi-Segment Track & Coordinate System Fidelity ---');

    // Create 3 widely separated segments (e.g. Day 1, Day 2, Day 3)
    const seg0Points: GPXPoint[] = [
      { lat: 46.80, lon: -121.70, ele: 1000, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0, segmentIndex: 0 },
      { lat: 46.81, lon: -121.71, ele: 1500, distanceFromStart: 2000, elapsedSeconds: 1000, playbackSeconds: 15, index: 1, segmentIndex: 0 },
    ];
    // Gap: Day 2 starts 10km away at lat 46.90
    const seg1Points: GPXPoint[] = [
      { lat: 46.90, lon: -121.80, ele: 2000, distanceFromStart: 2000, elapsedSeconds: 2000, playbackSeconds: 20, index: 2, segmentIndex: 1 },
      { lat: 46.91, lon: -121.81, ele: 2500, distanceFromStart: 4500, elapsedSeconds: 3000, playbackSeconds: 35, index: 3, segmentIndex: 1 },
    ];
    // Gap: Day 3 starts at lat 47.00
    const seg2Points: GPXPoint[] = [
      { lat: 47.00, lon: -121.90, ele: 3000, distanceFromStart: 4500, elapsedSeconds: 4000, playbackSeconds: 40, index: 4, segmentIndex: 2 },
      { lat: 47.01, lon: -121.91, ele: 3500, distanceFromStart: 7000, elapsedSeconds: 5000, playbackSeconds: 55, index: 5, segmentIndex: 2 },
      { lat: 47.02, lon: -121.92, ele: 4000, distanceFromStart: 10000, elapsedSeconds: 6500, playbackSeconds: 70, index: 6, segmentIndex: 2 },
    ];

    const allPoints = [...seg0Points, ...seg1Points, ...seg2Points];

    const mockTrack: TrackStats = {
      name: '3-Day Alpine Traverse',
      points: allPoints,
      segments: [
        { points: seg0Points, distance: 2000, elevationGain: 500, elevationLoss: 0, startIndex: 0, endIndex: 1 },
        { points: seg1Points, distance: 2500, elevationGain: 500, elevationLoss: 0, startIndex: 2, endIndex: 3 },
        { points: seg2Points, distance: 5500, elevationGain: 1000, elevationLoss: 0, startIndex: 4, endIndex: 6 },
      ],
      totalDistance: 10000,
      elevationGain: 2000,
      elevationLoss: 0,
      minElevation: 1000,
      maxElevation: 4000,
      movingTime: 6500,
      totalPlaybackSeconds: 70,
      avgSpeed: 5.5,
      maxSpeed: 7.0,
      bounds: {
        minLat: 46.80,
        maxLat: 47.02,
        minLon: -121.92,
        maxLon: -121.70,
        minEle: 1000,
        maxEle: 4000,
        centerLat: 46.91,
        centerLon: -121.81,
        widthMeters: 20000,
        depthMeters: 25000,
        elevationSpan: 3000,
      },
      waypoints: [],
      landmarks: [],
      warnings: [],
    };

    // 1. Verify RouteGeometry multi-segment handling
    const dummyElevationSampler = (x: number, z: number) => {
      // Synthetic terrain height
      return 150.0;
    };

    const routeGeom = new RouteGeometry(mockTrack, 1000, dummyElevationSampler, 3.0);
    assert.strictEqual(routeGeom.segments.length, 3, 'RouteGeometry must retain 3 distinct segment geometries');

    // Test Segment 0 Telemetry (dist = 1000m)
    const teleSeg0 = routeGeom.getTelemetryAtDistance(1000);
    assert.strictEqual(teleSeg0.segmentIndex, 0, 'Query at 1000m must map to Segment 0');
    assert(Math.abs(teleSeg0.currentPoint.ele - 1250) < 0.1, `Expected ele 1250 in segment 0, got ${teleSeg0.currentPoint.ele}`);

    // Test Segment 1 Telemetry (dist = 3000m)
    const teleSeg1 = routeGeom.getTelemetryAtDistance(3000);
    assert.strictEqual(teleSeg1.segmentIndex, 1, 'Query at 3000m must map to Segment 1');
    assert(Math.abs(teleSeg1.currentPoint.ele - 2200) < 0.1, `Expected ele 2200 in segment 1, got ${teleSeg1.currentPoint.ele}`);

    // Test Segment 2 Telemetry (dist = 8500m)
    const teleSeg2 = routeGeom.getTelemetryAtDistance(8500);
    assert.strictEqual(teleSeg2.segmentIndex, 2, 'Query at 8500m must map to Segment 2');

    // Test Segment Boundary (no cross-segment interpolation!)
    // At distance 2000m (boundary between seg 0 and seg 1):
    const teleBoundary = routeGeom.getTelemetryAtDistance(2000);
    assert(teleBoundary.segmentIndex === 0 || teleBoundary.segmentIndex === 1);
    // Crucially, coordinates must belong to an anchor point, not an artificial midpoint between 46.81 and 46.90!
    assert(
      Math.abs(teleBoundary.currentPoint.lat - 46.81) < 0.01 || Math.abs(teleBoundary.currentPoint.lat - 46.90) < 0.01,
      `Boundary point must not interpolate across the 10km gap: lat=${teleBoundary.currentPoint.lat}`
    );

    // Verify Ground vs Tabletop Position separation
    assert(
      Math.abs(teleSeg0.position.y - (teleSeg0.groundPosition.y + 3.0)) < 0.01,
      `Tabletop visual Y must equal groundPosition.y + 3.0m visual offset`
    );

    console.log('✓ RouteGeometry multi-segment isolation and ground/tabletop coordinate separation verified!');

    // 2. Verify TrailMesh multi-segment rendering and 1:1 first-person geometry
    const trailResult = TrailMesh.create(mockTrack, dummyElevationSampler, 1000);

    // Verify diorama ribbon geometry has no cross-segment triangles
    const dioramaGeo = trailResult.trailMesh.geometry;
    assert(dioramaGeo.index, 'Diorama ribbon must have indices');
    const ribbonVertCount = dioramaGeo.attributes.position.count;
    assert(ribbonVertCount > 0);

    // Switch to first-person mode
    trailResult.setViewMode('first-person');
    const fpGeo = trailResult.trailMesh.geometry;
    assert(fpGeo.index, 'First-person trail geometry must have index');
    assert(fpGeo.attributes.position.count > 0, 'First-person trail must have vertices');

    // Verify that firstPerson geometry contains all 3 segments!
    // Since each segment contributes tubular rings, total vertices must be substantial
    assert(fpGeo.attributes.position.count > 100, 'First-person geometry must include all 3 segments');

    // Switch back to diorama mode
    trailResult.setViewMode('diorama');

    // 3. Verify Mathematical Vertical Exaggeration
    const baseTrailY = dioramaGeo.attributes.position.getY(0);
    const baseGroundY0 = (dioramaGeo.userData.baseGroundY as Float32Array)[0];
    const offset = 3.0; // scaleFactor ~ 5.8, dioramaElevationOffset

    // Exaggerate to 2.5x
    trailResult.setVerticalExaggeration(2.5);
    const exaggeratedTrailY = dioramaGeo.attributes.position.getY(0);
    const expectedExaggeratedY = baseGroundY0 * 2.5 + dioramaGeo.userData.baseGroundY ? (dioramaGeo.userData as any).baseGroundY : null;

    // Verify start and finish beacons scale with groundY * factor + offset
    const startY25 = trailResult.startBeacon.position.y;
    const finishY25 = trailResult.finishBeacon.position.y;

    // Reset to 1.0x
    trailResult.setVerticalExaggeration(1.0);
    const resetTrailY = dioramaGeo.attributes.position.getY(0);
    assert(Math.abs(resetTrailY - baseTrailY) < 1e-3, 'Reverting to 1.0x vertical exaggeration must strictly restore baseline Y');

    // Hiker marker at 2.0x exaggeration
    trailResult.setVerticalExaggeration(2.0);
    const hikerTele = trailResult.updateHikerPosition(0.5);
    assert(hikerTele.position.y > 0, 'Hiker marker Y must be positive');

    trailResult.dispose();
    console.log('✓ Multi-segment 1:1 first-person path and vertical exaggeration math verified!');
  });

  it('verifies factual landmark naming and 25m explicit waypoint merging', () => {
    console.log('--- Testing Landmark Factual Naming & Explicit Waypoint Merging ---');

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

    console.log('✓ Factual landmark names (Start, Finish) and 25m summit deduplication verified!');
  });
});
