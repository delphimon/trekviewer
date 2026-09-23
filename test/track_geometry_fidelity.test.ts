import * as THREE from 'three';
import assert from 'node:assert';
import { describe, it } from 'vitest';
import { simplifyPointsRDP, RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { TextureBudget } from '../src/terrain/TextureBudget.ts';
import type { TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';

describe('Track Geometry Fidelity & Adaptive Resolution', () => {
  it('evaluates RDP simplification, switchbacks, cumulative distance telemetry, and texture budget', () => {
    // 1. RDP Simplification: Switchbacks & Hairpins
    console.log('Testing RDP simplification with alpine switchbacks and hairpin turns...');

    const switchbackPoints: THREE.Vector3[] = [
      new THREE.Vector3(0, 1000, 0),
      new THREE.Vector3(50, 1010, 0),
      new THREE.Vector3(100, 1020, 0),   // Turn 1 Apex
      new THREE.Vector3(100, 1022, 10),  // Hairpin bend
      new THREE.Vector3(50, 1030, 12),
      new THREE.Vector3(0, 1040, 14),    // Turn 2 Apex
      new THREE.Vector3(0, 1042, 24),    // Hairpin bend
      new THREE.Vector3(50, 1050, 26),
      new THREE.Vector3(100, 1060, 28),
    ];

    const simplifiedSwitchbacks = simplifyPointsRDP(switchbackPoints, 6.0);
    console.log(`Original switchback vertices: ${switchbackPoints.length}, Simplified: ${simplifiedSwitchbacks.length}`);

    assert(simplifiedSwitchbacks.length >= 5, 'Hairpin apexes must be preserved by RDP');
    assert(simplifiedSwitchbacks[0].equals(switchbackPoints[0]));
    assert(simplifiedSwitchbacks[simplifiedSwitchbacks.length - 1].equals(switchbackPoints[switchbackPoints.length - 1]));

    const hasEastApex = simplifiedSwitchbacks.some((p) => Math.abs(p.x - 100) < 0.1);
    const hasWestApex = simplifiedSwitchbacks.some((p) => Math.abs(p.x - 0) < 0.1 && p.y > 1030);
    assert(hasEastApex, 'East hairpin apex (x=100) must be preserved');
    assert(hasWestApex, 'West hairpin apex (x=0) must be preserved');
    console.log('✓ Alpine switchback and 180° hairpin apexes preserved within 6m tolerance');

    // 2. Sharp Glacier Zigzags
    console.log('Testing sharp glacier zigzags (crevasse navigation)...');
    const zigzagPoints: THREE.Vector3[] = [
      new THREE.Vector3(0, 3000, 0),
      new THREE.Vector3(15, 3005, 5),
      new THREE.Vector3(0, 3010, 10),
      new THREE.Vector3(20, 3015, 15),
      new THREE.Vector3(-10, 3020, 20),
      new THREE.Vector3(0, 3025, 25),
      new THREE.Vector3(0, 3030, 50),
    ];

    const simplifiedZigzags = simplifyPointsRDP(zigzagPoints, 6.0);
    console.log(`Original glacier zigzag vertices: ${zigzagPoints.length}, Simplified: ${simplifiedZigzags.length}`);
    const hasCrevasseDetour1 = simplifiedZigzags.some((p) => Math.abs(p.x - 20) < 0.1);
    const hasCrevasseDetour2 = simplifiedZigzags.some((p) => Math.abs(p.x - (-10)) < 0.1);
    assert(hasCrevasseDetour1 && hasCrevasseDetour2, 'Major crevasse navigation detours must be retained');
    console.log('✓ Glacier zigzags and crevasse detours preserved');

    // 3. Sparse Tracks (Low GPS Recording Frequency)
    console.log('Testing sparse track handling...');
    const sparsePoints: THREE.Vector3[] = [
      new THREE.Vector3(0, 1000, 0),
      new THREE.Vector3(500, 1500, 1000),
      new THREE.Vector3(1200, 2200, 2500),
    ];
    const simplifiedSparse = simplifyPointsRDP(sparsePoints, 6.0);
    assert.strictEqual(simplifiedSparse.length, 3, 'Sparse tracks must not lose points');
    console.log('✓ Sparse tracks preserved without point loss');

    // 4. RouteGeometry Cumulative Distance Progress Mapping
    console.log('Testing RouteGeometry analytical cumulative distance binary search...');

    const trackPoints: GPXPoint[] = [
      { lat: 46.85, lon: -121.75, ele: 1500, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0, speed: 1.2, grade: 0.05 },
      { lat: 46.86, lon: -121.76, ele: 2500, distanceFromStart: 2000, elapsedSeconds: 1800, playbackSeconds: 30, index: 1, speed: 1.0, grade: 0.15 },
      { lat: 46.87, lon: -121.77, ele: 4392, distanceFromStart: 5000, elapsedSeconds: 4500, playbackSeconds: 60, index: 2, speed: 0.8, grade: 0.25 },
    ];

    const mockTrack: TrackStats = {
      name: 'Alpine Test Ridge',
      points: trackPoints,
      segments: [
        {
          points: trackPoints,
          distance: 5000,
          elevationGain: 2892,
          elevationLoss: 0,
          startIndex: 0,
          endIndex: 2,
        },
      ],
      totalDistance: 5000,
      elevationGain: 2892,
      elevationLoss: 0,
      minElevation: 1500,
      maxElevation: 4392,
      movingTime: 3600,
      totalPlaybackSeconds: 60,
      avgSpeed: 5.0,
      maxSpeed: 10.0,
      bounds: {
        minLat: 46.85,
        maxLat: 46.87,
        minLon: -121.77,
        maxLon: -121.75,
        minEle: 1500,
        maxEle: 4392,
        centerLat: 46.86,
        centerLon: -121.76,
        widthMeters: 4000,
        depthMeters: 4000,
        elevationSpan: 2892,
      },
      waypoints: [],
      landmarks: [],
      warnings: [],
    };

    const routeGeom = new RouteGeometry(mockTrack, 1500);

    const tele0 = routeGeom.getTelemetryAtProgress(0);
    assert(Math.abs(tele0.currentPoint.ele - 1500) < 0.1, `Expected ele 1500, got ${tele0.currentPoint.ele}`);
    assert.strictEqual(tele0.currentPoint.distanceFromStart, 0);

    const tele1000 = routeGeom.getTelemetryAtDistance(1000);
    assert(Math.abs(tele1000.currentPoint.ele - 2000) < 0.1, `Expected ele 2000, got ${tele1000.currentPoint.ele}`);
    assert(tele1000.currentPoint.grade !== undefined && Math.abs(tele1000.currentPoint.grade - 0.10) < 0.01, 'Grade should interpolate accurately');

    const tele3500 = routeGeom.getTelemetryAtDistance(3500);
    assert(Math.abs(tele3500.currentPoint.ele - 3446) < 1.0, `Expected ele 3446, got ${tele3500.currentPoint.ele}`);

    console.log('✓ Cumulative distance binary search correctly interpolates elevation, grade, and speed');

    // 5. Adaptive Terrain Mesh Resolution (TextureBudget)
    console.log('Testing adaptive terrain mesh segment allocation...');

    const smallRes = TextureBudget.getTerrainMeshResolution(5000);
    assert.strictEqual(smallRes.segX, 128);

    const massifRes = TextureBudget.getTerrainMeshResolution(18000);
    assert.strictEqual(massifRes.segX, 128);

    const ridgeRes = TextureBudget.getTerrainMeshResolution(35000);
    assert.strictEqual(ridgeRes.segX, 112);

    const expeditionRes = TextureBudget.getTerrainMeshResolution(65000);
    assert.strictEqual(expeditionRes.segX, 96);

    console.log('✓ Adaptive terrain resolution scales conservatively within Quest GPU budget');
    console.log('✓ All Track Geometry Fidelity & Adaptive Resolution tests passed successfully!');
  });
});
