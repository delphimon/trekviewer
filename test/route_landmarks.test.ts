import { describe, expect, it } from 'vitest';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { resolveRouteLandmarks } from '../src/gpx/RouteLandmarks.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

export const loopXML = `<gpx><wpt lat="47" lon="-122"><ele>100</ele><name>Trailhead (Loop)</name></wpt>
  <trk><name>Loop landmark fixture</name><trkseg>
  <trkpt lat="47" lon="-122"><ele>100</ele></trkpt>
  <trkpt lat="47.001" lon="-122.001"><ele>200</ele></trkpt>
  <trkpt lat="47.004" lon="-122.002"><ele>300</ele></trkpt>
  <trkpt lat="47" lon="-122"><ele>100</ele></trkpt>
  </trkseg></trk></gpx>`;

describe('shared route landmark presentation', () => {
  it('keeps Finish when a day boundary occupies the same final route station', () => {
    const track = GPXParser.parse(loopXML);
    const finish = track.landmarks.find(item => item.type === 'finish')!;
    track.landmarks.unshift({ ...finish, name: 'Day 2 Start', type: 'day_boundary' });
    const endpoints = resolveRouteLandmarks(track).filter(item => item.progress === 1);
    expect(endpoints.map(item => item.type)).toEqual(['day_boundary', 'finish']);
  });

  it('retains the loop finish even when an explicit trailhead occupies both endpoints', () => {
    const track = GPXParser.parse(loopXML);
    const finish = track.landmarks.find(item => item.type === 'finish')!;
    expect(finish).toBeDefined();
    expect(finish.distanceMeters).toBe(track.totalDistance);
    // A nearest-coordinate projection would choose the start of this same loop.
    finish.projection = { progress: 0 } as any;
    const landmarks = resolveRouteLandmarks(track);
    expect(landmarks[0].name).toBe('Trailhead (Loop)');
    expect(landmarks[0].progress).toBe(0);
    expect(landmarks.at(-1)?.type).toBe('finish');
    expect(landmarks.at(-1)?.progress).toBe(1);
  });

  it('preserves nearby named stops and later visits to the same named location', () => {
    const track = { totalDistance: 1000, minElevation: 0, points: [], landmarks: [], waypoints: [
      { name: 'Camp (Upper)', lat: 47, lon: -122, distanceMeters: 100 },
      { name: 'Camp (Lower)', lat: 47.00001, lon: -122, distanceMeters: 120 },
      { name: 'Camp (Upper)', lat: 47, lon: -122, distanceMeters: 800 },
      { name: 'Camp (Upper)', lat: 47, lon: -122, distanceMeters: 100 },
    ] } as unknown as TrackStats;
    const landmarks = resolveRouteLandmarks(track);
    expect(landmarks.map(item => [item.name, item.progress])).toEqual([
      ['Camp (Upper)', 0.1], ['Camp (Lower)', 0.12], ['Camp (Upper)', 0.8],
    ]);
  });

  it('prefers a derived stop station over an ambiguous projection, and retains explicit elevation', () => {
    const track = { totalDistance: 1000, minElevation: 0, points: [], waypoints: [], landmarks: [
      { name: 'Day 2 Start', type: 'day_boundary', lat: 47, lon: -122, ele: 42,
        isDerivedLandmark: true, distanceMeters: 700, projection: { progress: 0.1 } },
    ] } as unknown as TrackStats;
    const [landmark] = resolveRouteLandmarks(track);
    expect(landmark.progress).toBe(0.7);
    expect(landmark.ele).toBe(42);
  });

  it('uses finite projections or nearest track distance without mutating source metadata', () => {
    const track = GPXParser.parse(loopXML);
    track.waypoints = [{ name: 'Midpoint', lat: 47.001, lon: -122.001, ele: 123, projection: { progress: NaN } as any }];
    track.landmarks = [];
    const [item] = resolveRouteLandmarks(track);
    expect(item.progress).toBeCloseTo(track.points[1].distanceFromStart / track.totalDistance);
    expect(item.ele).toBe(123);
    expect(track.waypoints[0].distanceMeters).toBeUndefined();
    expect(track.waypoints[0].projection?.progress).toBeNaN();
  });
});
