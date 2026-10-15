import { afterEach, expect, it, vi } from 'vitest';
import { createTileUVMapper } from '../src/terrain/TileUV.ts';
import { clampLatitude, degToRad, geoToLocalMeters, latLonToTile, localMetersToGeo, tileBounds } from '../src/gpx/Coordinates.ts';

afterEach(() => vi.restoreAllMocks());
function original(zoom: number, x: number, y: number, centerLat: number, centerLon: number, localX: number, localZ: number) {
  const bounds = tileBounds(x, y, zoom), point = localMetersToGeo(localX, localZ, centerLat, centerLon);
  const sin = Math.sin(degToRad(clampLatitude(point.lat)));
  const tileY = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** zoom;
  return { u: (point.lon - bounds.nw.lon) / (bounds.se.lon - bounds.nw.lon), v: 1 - (tileY - y) };
}

it('preserves exact double-precision UVs across latitudes, zooms, tile edges and clipped coordinates', () => {
  for (const [lat, lon] of [[46.85, -121.75], [0, 0], [-45, 169], [84.9, 179.99], [-84.9, -179.99]]) {
    for (const zoom of [13, 16, 18, 19]) {
      const tile = latLonToTile(lat, lon, zoom), bounds = tileBounds(tile.x, tile.y, zoom);
      const map = createTileUVMapper(zoom, tile.x, tile.y, lat, lon);
      const nw = geoToLocalMeters(bounds.nw.lat, bounds.nw.lon, 0, lat, lon), se = geoToLocalMeters(bounds.se.lat, bounds.se.lon, 0, lat, lon);
      for (const x of [nw.x, se.x, 0, 123.456789, -4321.7654321]) for (const z of [nw.z, se.z, 0, 123.456789, -4321.7654321, -100000, 100000]) {
        const expected = original(zoom, tile.x, tile.y, lat, lon, x, z), actual = map(x, z);
        expect(actual.u).toBe(expected.u); expect(actual.v).toBe(expected.v);
      }
    }
  }
});

it('reuses latitude work for repeated rows while still projecting each new row and longitude', () => {
  const tile = latLonToTile(46.85, -121.75, 19), sine = vi.spyOn(Math, 'sin');
  const map = createTileUVMapper(19, tile.x, tile.y, 46.85, -121.75);
  const first = map(10, 20), second = map(30, 20); map(40, 30); map(50, 20);
  expect(sine).toHaveBeenCalledTimes(2); expect(first.v).toBe(second.v); expect(first.u).not.toBe(second.u);
});

it('recomputes an evicted row exactly and keeps projection contexts independent', () => {
  const tile = latLonToTile(46.85, -121.75, 19), sine = vi.spyOn(Math, 'sin');
  const map = createTileUVMapper(19, tile.x, tile.y, 46.85, -121.75), first = map(10, 0);
  for (let z = 1; z <= 4096; z++) map(10, z);
  sine.mockClear(); expect(map(10, 0)).toEqual(first); expect(sine).toHaveBeenCalledTimes(1);
  const other = createTileUVMapper(18, Math.floor(tile.x / 2), Math.floor(tile.y / 2), -45, 169);
  expect(other(10, 0)).not.toEqual(first); expect(map(10, 0)).toEqual(first);
});
