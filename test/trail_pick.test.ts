import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { trailPointInfo, formatElapsed } from '../src/visualization/TrailPick.ts';

it('reads distance, elevation, grade and elapsed time at a picked trail point', () => {
  const track = GPXParser.parse(readFileSync('public/routes/MountRainierViaEmmons.gpx', 'utf8'), 'Rainier');
  const trail = TrailMesh.create(track);
  const route = trail.routeGeometry;
  const at = route.getTelemetryAtProgress(0.3).position; // a point on the trail, model metres
  const info = trailPointInfo(route, track, at.x, at.z);
  expect(info.progress).toBeCloseTo(0.3, 2);
  expect(info.distanceMeters).toBeCloseTo(0.3 * route.totalDistance, -2);
  expect(info.elevationMeters).toBeCloseTo(route.getElevationAtDistance(info.distanceMeters));
  expect(info.elapsedSeconds).toBeGreaterThan(0);
  expect(Number.isFinite(info.gradePercent)).toBe(true);
  trail.dispose();
});

it('formats elapsed time as hours and minutes', () => {
  expect(formatElapsed(7500)).toBe('2h 05m');
  expect(formatElapsed(840)).toBe('14m');
});
