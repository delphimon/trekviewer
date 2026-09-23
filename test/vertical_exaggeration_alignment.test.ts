import * as THREE from 'three';
import assert from 'node:assert';
import { describe, it } from 'vitest';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import type { TrackStats, GPXPoint, GPXWaypoint } from '../src/gpx/TrackTypes.ts';

describe('Vertical Exaggeration Alignment (Terrain, Trail & Waypoints)', () => {
  it('evaluates rigorous vertical exaggeration scaling alignment between trail, beacons, hiker, and waypoints', () => {
    const summitEle = 4392.0;
    const startEle = 1303.0;

    const points: GPXPoint[] = [
      { lat: 46.85, lon: -121.75, ele: startEle, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
      { lat: 46.86, lon: -121.76, ele: 2800, distanceFromStart: 3000, elapsedSeconds: 1800, playbackSeconds: 30, index: 1 },
      { lat: 46.87, lon: -121.77, ele: summitEle, distanceFromStart: 6000, elapsedSeconds: 3600, playbackSeconds: 60, index: 2 },
    ];

    const waypoints: GPXWaypoint[] = [
      { lat: 46.85, lon: -121.75, ele: startEle, name: 'Trailhead', type: 'start' },
      { lat: 46.87, lon: -121.77, ele: summitEle, name: 'Columbia Crest Summit', type: 'summit' },
    ];

    const mockTrack: TrackStats = {
      name: 'Mount Rainier Alignment Test',
      points,
      segments: [
        {
          points,
          distance: 6000,
          elevationGain: summitEle - startEle,
          elevationLoss: 0,
          startIndex: 0,
          endIndex: 2,
        },
      ],
      totalDistance: 6000,
      elevationGain: summitEle - startEle,
      elevationLoss: 0,
      minElevation: startEle,
      maxElevation: summitEle,
      movingTime: 3600,
      totalPlaybackSeconds: 60,
      avgSpeed: 5.0,
      maxSpeed: 10.0,
      bounds: {
        minLat: 46.85,
        maxLat: 46.87,
        minLon: -121.77,
        maxLon: -121.75,
        minEle: startEle,
        maxEle: summitEle,
        centerLat: 46.86,
        centerLon: -121.76,
        widthMeters: 5000,
        depthMeters: 5000,
        elevationSpan: summitEle - startEle,
      },
      waypoints,
      landmarks: [],
      warnings: [],
    };

    // 1. Fixed DEM elevation sampler returning a known ground height (250m)
    const fixedGroundEle = 250.0;
    const dummyElevationSampler = (_x: number, _z: number) => fixedGroundEle;

    const trailResult = TrailMesh.create(mockTrack, dummyElevationSampler, startEle);
    const maxDim = Math.max(mockTrack.bounds.widthMeters, mockTrack.bounds.depthMeters);
    const scaleFactor = Math.max(1.0, maxDim / 4000);
    const dioramaElevationOffset = Math.max(2.5, 2.0 * scaleFactor);

    // 2. Create DioramaBase with waypoints and elevation sampler
    const baseGroup = DioramaBase.create(
      mockTrack.bounds,
      -80,
      waypoints,
      startEle,
      dummyElevationSampler,
      1.0
    );

    const wpGroup = baseGroup.getObjectByName('Waypoints') as THREE.Group;
    assert(wpGroup, 'Waypoints group must exist in diorama base');
    assert.strictEqual(wpGroup.children.length, 2, 'Must have 2 waypoint pins');

    const summitMarker = wpGroup.children.find((c) => c.name.includes('Summit'))!;
    assert(summitMarker, 'Summit marker must exist');

    const baseSummitY = summitMarker.userData.baseY;
    assert.strictEqual(baseSummitY, fixedGroundEle, 'baseY must match fixed DEM ground height');

    // Verify initial beacon naming semantics (last point is at peak elevation -> SUMMIT)
    assert.strictEqual(trailResult.startBeacon.name, 'Pin_START');
    assert.strictEqual(trailResult.finishBeacon.name, 'Pin_SUMMIT');

    // 3. Test vertical exaggeration scaling across 1.0x, 1.5x, 2.0x, 3.0x
    const testFactors = [1.0, 1.5, 2.0, 3.0];
    const offsetsObserved: number[] = [];

    for (const factor of testFactors) {
      trailResult.setVerticalExaggeration(factor);
      DioramaBase.setVerticalExaggeration(baseGroup, factor);

      // Verify waypoint marker height matches factor * baseY + 8
      const expectedWaypointY = fixedGroundEle * factor + 8.0;
      assert(
        Math.abs(summitMarker.position.y - expectedWaypointY) < 1e-4,
        `At ${factor}x, summit marker Y should be ${expectedWaypointY.toFixed(2)}, got ${summitMarker.position.y.toFixed(2)}`
      );

      // Verify Start and Finish beacons match factor * groundY + 8.0
      const expectedBeaconY = fixedGroundEle * factor + 8.0;
      assert(
        Math.abs(trailResult.startBeacon.position.y - expectedBeaconY) < 1e-4,
        `At ${factor}x, startBeacon Y should be ${expectedBeaconY.toFixed(2)}, got ${trailResult.startBeacon.position.y.toFixed(2)}`
      );
      assert(
        Math.abs(trailResult.finishBeacon.position.y - expectedBeaconY) < 1e-4,
        `At ${factor}x, finishBeacon Y should be ${expectedBeaconY.toFixed(2)}, got ${trailResult.finishBeacon.position.y.toFixed(2)}`
      );

      // Verify Hiker marker position matches factor * groundY + dioramaElevationOffset
      trailResult.updateHikerPosition(0.5);
      const expectedHikerY = fixedGroundEle * factor + dioramaElevationOffset;
      assert(
        Math.abs(trailResult.hikerMarker.position.y - expectedHikerY) < 1e-4,
        `At ${factor}x, hikerMarker Y should be ${expectedHikerY.toFixed(2)}, got ${trailResult.hikerMarker.position.y.toFixed(2)}`
      );

      // Verify trail mesh vertices scale strictly as groundY * factor + dioramaElevationOffset
      const ribbonMesh = trailResult.trailMesh;
      const posAttr = ribbonMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const expectedTrailY = fixedGroundEle * factor + dioramaElevationOffset;

      for (let i = 0; i < posAttr.count; i++) {
        const vertexY = posAttr.getY(i);
        assert(
          Math.abs(vertexY - expectedTrailY) < 1e-4,
          `At ${factor}x, ribbon vertex ${i} Y should be ${expectedTrailY.toFixed(2)}, got ${vertexY.toFixed(2)}`
        );
      }

      // Record the constant offset: trailY - (fixedGroundEle * factor) must equal dioramaElevationOffset
      const sampleVertexY = posAttr.getY(0);
      const observedOffset = sampleVertexY - fixedGroundEle * factor;
      offsetsObserved.push(observedOffset);

      assert(
        Math.abs(observedOffset - dioramaElevationOffset) < 1e-4,
        `Offset must remain constant at ${dioramaElevationOffset}, observed ${observedOffset}`
      );

      console.log(
        `✓ At ${factor.toFixed(1)}x exaggeration: terrainGroundY = ${(fixedGroundEle * factor).toFixed(2)}m, ` +
        `trailY = ${expectedTrailY.toFixed(2)}m (offset = ${dioramaElevationOffset.toFixed(2)}m constant), ` +
        `waypointY = ${expectedWaypointY.toFixed(2)}m, beaconY = ${expectedBeaconY.toFixed(2)}m`
      );
    }

    // Verify constant offset is invariant across all factors
    for (let i = 1; i < offsetsObserved.length; i++) {
      assert(
        Math.abs(offsetsObserved[i] - offsetsObserved[0]) < 1e-4,
        `Trail offset changed between exaggeration steps: ${offsetsObserved[i]} vs ${offsetsObserved[0]}`
      );
    }
    console.log('✓ Verified: Trail elevation offset remains strictly constant and is never scaled by exaggeration factor');

    // 4. Test ViewMode switching and First-Person 1:1 Path Geometry
    trailResult.setViewMode('first-person');
    assert.strictEqual(trailResult.hikerMarker.visible, false);
    assert.strictEqual(trailResult.startBeacon.visible, false);
    assert.strictEqual(trailResult.finishBeacon.visible, false);

    const fpPosAttr = trailResult.trailMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const expectedFpY = fixedGroundEle * 1.0 + 0.05; // 0.05m ground clearance
    for (let i = 0; i < Math.min(100, fpPosAttr.count); i++) {
      const vy = fpPosAttr.getY(i);
      assert(
        Math.abs(vy - expectedFpY) < 1e-4,
        `First-person path vertex Y should be ${expectedFpY.toFixed(2)}, got ${vy.toFixed(2)}`
      );
    }
    console.log('✓ First-person 1:1 path correctly sits 0.05m above DEM ground elevation');

    trailResult.setViewMode('diorama');
    assert.strictEqual(trailResult.hikerMarker.visible, true);
    assert.strictEqual(trailResult.startBeacon.visible, true);
    assert.strictEqual(trailResult.finishBeacon.visible, true);

    trailResult.dispose();
    console.log('✓ All Vertical Exaggeration Alignment tests passed successfully!');
  });

  it('labels finish beacon as FINISH when final point is not at peak elevation', () => {
    const points: GPXPoint[] = [
      { lat: 46.85, lon: -121.75, ele: 1000, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
      { lat: 46.86, lon: -121.76, ele: 3000, distanceFromStart: 3000, elapsedSeconds: 1800, playbackSeconds: 30, index: 1 },
      { lat: 46.87, lon: -121.77, ele: 1200, distanceFromStart: 6000, elapsedSeconds: 3600, playbackSeconds: 60, index: 2 },
    ];

    const mockTrack: TrackStats = {
      name: 'Loop Hike',
      points,
      segments: [
        {
          points,
          distance: 6000,
          elevationGain: 2000,
          elevationLoss: 1800,
          startIndex: 0,
          endIndex: 2,
        },
      ],
      totalDistance: 6000,
      elevationGain: 2000,
      elevationLoss: 1800,
      minElevation: 1000,
      maxElevation: 3000,
      movingTime: 3600,
      totalPlaybackSeconds: 60,
      avgSpeed: 5.0,
      maxSpeed: 10.0,
      bounds: {
        minLat: 46.85,
        maxLat: 46.87,
        minLon: -121.77,
        maxLon: -121.75,
        minEle: 1000,
        maxEle: 3000,
        centerLat: 46.86,
        centerLon: -121.76,
        widthMeters: 5000,
        depthMeters: 5000,
        elevationSpan: 2000,
      },
      waypoints: [],
      landmarks: [],
      warnings: [],
    };

    const trailResult = TrailMesh.create(mockTrack, undefined, 1000);
    assert.strictEqual(trailResult.startBeacon.name, 'Pin_START');
    assert.strictEqual(trailResult.finishBeacon.name, 'Pin_FINISH');
    trailResult.dispose();
    console.log('✓ Neutral endpoint semantics verified: labeled FINISH for loop route ending at low elevation');
  });
});
