import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { TrekSession } from '../src/core/TrekSession.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GPXPoint, TrackStats } from '../src/gpx/TrackTypes.ts';

function createSyntheticTrack(points: GPXPoint[]): TrackStats {
  const minEle = Math.min(...points.map((p) => p.ele));
  const maxEle = Math.max(...points.map((p) => p.ele));
  const totalDist = points[points.length - 1].distanceFromStart;

  return {
    name: 'Synthetic Test Track',
    totalDistance: totalDist,
    elevationGain: 100,
    elevationLoss: 50,
    minElevation: minEle,
    maxElevation: maxEle,
    movingTime: 3600,
    totalPlaybackSeconds: 3600,
    avgSpeed: 4.5,
    maxSpeed: 8.0,
    bounds: {
      minLat: 46.8,
      maxLat: 46.9,
      minLon: -121.8,
      maxLon: -121.7,
      minEle,
      maxEle,
      centerLat: 46.85,
      centerLon: -121.75,
      widthMeters: 5000,
      depthMeters: 5000,
      elevationSpan: maxEle - minEle,
    },
    points,
    segments: [
      {
        points,
        distance: totalDist,
        elevationGain: 100,
        elevationLoss: 50,
        startIndex: 0,
        endIndex: points.length - 1,
      },
    ],
    waypoints: [],
    landmarks: [],
    warnings: [],
  };
}

describe('Stage T3: Solid Route Color Default & Spatially Smoothed Telemetry (Sections 14-19, 47)', () => {
  it('initializes TrekSession and TrailMesh with solid route color default (Section 14)', () => {
    // 1. Authoritative TrekSession default
    const session = new TrekSession();
    expect(session.getState().trailColorMode).toBe('solid');

    // 2. Build simple track
    const points: GPXPoint[] = [];
    for (let i = 0; i < 20; i++) {
      points.push({
        lat: 46.85 + i * 0.001,
        lon: -121.75,
        ele: 1500 + i * 5,
        distanceFromStart: i * 20,
        elapsedSeconds: i * 15,
        playbackSeconds: i * 15,
        grade: 10,
        speed: 1.33,
        index: i,
      });
    }
    const track = createSyntheticTrack(points);

    // 3. TrailMesh initial vertex colors must be solid high-contrast cyan (#38bdf8)
    const result = TrailMesh.create(track);
    const geo = result.trailMesh.geometry;
    const colorAttr = geo.attributes.color as THREE.BufferAttribute;
    expect(colorAttr).toBeDefined();

    const expected = new THREE.Color(0x38bdf8);

    for (let i = 0; i < colorAttr.count; i++) {
      expect(colorAttr.getX(i)).toBeCloseTo(expected.r, 2);
      expect(colorAttr.getY(i)).toBeCloseTo(expected.g, 2);
      expect(colorAttr.getZ(i)).toBeCloseTo(expected.b, 2);
    }
  });

  it('rejects high-frequency GPS elevation noise in smoothed grade and captures sustained climbs (Section 16, 47)', () => {
    // Construct synthetic track:
    // 0m to 300m: Flat ground with high-frequency GPS jitter: elevation oscillates +-2m every 3m (slope +-66%!)
    // 300m to 600m: Sustained 30% climb with continuous elevation increase
    const points: GPXPoint[] = [];
    const stepDist = 3.0; // 3 meters per sample
    const numPoints = 200; // 600m total distance

    for (let i = 0; i <= numPoints; i++) {
      const d = i * stepDist;
      let ele = 1000;
      if (d <= 300) {
        // High-frequency alternating noise
        ele += (i % 2 === 0 ? 2.0 : -2.0);
      } else {
        // Sustained 30% slope (+30m per 100m)
        ele += (d - 300) * 0.30;
      }

      // Raw grade between adjacent samples fluctuates violently in first 300m
      let rawGrade = 0;
      if (i > 0) {
        const prevEle = points[i - 1].ele;
        rawGrade = ((ele - prevEle) / stepDist) * 100;
      }

      points.push({
        lat: 46.85 + i * 0.0001,
        lon: -121.75,
        ele,
        distanceFromStart: d,
        elapsedSeconds: i * 2,
        playbackSeconds: i * 2,
        grade: rawGrade,
        speed: 1.5,
        index: i,
      });
    }

    const track = createSyntheticTrack(points);
    const routeGeom = new RouteGeometry(track, track.minElevation);

    // 1. Verify raw grade oscillates wildly in first 300m
    const rawGradesInNoisySection = points.slice(1, 80).map((p) => p.grade!);
    const hasPositiveSpikes = rawGradesInNoisySection.some((g) => g > 50);
    const hasNegativeSpikes = rawGradesInNoisySection.some((g) => g < -50);
    expect(hasPositiveSpikes).toBe(true);
    expect(hasNegativeSpikes).toBe(true);

    // 2. Verify getSmoothedGradeAtDistance is smooth (~0%) in the noisy section
    for (let d = 50; d <= 250; d += 25) {
      const smoothedGrade = routeGeom.getSmoothedGradeAtDistance(d, 70);
      // Net elevation difference across 70m of +-2m oscillations is <= 4m / 70m = ~5.7% grade
      expect(Math.abs(smoothedGrade)).toBeLessThan(8.0); // Within Band 0 (Gentle 0-8%)
    }

    // 3. Verify getSmoothedGradeAtDistance captures the sustained 30% climb
    for (let d = 370; d <= 550; d += 25) {
      const smoothedGrade = routeGeom.getSmoothedGradeAtDistance(d, 70);
      expect(smoothedGrade).toBeGreaterThanOrEqual(25.0);
      expect(smoothedGrade).toBeLessThanOrEqual(35.0);
    }

    // 4. Test ribbon vertex colors in Grade mode
    const trail = TrailMesh.create(track);
    trail.setColorMode('grade');
    const colorAttr = trail.trailMesh.geometry.attributes.color as THREE.BufferAttribute;

    // Check vertex colors at progress ~0.25 (dist ~150m, noisy flat section) -> Must be Band 0 Green (#10b981)
    const idxNoisy = Math.floor(colorAttr.count * 0.25);
    const green = new THREE.Color(0x10b981);
    expect(colorAttr.getX(idxNoisy)).toBeCloseTo(green.r, 2);
    expect(colorAttr.getY(idxNoisy)).toBeCloseTo(green.g, 2);
    expect(colorAttr.getZ(idxNoisy)).toBeCloseTo(green.b, 2);

    // Check vertex colors at progress ~0.80 (dist ~480m, steep climb section) -> Must be Band 3 Red (#ef4444)
    const idxSteep = Math.floor(colorAttr.count * 0.80);
    const red = new THREE.Color(0xef4444);
    expect(colorAttr.getX(idxSteep)).toBeCloseTo(red.r, 2);
    expect(colorAttr.getY(idxSteep)).toBeCloseTo(red.g, 2);
    expect(colorAttr.getZ(idxSteep)).toBeCloseTo(red.b, 2);
  });

  it('smooths GPS pace/speed using median window and rejects isolated speed spikes (Section 17, 47)', () => {
    // Construct synthetic track:
    // Normal hiking speed: 1.2 m/s (~4.3 km/h, Band 2, Yellow #eab308)
    // Points 40-42: GPS glitch with sudden 0.1 m/s (stop) and 6.0 m/s (speed jump)
    // Sustained sprint at 400m-600m: 2.5 m/s (9.0 km/h, Band 4, Cyan #06b6d4)
    const points: GPXPoint[] = [];
    const stepDist = 5.0; // 5m per point
    const numPoints = 120; // 600m total

    let cumTime = 0;
    for (let i = 0; i <= numPoints; i++) {
      const d = i * stepDist;
      let spd = 1.2; // default 1.2 m/s
      if (i === 30) spd = 0.1; // single drop glitch
      if (i === 31) spd = 7.0; // single spike glitch
      if (d >= 400) spd = 2.5; // sustained fast pace

      const dt = stepDist / spd;
      cumTime += dt;

      points.push({
        lat: 46.85 + i * 0.0001,
        lon: -121.75,
        ele: 1200,
        distanceFromStart: d,
        elapsedSeconds: cumTime,
        playbackSeconds: cumTime,
        grade: 0,
        speed: spd,
        index: i,
      });
    }

    const track = createSyntheticTrack(points);
    const routeGeom = new RouteGeometry(track, track.minElevation);

    // 1. Raw point 31 has 7.0 m/s spike, point 30 has 0.1 m/s drop
    expect(points[30].speed).toBe(0.1);
    expect(points[31].speed).toBe(7.0);

    // 2. Smoothed speed at distance 150m (near the glitch) must ignore single-sample spikes via median
    const smoothedAtGlitch = routeGeom.getSmoothedSpeedAtDistance(150, 150);
    expect(smoothedAtGlitch).toBeCloseTo(1.2, 1);

    // 3. Smoothed speed at distance 500m must reflect the sustained 2.5 m/s pace
    const smoothedAtSprint = routeGeom.getSmoothedSpeedAtDistance(500, 150);
    expect(smoothedAtSprint).toBeCloseTo(2.5, 1);

    // 4. Test ribbon vertex colors in Speed mode
    const trail = TrailMesh.create(track);
    trail.setColorMode('speed');
    const colorAttr = trail.trailMesh.geometry.attributes.color as THREE.BufferAttribute;

    // At progress ~0.25 (dist ~150m, steady hiking 1.2 m/s = 4.3 km/h) -> Band 2 Yellow (#eab308)
    const idxSteady = Math.floor(colorAttr.count * 0.25);
    const yellow = new THREE.Color(0xeab308);
    expect(colorAttr.getX(idxSteady)).toBeCloseTo(yellow.r, 2);
    expect(colorAttr.getY(idxSteady)).toBeCloseTo(yellow.g, 2);
    expect(colorAttr.getZ(idxSteady)).toBeCloseTo(yellow.b, 2);

    // At progress ~0.85 (dist ~510m, running pace 2.5 m/s = 9.0 km/h) -> Band 4 Cyan (#06b6d4)
    const idxFast = Math.floor(colorAttr.count * 0.85);
    const cyan = new THREE.Color(0x06b6d4);
    expect(colorAttr.getX(idxFast)).toBeCloseTo(cyan.r, 2);
    expect(colorAttr.getY(idxFast)).toBeCloseTo(cyan.g, 2);
    expect(colorAttr.getZ(idxFast)).toBeCloseTo(cyan.b, 2);
  });

  it('filters short transient band deviations with minimum run length (Section 18)', () => {
    // 20 stations, spaced 10 meters apart (0 to 190m)
    const n = 20;
    const dists = new Float32Array(n);
    for (let i = 0; i < n; i++) dists[i] = i * 10;

    // Test Case: Band 1 with an isolated 2-station dip to Band 0 (20m length < 60m min run length)
    const rawBands = new Int8Array(n);
    rawBands.fill(1);
    rawBands[7] = 0;
    rawBands[8] = 0; // length from dists[7] (70m) to dists[8] (80m) is 10m

    const filtered = TrailMesh.filterBandsRunLength(rawBands, dists, 60.0);
    // Transient dip should be completely smoothed out to Band 1
    for (let i = 0; i < n; i++) {
      expect(filtered[i]).toBe(1);
    }

    // Test Case: Sustained change from Band 1 (0 to 80m) to Band 3 (90 to 190m = 100m >= 60m)
    const sustainedBands = new Int8Array(n);
    sustainedBands.fill(1);
    for (let i = 9; i < n; i++) sustainedBands[i] = 3;

    const filteredSustained = TrailMesh.filterBandsRunLength(sustainedBands, dists, 60.0);
    // Both sustained sections must be preserved
    expect(filteredSustained[0]).toBe(1);
    expect(filteredSustained[8]).toBe(1);
    expect(filteredSustained[9]).toBe(3);
    expect(filteredSustained[19]).toBe(3);
  });

  it('cycles trail color modes in required order: Solid -> Grade -> Pace -> Elevation -> Solid (Section 15)', () => {
    const points: GPXPoint[] = [
      { lat: 46.85, lon: -121.75, ele: 1500, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
      { lat: 46.86, lon: -121.75, ele: 1600, distanceFromStart: 1000, elapsedSeconds: 600, playbackSeconds: 600, index: 1 },
    ];
    const track = createSyntheticTrack(points);
    const trail = TrailMesh.create(track);

    // Initial state is solid
    const geo = trail.trailMesh.geometry;
    let colorAttr = geo.attributes.color as THREE.BufferAttribute;
    const solidColor = new THREE.Color(0x38bdf8);
    expect(colorAttr.getX(0)).toBeCloseTo(solidColor.r, 2);

    // 1. Solid -> Grade
    trail.setColorMode('grade');
    colorAttr = geo.attributes.color as THREE.BufferAttribute;
    expect(colorAttr).toBeDefined();

    // 2. Grade -> Speed
    trail.setColorMode('speed');
    colorAttr = geo.attributes.color as THREE.BufferAttribute;
    expect(colorAttr).toBeDefined();

    // 3. Speed -> Elevation
    trail.setColorMode('elevation');
    colorAttr = geo.attributes.color as THREE.BufferAttribute;
    expect(colorAttr).toBeDefined();

    // 4. Elevation -> Solid
    trail.setColorMode('solid');
    colorAttr = geo.attributes.color as THREE.BufferAttribute;
    expect(colorAttr.getX(0)).toBeCloseTo(solidColor.r, 2);
  });
});
