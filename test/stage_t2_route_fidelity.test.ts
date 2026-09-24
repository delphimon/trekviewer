import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  resamplePathXZ,
  filterGPSSpikesXZ,
  smoothPathXZ,
  generateVisualRouteCurve,
  distanceXZ,
} from '../src/visualization/VisualRoute.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import type { TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';

describe('Stage T2: Route Fidelity, Terrain Alignment & GPS Smoothing', () => {
  describe('VisualRoute Algorithmic Correctness', () => {
    it('resamples path evenly in X/Z while strictly preserving start and end coordinates', () => {
      const points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(100, 0, 0),
        new THREE.Vector3(100, 0, 100),
      ];

      const resampled = resamplePathXZ(points, 10.0);
      expect(resampled.length).toBeGreaterThan(15);
      expect(resampled[0].x).toBe(0);
      expect(resampled[0].z).toBe(0);
      expect(resampled[resampled.length - 1].x).toBe(100);
      expect(resampled[resampled.length - 1].z).toBe(100);

      // Verify consecutive point distances are approximately 10m
      for (let i = 0; i < resampled.length - 2; i++) {
        const d = distanceXZ(resampled[i], resampled[i + 1]);
        expect(d).toBeCloseTo(10.0, 1);
      }
    });

    it('suppresses isolated lateral GPS spikes without altering legitimate switchbacks', () => {
      // 1. Synthetic track with an isolated 20m lateral spike
      const spikedTrack = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(10, 0, 0),
        new THREE.Vector3(20, 0, 0),
        new THREE.Vector3(30, 0, 25), // Isolated spike 25m off to the side!
        new THREE.Vector3(40, 0, 0),  // Returns immediately to previous heading
        new THREE.Vector3(50, 0, 0),
        new THREE.Vector3(60, 0, 0),
      ];

      const debiased = filterGPSSpikesXZ(spikedTrack, 12.0);
      // The spiked point (index 3) must be pulled back close to the chord (z ~ 0)
      expect(debiased[3].z).toBeLessThan(5.0);

      // 2. Genuine alpine switchback (direction reversal that continues on new heading)
      const switchbackTrack = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(10, 0, 0),
        new THREE.Vector3(20, 0, 0),
        new THREE.Vector3(25, 0, 15), // Switchback apex turn
        new THREE.Vector3(15, 0, 18), // Continues backward along new heading
        new THREE.Vector3(5, 0, 20),
        new THREE.Vector3(-5, 0, 22),
      ];

      const preserved = filterGPSSpikesXZ(switchbackTrack, 12.0);
      // Switchback apex must NOT be erased!
      expect(preserved[3].z).toBeCloseTo(15.0, 1);
      expect(preserved[3].x).toBeCloseTo(25.0, 1);
    });

    it('smooths high-frequency GPS jitter while enforcing the maximum lateral deviation corridor', () => {
      // Create a straight path with alternating ±4m lateral jitter
      const jitteryPath: THREE.Vector3[] = [];
      for (let i = 0; i < 20; i++) {
        const x = i * 10;
        const jitterZ = (i % 2 === 0 ? 1 : -1) * 4.0;
        jitteryPath.push(new THREE.Vector3(x, 0, jitterZ));
      }

      const smoothed = smoothPathXZ(jitteryPath, 30.0, 5.0);

      // Verify jitter is substantially dampened
      for (let i = 2; i < smoothed.length - 2; i++) {
        expect(Math.abs(smoothed[i].z)).toBeLessThan(2.5);
      }

      // Verify maximum lateral deviation corridor is strictly respected
      for (let i = 0; i < smoothed.length; i++) {
        const orig = jitteryPath[i];
        const dist = Math.hypot(smoothed[i].x - orig.x, smoothed[i].z - orig.z);
        expect(dist).toBeLessThanOrEqual(5.01);
      }
    });
  });

  describe('Dense Terrain Reprojection & Vertical Alignment (Sections 5, 10, 13)', () => {
    // Highly curved synthetic terrain with peaks, valleys, and sharp ridges
    const elevationSampler = (x: number, z: number): number => {
      const ridge = Math.abs(x * 0.5 - z * 0.3) < 40 ? 80 : 0;
      return 1500 + 250 * Math.sin(x / 120) + 180 * Math.cos(z / 90) + ridge;
    };

    function createSyntheticTrack(): TrackStats {
      const points: GPXPoint[] = [];
      let totalDist = 0;
      let prevLoc: { x: number; z: number } | null = null;

      // Track traversing ridge, valley, switchback, and steep slope
      const waypoints = [
        { x: -300, z: -300 }, // start
        { x: -150, z: -100 }, // steep ascent
        { x: 0, z: 50 },      // ridge crossing
        { x: 100, z: 200 },   // switchback apex 1
        { x: -50, z: 280 },   // switchback traverse
        { x: 150, z: 380 },   // switchback apex 2
        { x: 300, z: 400 },   // finish
      ];

      for (let i = 0; i < waypoints.length; i++) {
        const p = waypoints[i];
        if (prevLoc) {
          totalDist += Math.hypot(p.x - prevLoc.x, p.z - prevLoc.z);
        }
        prevLoc = p;
        points.push({
          lat: 46.85 + p.z / 111320,
          lon: -121.75 + p.x / (111320 * Math.cos((46.85 * Math.PI) / 180)),
          ele: elevationSampler(p.x, p.z),
          time: new Date(Date.now() + i * 60000),
          distanceFromStart: totalDist,
          grade: 10,
          index: i,
          elapsedSeconds: i * 60,
          playbackSeconds: i * 60,
        });
      }

      return {
        name: 'Synthetic Alpine Test Track',
        totalDistance: totalDist,
        elevationGain: 600,
        elevationLoss: 200,
        minElevation: 1200,
        maxElevation: 2200,
        bounds: {
          minLat: 46.84,
          maxLat: 46.86,
          minLon: -121.76,
          maxLon: -121.74,
          minEle: 1200,
          maxEle: 2200,
          centerLat: 46.85,
          centerLon: -121.75,
          widthMeters: 2000,
          depthMeters: 2000,
          elevationSpan: 1000,
        },
        points,
        segments: [
          {
            points,
            distance: totalDist,
            elevationGain: 600,
            elevationLoss: 200,
            startIndex: 0,
            endIndex: points.length - 1,
          },
        ],
        waypoints: [],
        landmarks: [],
        avgSpeed: 1.2,
        maxSpeed: 2.5,
        movingTime: 3600,
        totalPlaybackSeconds: 3600,
        timingType: 'recorded',
        warnings: [],
      };
    }

    const testTrack = createSyntheticTrack();

    it('strictly satisfies routeY = elevationSampler(x, z) * exag + presentationOffset across 1x, 1.5x, 2x, 3x tabletop', () => {
      const exaggerations = [1.0, 1.5, 2.0, 3.0];

      for (const exag of exaggerations) {
        const trailResult = TrailMesh.create(testTrack, elevationSampler, 1200, exag);
        const geo = trailResult.trailMesh.geometry;
        const posAttr = geo.attributes.position;
        const count = posAttr.count;

        // Tabletop presentation offset
        const maxDim = Math.max(testTrack.bounds.widthMeters, testTrack.bounds.depthMeters);
        const expectedOffset = Math.max(2.5, 2.0 * Math.max(1.0, maxDim / 4000));

        // Sample every ribbon segment centerline point
        for (let i = 0; i < count; i += 2) {
          const lx = posAttr.getX(i);
          const ly = posAttr.getY(i);
          const lz = posAttr.getZ(i);

          const rx = posAttr.getX(i + 1);
          const ry = posAttr.getY(i + 1);
          const rz = posAttr.getZ(i + 1);

          const cx = (lx + rx) * 0.5;
          const cy = (ly + ry) * 0.5;
          const cz = (lz + rz) * 0.5;

          // Terrain elevation at exact centerline (cx, cz)
          const expectedTerrainY = elevationSampler(cx, cz);
          const expectedRouteY = expectedTerrainY * exag + expectedOffset;

          // Assert zero deviation: spline interpolation never cuts through or hovers!
          expect(cy).toBeCloseTo(expectedRouteY, 1);
        }

        trailResult.dispose();
      }
    });

    it('strictly satisfies routeY = elevationSampler(x, z) * 1.0 + 0.08 in 1:1 first-person mode', () => {
      const trailResult = TrailMesh.create(testTrack, elevationSampler, 1200, 1.0);
      trailResult.setViewMode('first-person');

      const geo = trailResult.trailMesh.geometry;
      const posAttr = geo.attributes.position;
      const count = posAttr.count;

      const expectedOffset = 0.08; // 8cm low-profile offset (Section 11)

      for (let i = 0; i < count; i += 2) {
        const lx = posAttr.getX(i);
        const ly = posAttr.getY(i);
        const lz = posAttr.getZ(i);

        const rx = posAttr.getX(i + 1);
        const ry = posAttr.getY(i + 1);
        const rz = posAttr.getZ(i + 1);

        const cx = (lx + rx) * 0.5;
        const cy = (ly + ry) * 0.5;
        const cz = (lz + rz) * 0.5;

        const expectedTerrainY = elevationSampler(cx, cz);
        const expectedRouteY = expectedTerrainY * 1.0 + expectedOffset;

        expect(cy).toBeCloseTo(expectedRouteY, 1);
      }

      trailResult.dispose();
    });

    it('correctly updates vertex elevations when setVerticalExaggeration is called', () => {
      const trailResult = TrailMesh.create(testTrack, elevationSampler, 1200, 1.0);
      const geo = trailResult.trailMesh.geometry;
      const posAttr = geo.attributes.position;

      // Update to 2.5x exaggeration
      trailResult.setVerticalExaggeration(2.5);

      const maxDim = Math.max(testTrack.bounds.widthMeters, testTrack.bounds.depthMeters);
      const expectedOffset = Math.max(2.5, 2.0 * Math.max(1.0, maxDim / 4000));

      for (let i = 0; i < posAttr.count; i += 2) {
        const lx = posAttr.getX(i);
        const ly = posAttr.getY(i);
        const lz = posAttr.getZ(i);

        const rx = posAttr.getX(i + 1);
        const ry = posAttr.getY(i + 1);
        const rz = posAttr.getZ(i + 1);

        const cx = (lx + rx) * 0.5;
        const cy = (ly + ry) * 0.5;
        const cz = (lz + rz) * 0.5;

        const expectedTerrainY = elevationSampler(cx, cz);
        const expectedRouteY = expectedTerrainY * 2.5 + expectedOffset;

        expect(cy).toBeCloseTo(expectedRouteY, 1);
      }

      trailResult.dispose();
    });

    it('projects hiker beacon position directly onto the sampled terrain surface', () => {
      const trailResult = TrailMesh.create(testTrack, elevationSampler, 1200, 1.5);
      const maxDim = Math.max(testTrack.bounds.widthMeters, testTrack.bounds.depthMeters);
      const expectedOffset = Math.max(2.5, 2.0 * Math.max(1.0, maxDim / 4000));

      for (let prog = 0; prog <= 1.0; prog += 0.2) {
        const res = trailResult.updateHikerPosition(prog);
        const hx = res.position.x;
        const hy = res.position.y;
        const hz = res.position.z;

        const expectedTerrainY = elevationSampler(hx, hz);
        const expectedHikerY = expectedTerrainY * 1.5 + expectedOffset;

        expect(hy).toBeCloseTo(expectedHikerY, 1);
      }

      trailResult.dispose();
    });
  });
});
