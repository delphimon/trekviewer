import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { terrainFootprint, terrainSizeCapMeters, HIGH_POINT_EDGE_CLEARANCE_M } from '../src/terrain/TerrainFootprint.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { geoToLocalMeters } from '../src/gpx/Coordinates.ts';

const bounds = (widthMeters: number, depthMeters: number, highPoint?: { lat: number; lon: number }) => ({
  minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters, depthMeters, minEle: 1000, maxEle: 4000, elevationSpan: 3000, highPoint });

it('takes the largest of 1.5x the extent and the extent plus 2 km each side', () => {
  expect(terrainFootprint(bounds(1000, 20000))).toEqual({ widthMeters: 5000, depthMeters: 30000 });
});

it('keeps the route high point at least 2.5 km from every edge', () => {
  const route = GPXParser.parse(readFileSync('public/routes/MountRainierViaEmmons.gpx', 'utf8'), 'Rainier');
  const b = route.bounds, size = terrainFootprint(b);
  const peak = geoToLocalMeters(b.highPoint!.lat, b.highPoint!.lon, 0, b.centerLat, b.centerLon, 0);
  expect(size.widthMeters / 2 - Math.abs(peak.x)).toBeGreaterThanOrEqual(HIGH_POINT_EDGE_CLEARANCE_M);
  expect(size.depthMeters / 2 - Math.abs(peak.z)).toBeGreaterThanOrEqual(HIGH_POINT_EDGE_CLEARANCE_M);
  // The old 25% margin left the summit within a few hundred metres of the edge.
  expect(b.widthMeters * 1.5 / 2 - Math.abs(peak.x)).toBeLessThan(HIGH_POINT_EDGE_CLEARANCE_M);
});

it('rounds to 250 m and caps at the DEM tile budget', () => {
  const size = terrainFootprint(bounds(1234, 1234));
  expect(size.widthMeters % 250).toBe(0);
  const cap = terrainSizeCapMeters(46.85);
  expect(terrainFootprint(bounds(99000, 99000)).widthMeters).toBe(cap);
});
