import { describe, expect, it } from 'vitest';
import { computeFirstPersonStableLODTiles } from '../src/terrain/ImageryLODManager.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

const bounds: GeoBounds = {
  minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7,
  centerLat: 46.85, centerLon: -121.75, minEle: 1400, maxEle: 3000,
  widthMeters: 8000, depthMeters: 11000, elevationSpan: 1600,
};

describe('Quest High stable first-person footprint', () => {
  it('keeps a 360-degree coarse-to-fine hierarchy within 64 patches', () => {
    const candidates = computeFirstPersonStableLODTiles(46.85, -121.75, 19, 64, bounds);
    expect(candidates.length).toBe(61);
    expect(candidates.filter(c => c.zoom === 16)).toHaveLength(25);
    expect(candidates.filter(c => c.zoom === 17)).toHaveLength(16);
    expect(candidates.filter(c => c.zoom === 18)).toHaveLength(4);
    expect(candidates.filter(c => c.zoom === 19)).toHaveLength(16);

    const keys = new Set(candidates.map(c => `${c.zoom}:${c.x}:${c.y}`));
    for (const candidate of candidates.filter(c => c.zoom > 16)) {
      expect(keys.has(`${candidate.zoom - 1}:${Math.floor(candidate.x / 2)}:${Math.floor(candidate.y / 2)}`)).toBe(true);
    }
    for (const parent of candidates.filter(c => c.zoom < 19)) {
      const children = candidates.filter(c =>
        c.zoom === parent.zoom + 1 &&
        Math.floor(c.x / 2) === parent.x && Math.floor(c.y / 2) === parent.y
      );
      expect([0, 4]).toContain(children.length);
    }

    // The same stationary hiker has z16 imagery behind and to both sides,
    // independent of headset orientation or trail azimuth.
    for (const [lat, lon] of [
      [46.856, -121.75], [46.844, -121.75],
      [46.85, -121.741], [46.85, -121.759],
    ]) {
      const tile = latLonToTile(lat, lon, 16);
      expect(keys.has(`16:${tile.x}:${tile.y}`)).toBe(true);
    }
  });
});
