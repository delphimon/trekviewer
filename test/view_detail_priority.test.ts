import { afterEach, expect, it, vi } from 'vitest';
import { computeBroadDetailTiles } from '../src/terrain/BroadDetailSelection.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { PublicImageryProvider } from '../src/terrain/providers/PublicImageryProvider.ts';
import { latLonToTile, tileBounds } from '../src/gpx/Coordinates.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

const center = { lat: 46.85, lon: -121.75 };
const bounds: GeoBounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.85, maxLon: -121.65, centerLat: center.lat, centerLon: center.lon,
  widthMeters: 15000, depthMeters: 11000, minEle: 0, maxEle: 4000, elevationSpan: 4000 };
const key = (tile: { zoom: number; x: number; y: number }) => `${tile.zoom}:${tile.x}:${tile.y}`;
const parent = (point: typeof center) => { const tile = latLonToTile(point.lat, point.lon, 19); return { x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) }; };
afterEach(() => vi.restoreAllMocks());

it('reprioritizes a complete view group already inside the broad core without changing its coverage', () => {
  const core = computeBroadDetailTiles(center, 19, 480, bounds);
  const tile = core.find(tile => tile.zoom === 19 && tile.dist === 0)!;
  const b = tileBounds(tile.x, tile.y, tile.zoom);
  const viewed = { lat: (b.nw.lat + b.se.lat) / 2, lon: (b.nw.lon + b.se.lon) / 2 };
  const tiles = computeBroadDetailTiles(center, 19, 480, bounds, [viewed]);
  expect(tiles.map(key).sort()).toEqual(core.map(key).sort());
  const p = parent(viewed);
  const siblings = tiles.filter(t => t.zoom === 19 && Math.floor(t.x / 2) === p.x && Math.floor(t.y / 2) === p.y);
  expect(siblings).toHaveLength(4);
  expect(siblings.every(t => t.dist < 0)).toBe(true);
});

it('orders current view groups ahead of retained views while preserving their fine coverage and ancestors', () => {
  const current = { lat: 46.866, lon: -121.75 }, retained = { lat: 46.834, lon: -121.75 };
  const tiles = computeBroadDetailTiles(center, 19, 480, bounds, [current, retained]);
  const find = (p: typeof center) => { const t = latLonToTile(p.lat, p.lon, 19); return tiles.find(c => c.zoom === 19 && c.x === t.x && c.y === t.y)!; };
  expect(find(current).dist).toBeLessThan(find(retained).dist);
  expect(find(retained).dist).toBeLessThan(0);
  const keys = new Set(tiles.map(key));
  for (const tile of tiles.filter(t => t.zoom > 17)) {
    expect(keys.has(`${tile.zoom - 1}:${Math.floor(tile.x / 2)}:${Math.floor(tile.y / 2)}`)).toBe(true);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      expect(keys.has(`${tile.zoom}:${Math.floor(tile.x / 2) * 2 + x}:${Math.floor(tile.y / 2) * 2 + y}`)).toBe(true);
    }
  }
  expect(tiles.length).toBeLessThanOrEqual(480);
});

it('starts loading a current off-route view before the concentric core and retained history', () => {
  const current = { lat: 46.866, lon: -121.75 }, retained = { lat: 46.834, lon: -121.75 };
  const loads: { zoom: number; x: number; y: number }[] = [];
  vi.spyOn(ImageryLODManager, 'loadPatchImage').mockImplementation((zoom, x, y) => {
    loads.push({ zoom, x, y });
    return new Promise(() => {});
  });
  const manager = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0, maxConcurrency: 6 });
  try {
    const tiles = computeBroadDetailTiles(center, 19, 480, bounds, [current, retained]);
    (manager as any).reconcileDesiredTiles(tiles, new PublicImageryProvider(), 19);
    expect(loads).toHaveLength(4);
    const first = loads[0], expected = parent(current);
    expect(first.zoom).toBe(19);
    expect(Math.floor(first.x / 2)).toBe(expected.x);
    expect(Math.floor(first.y / 2)).toBe(expected.y);
  } finally { manager.dispose(); }
});

it('loads an already selected view-edge source before a distant retained view after the hiker source', () => {
  const tile = computeBroadDetailTiles(center, 19, 480, bounds).find(t => t.zoom === 19 && t.dist > 0)!;
  const b = tileBounds(tile.x, tile.y, tile.zoom);
  const current = { lat: (b.nw.lat + b.se.lat) / 2, lon: (b.nw.lon + b.se.lon) / 2 };
  const retained = { lat: 46.866, lon: -121.75 };
  const provider = new PublicImageryProvider();
  const loads: string[] = [];
  vi.spyOn(ImageryLODManager, 'loadPatchImage').mockImplementation((zoom, x, y) => {
    loads.push(provider.getTileRequestGroup(zoom, x, y)!);
    return new Promise(() => {});
  });
  const manager = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0, maxConcurrency: 6 });
  try {
    (manager as any).reconcileDesiredTiles(computeBroadDetailTiles(center, 19, 480, bounds, [center, current, retained]), provider, 19);
    const hikerTile = latLonToTile(center.lat, center.lon, 19);
    expect(loads[0]).toBe(provider.getTileRequestGroup(19, hikerTile.x, hikerTile.y));
    expect(loads[1]).toBe(provider.getTileRequestGroup(19, tile.x, tile.y));
    expect(new Set(loads).size).toBe(loads.length);
  } finally { manager.dispose(); }
});
