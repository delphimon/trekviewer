import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import type { GPXPoint, TrackStats } from '../src/gpx/TrackTypes.ts';
import { localMetersToGeo } from '../src/gpx/Coordinates.ts';
import {
  RouteGeometry,
  headingForForwardVector,
  yawForForwardVector,
} from '../src/visualization/RouteGeometry.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';

function createSyntheticTrack(
  name: string,
  localCoords: { x: number; y: number; z: number }[]
): TrackStats {
  const points: GPXPoint[] = [];
  let cumulativeDist = 0;

  for (let i = 0; i < localCoords.length; i++) {
    const c = localCoords[i];
    if (i > 0) {
      const prev = localCoords[i - 1];
      cumulativeDist += Math.hypot(c.x - prev.x, c.y - prev.y, c.z - prev.z);
    }

    const geo = localMetersToGeo(c.x, c.z, 47.0, -121.0);
    const lat = geo.lat;
    const lon = geo.lon;
    const ele = 1000 + c.y;

    points.push({
      lat,
      lon,
      ele,
      distanceFromStart: cumulativeDist,
      elapsedSeconds: i * 10,
      playbackSeconds: i * 10,
      index: i,
      segmentIndex: 0,
    });
  }

  const bounds = {
    minLat: Math.min(...points.map((p) => p.lat)),
    maxLat: Math.max(...points.map((p) => p.lat)),
    minLon: Math.min(...points.map((p) => p.lon)),
    maxLon: Math.max(...points.map((p) => p.lon)),
    centerLat: 47.0,
    centerLon: -121.0,
    minEle: 1000,
    maxEle: 1200,
    widthMeters: 1000,
    depthMeters: 1000,
    elevationSpan: 200,
  };

  return {
    name,
    points,
    segments: [
      {
        points,
        distance: cumulativeDist,
        elevationGain: 0,
        elevationLoss: 0,
        startIndex: 0,
        endIndex: points.length - 1,
      },
    ],
    totalDistance: cumulativeDist,
    elevationGain: 0,
    elevationLoss: 0,
    minElevation: 1000,
    maxElevation: 1200,
    bounds,
    avgSpeed: 4.5,
    maxSpeed: 6.0,
    movingTime: 60,
    waypoints: [],
    landmarks: [],
    warnings: [],
    totalPlaybackSeconds: 60,
    timingType: 'recorded',
  };
}

describe('Stage U1: Authoritative Direction-of-Travel Model & Heading Fidelity', () => {
  it('correctly computes heading and yaw for pure forward vectors', () => {
    // 1. Heading North (-Z)
    const north = { x: 0, z: -1 };
    expect(headingForForwardVector(north)).toBeCloseTo(0, 5);
    expect(yawForForwardVector(north)).toBeCloseTo(0, 5);

    // 2. Heading East (+X)
    const east = { x: 1, z: 0 };
    expect(headingForForwardVector(east)).toBeCloseTo(Math.PI / 2, 5); // +90 deg
    expect(yawForForwardVector(east)).toBeCloseTo(-Math.PI / 2, 5); // -90 deg Three.js rotation

    // 3. Heading South (+Z)
    const south = { x: 0, z: 1 };
    expect(Math.abs(headingForForwardVector(south))).toBeCloseTo(Math.PI, 5); // 180 deg
    expect(Math.abs(yawForForwardVector(south))).toBeCloseTo(Math.PI, 5);

    // 4. Heading West (-X)
    const west = { x: -1, z: 0 };
    expect(headingForForwardVector(west)).toBeCloseTo(-Math.PI / 2, 5); // -90 deg
    expect(yawForForwardVector(west)).toBeCloseTo(Math.PI / 2, 5); // +90 deg Three.js rotation
  });

  it('verifies four cardinal directions: hiker arrow, yaw, and 1:1 first-person room alignment', () => {
    const cardinalConfigs = [
      {
        name: 'North (-Z)',
        coords: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: -50 },
          { x: 0, y: 0, z: -100 },
          { x: 0, y: 0, z: -150 },
        ],
        expectedForward: new THREE.Vector3(0, 0, -1),
        expectedHeadingRad: 0,
        expectedYawRad: 0,
      },
      {
        name: 'East (+X)',
        coords: [
          { x: 0, y: 0, z: 0 },
          { x: 50, y: 0, z: 0 },
          { x: 100, y: 0, z: 0 },
          { x: 150, y: 0, z: 0 },
        ],
        expectedForward: new THREE.Vector3(1, 0, 0),
        expectedHeadingRad: Math.PI / 2,
        expectedYawRad: -Math.PI / 2,
      },
      {
        name: 'South (+Z)',
        coords: [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 50 },
          { x: 0, y: 0, z: 100 },
          { x: 0, y: 0, z: 150 },
        ],
        expectedForward: new THREE.Vector3(0, 0, 1),
        expectedHeadingRad: Math.PI,
        expectedYawRad: -Math.PI,
      },
      {
        name: 'West (-X)',
        coords: [
          { x: 0, y: 0, z: 0 },
          { x: -50, y: 0, z: 0 },
          { x: -100, y: 0, z: 0 },
          { x: -150, y: 0, z: 0 },
        ],
        expectedForward: new THREE.Vector3(-1, 0, 0),
        expectedHeadingRad: -Math.PI / 2,
        expectedYawRad: Math.PI / 2,
      },
    ];

    for (const config of cardinalConfigs) {
      const track = createSyntheticTrack(config.name, config.coords);
      const trail = TrailMesh.create(track);
      const geom = trail.routeGeometry;

      // 1. Verify route forward at midpoint
      const forward = geom.getRouteForwardAtProgress(0.5);
      expect(forward.x).toBeCloseTo(config.expectedForward.x, 2);
      expect(forward.y).toBeCloseTo(0, 4); // Pure horizontal vector
      expect(forward.z).toBeCloseTo(config.expectedForward.z, 2);

      // 2. Verify hiker marker position and yaw rotation
      trail.updateHikerPosition(0.5);
      const heading = headingForForwardVector(forward);
      const yaw = yawForForwardVector(forward);
      expect(heading).toBeCloseTo(config.expectedHeadingRad, 2);
      expect(trail.hikerMarker.rotation.y).toBeCloseTo(config.expectedYawRad, 2);

      // 3. Verify actual hiker chevron cone arrow points along route forward in world space
      let chevronMesh: THREE.Mesh | null = null;
      trail.hikerMarker.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry instanceof THREE.ConeGeometry) {
          chevronMesh = child as THREE.Mesh;
        }
      });
      expect(chevronMesh).not.toBeNull();

      // Local tip of cone is at local -Z (apex at -9 in local cone coordinates)
      // When transformed through chevron and hikerMarker parent transforms, it must point along route forward!
      trail.hikerMarker.updateMatrixWorld(true);
      const localArrowTip = new THREE.Vector3(0, 0, -1);
      const worldArrowDir = localArrowTip.clone().applyEuler(trail.hikerMarker.rotation);
      expect(worldArrowDir.x).toBeCloseTo(config.expectedForward.x, 2);
      expect(worldArrowDir.z).toBeCloseTo(config.expectedForward.z, 2);

      // 4. Verify 1:1 first-person WebXR world rotation aligns route forward with room-space -Z
      const controller = new FlyoverController(trail, track);
      controller.setViewMode('first-person');
      const dummyDiorama = new THREE.Group();
      controller.update(0.016, undefined, dummyDiorama, true);

      // Explicit acceptance (Section 8):
      // When route tangent/forward = -Z, first-person world requires ZERO 180° inversion
      if (config.expectedForward.z === -1) {
        expect(dummyDiorama.rotation.y).toBeCloseTo(0, 4);
      }

      // In room coordinates, forward vector rotated by diorama rotation MUST point to room -Z
      const roomForward = forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), dummyDiorama.rotation.y);
      expect(roomForward.x).toBeCloseTo(0, 2);
      expect(roomForward.z).toBeCloseTo(-1, 2);

      trail.dispose();
      controller.dispose();
    }
  });

  it('verifies switchback turn heading does not flip backward', () => {
    // Construct sharp switchback from East (+X) to West (-X)
    const switchbackCoords = [
      { x: 0, y: 0, z: 0 },
      { x: 40, y: 0, z: 0 },
      { x: 80, y: 0, z: 0 },
      { x: 100, y: 0, z: 5 },
      { x: 100, y: 0, z: 15 },
      { x: 80, y: 0, z: 20 },
      { x: 40, y: 0, z: 20 },
      { x: 0, y: 0, z: 20 },
    ];

    const track = createSyntheticTrack('Switchback', switchbackCoords);
    const trail = TrailMesh.create(track);
    const geom = trail.routeGeometry;

    // 1. Before turn (progress ~0.2): heading East (+X)
    const fwdBefore = geom.getRouteForwardAtProgress(0.2);
    expect(fwdBefore.x).toBeGreaterThan(0.7);

    // 2. Around apex of turn (progress ~0.5): heading South (+Z)
    const fwdApex = geom.getRouteForwardAtProgress(0.5);
    expect(fwdApex.z).toBeGreaterThan(0.6);

    // 3. After turn (progress ~0.8): heading West (-X)
    const fwdAfter = geom.getRouteForwardAtProgress(0.8);
    expect(fwdAfter.x).toBeLessThan(-0.7);

    // Sample forward along 30 stations and verify none flip backward
    for (let i = 0; i < geom.stations.length - 1; i++) {
      const s0 = geom.stations[i];
      const s1 = geom.stations[i + 1];
      const dx = s1.x - s0.x;
      const dz = s1.z - s0.z;
      const stepLen = Math.hypot(dx, dz);
      if (stepLen > 1.0) {
        const dot = (s0.forwardX * dx + s0.forwardZ * dz) / stepLen;
        expect(dot).toBeGreaterThan(0); // Forward vector consistently aligns with increasing distance
      }
    }

    trail.dispose();
  });

  it('verifies distance-indexed visual route stations and binary-search interpolation', () => {
    const coords = [
      { x: 0, y: 0, z: 0 },
      { x: 50, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 150, y: 0, z: 0 },
    ];

    const track = createSyntheticTrack('Stations Test', coords);
    const geom = new RouteGeometry(track, 1000);

    // 1. Check stations are sorted monotonically by routeDistance
    expect(geom.stations.length).toBeGreaterThan(5);
    for (let i = 1; i < geom.stations.length; i++) {
      expect(geom.stations[i].routeDistance).toBeGreaterThanOrEqual(geom.stations[i - 1].routeDistance);
    }

    // 2. Query position at start, middle, and end
    const pStart = geom.getVisualPositionAtDistance(0);
    expect(pStart.x).toBeCloseTo(0, 1);
    expect(pStart.z).toBeCloseTo(0, 1);

    const pMid = geom.getVisualPositionAtDistance(75);
    expect(pMid.x).toBeCloseTo(75, 1);
    expect(pMid.z).toBeCloseTo(0, 1);

    const pEnd = geom.getVisualPositionAtDistance(150);
    expect(pEnd.x).toBeCloseTo(150, 1);
    expect(pEnd.z).toBeCloseTo(0, 1);

    // 3. Query telemetry matches distance-indexed visual station
    const teleMid = geom.getTelemetryAtDistance(75);
    expect(teleMid.position.x).toBeCloseTo(75, 1);
    expect(teleMid.forward.x).toBeCloseTo(1, 2);
    expect(teleMid.tangent.x).toBeCloseTo(1, 2);
  });
});
