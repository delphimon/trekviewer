import { expect, it } from 'vitest';
import { computeBroadDetailTiles } from '../src/terrain/BroadDetailSelection.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import { planTerrainTiles } from '../src/terrain/TerrainTileLayout.ts';
import { QUALITY_PROFILES, terrainDetailPolicy } from '../src/terrain/QualityProfile.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

const center = { lat: 46.85, lon: -121.75 };
const bounds: GeoBounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.85, maxLon: -121.65, centerLat: center.lat, centerLon: center.lon, minEle: 0, maxEle: 4000, elevationSpan: 4000, widthMeters: 15000, depthMeters: 11000 };

it('retains a broad all-direction finest footprint with complete fallback levels', () => {
  const tiles = computeBroadDetailTiles(center, 19, 480, bounds);
  expect(tiles).toHaveLength(293);
  expect(tiles.filter(t => t.zoom === 19)).toHaveLength(144);
  expect(tiles.filter(t => t.zoom === 18)).toHaveLength(100);
  expect(tiles.filter(t => t.zoom === 17)).toHaveLength(49);
  const keys = new Set(tiles.map(t => `${t.zoom}:${t.x}:${t.y}`));
  for (const t of tiles.filter(t => t.zoom > 17)) {
    const px = Math.floor(t.x / 2), py = Math.floor(t.y / 2);
    expect(keys.has(`${t.zoom - 1}:${px}:${py}`)).toBe(true);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) expect(keys.has(`${t.zoom}:${px * 2 + x}:${py * 2 + y}`)).toBe(true);
  }
  for (const lat of [center.lat - .0015, center.lat, center.lat + .0015]) for (const lon of [center.lon - .002, center.lon, center.lon + .002]) {
    const t = latLonToTile(lat, lon, 19); expect(keys.has(`19:${t.x}:${t.y}`)).toBe(true);
  }
});

it('keeps finest detail on overscanned slopes above, below, and beside the central hit', () => {
  const points = [{ lat: 46.865, lon: center.lon }, { lat: 46.835, lon: center.lon }, { lat: center.lat, lon: -121.77 }, { lat: center.lat, lon: -121.73 }];
  const tiles = computeBroadDetailTiles(center, 19, 480, bounds, points);
  const keys = new Set(tiles.map(t => `${t.zoom}:${t.x}:${t.y}`));
  for (const point of points) {
    const t = latLonToTile(point.lat, point.lon, 19); expect(keys.has(`19:${t.x}:${t.y}`)).toBe(true);
  }
  expect(tiles.length).toBeLessThanOrEqual(480);
});

it('covers all view targets before spending the remaining budget on surrounding guard tiles', () => {
  const points = Array.from({ length: 10 }, (_, i) => ({ lat: center.lat + Math.sin(i * Math.PI / 5) * .025, lon: center.lon + Math.cos(i * Math.PI / 5) * .04 }));
  const tiles = computeBroadDetailTiles(center, 19, 416, bounds, points);
  const keys = new Set(tiles.map(t => `${t.zoom}:${t.x}:${t.y}`));
  for (const point of points) { const t = latLonToTile(point.lat, point.lon, 19); expect(keys.has(`19:${t.x}:${t.y}`)).toBe(true); }
  expect(tiles.length).toBeLessThanOrEqual(416);
});

it.each([13, 16, 19])('respects provider zoom %i, terrain bounds, and the resident budget', zoom => {
  const smallBounds = { ...bounds, minLat: 46.849, maxLat: 46.851, minLon: -121.751, maxLon: -121.749 };
  const tiles = computeBroadDetailTiles(center, zoom, 416, smallBounds, [center]);
  expect(tiles.length).toBeGreaterThan(0); expect(tiles.length).toBeLessThanOrEqual(416);
  expect(tiles.every(t => t.zoom <= zoom && t.zoom >= 13)).toBe(true);
  expect(new Set(tiles.map(t => `${t.zoom}:${t.x}:${t.y}`)).size).toBe(tiles.length);
});

it('plans 5m DEM refinement at the center and multiple view-edge terrain hits', () => {
  const policy = terrainDetailPolicy(QUALITY_PROFILES['quest-high']);
  const anchors = [{ x: 0, z: -2500 }, { x: 0, z: 2500 }, { x: 2500, z: 0 }];
  const plan = planTerrainTiles({ parent: { width: 12000, depth: 12000, segmentsX: 200, segmentsZ: 200 }, focusX: 0, focusZ: 0, additionalFocus: anchors, parentCellsPerTile: 8, ...policy });
  for (const p of [{ x: 0, z: 0 }, ...anchors]) expect(plan.tiles.some(t => t.bounds.minX <= p.x && t.bounds.maxX >= p.x && t.bounds.minZ <= p.z && t.bounds.maxZ >= p.z)).toBe(true);
  expect(plan.tiles.every(t => t.width / t.segmentsX <= 5 && t.depth / t.segmentsZ <= 5)).toBe(true);
  expect(plan.vertexCount).toBeLessThanOrEqual(policy.maxVertices); expect(plan.tiles.length).toBeLessThanOrEqual(policy.maxTiles);
  expect(terrainDetailPolicy(QUALITY_PROFILES['quest-balanced']).targetCellM).toBe(25);
});

it('keeps the hiker detailed when many view anchors tie at tile boundaries', () => {
  const additionalFocus = Array.from({ length: 25 }, (_, i) => ({ x: -4320 + (i % 5) * 480, z: -4320 + Math.floor(i / 5) * 480 }));
  const plan = planTerrainTiles({ parent: { width: 9600, depth: 9600, segmentsX: 160, segmentsZ: 160 }, focusX: 0, focusZ: 0, additionalFocus, radiusM: 5000, targetCellM: 5, parentCellsPerTile: 8, maxTiles: 4, maxVertices: 40000 });
  expect(plan.tiles).toHaveLength(4);
  expect(plan.tiles.every(t => t.bounds.minX <= 0 && t.bounds.maxX >= 0 && t.bounds.minZ <= 0 && t.bounds.maxZ >= 0)).toBe(true);
});
