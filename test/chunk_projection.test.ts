import { expect, it } from 'vitest';
import { TextureProvider, type TileGridBounds } from '../src/terrain/TextureProvider.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { localMetersToGeo } from '../src/gpx/Coordinates.ts';

const referenceUV = (lat: number, lon: number, grid: TileGridBounds) => {
  const n = 2 ** grid.zoom;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { u: Math.max(0, Math.min(1, (x - grid.tileXMin) / grid.numTilesX)),
    v: Math.max(0, Math.min(1, 1 - (y - grid.tileYMin) / grid.numTilesY)) };
};
const grid: TileGridBounds = { zoom: 13, tileXMin: 1200, tileXMax: 1203, tileYMin: 2800, tileYMax: 2802, numTilesX: 4, numTilesY: 3 };

it('reuses only exact latitude projection across current zoom, bounds, longitude and grid edits', () => {
  const edited = { ...grid };
  for (const lat of [46.8, 46.8, -46.8, -0, 0, -85, 85, -90, 90, Infinity, -Infinity, NaN, NaN, 46.8]) {
    for (const lon of [-180, -123.8, 0, 180, Infinity, NaN]) {
      expect(TextureProvider.getUVForGeo(lat, lon, grid)).toEqual(referenceUV(lat, lon, grid));
      edited.zoom = 19; edited.tileXMin += 3; edited.tileYMin -= 2; edited.numTilesY++;
      expect(TextureProvider.getUVForGeo(lat, lon, edited)).toEqual(referenceUV(lat, lon, edited));
    }
  }
});

it.each([true, false])('retains exact full-grid imagery UVs with nonzero chunk offsets (initial map: %s)', initialMap => {
  const options = { localGrid: { width: 2, height: 2, zoom: 0, tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0,
    numTilesX: 1, numTilesY: 1, data: new Float32Array([100, 200, 300, 400]), tileValidity: new Uint8Array([1]),
    minElevation: 100, maxElevation: 400, isRealDEM: true },
    centerLat: 46.81, centerLon: -123.79, referenceCenterLat: 46.8, referenceCenterLon: -123.8,
    terrainBaseElevation: 0, radiusMeters: 377, segments: 24, tileGrid: initialMap ? grid : undefined };
  const chunk = new LocalTerrainChunk(options);
  try {
    if (!initialMap) chunk.setMapTexture(null, grid);
    for (const current of [grid, { ...grid, zoom: 14, tileXMin: 2500, tileYMin: 5600 }]) {
      chunk.setMapTexture(null, current);
      const p = chunk.geometry.attributes.position, uv = chunk.geometry.attributes.uv;
      for (let i = 0; i < p.count; i++) {
        const geo = localMetersToGeo(chunk.localCenter.x + p.getX(i), chunk.localCenter.z + p.getZ(i), 46.8, -123.8);
        const expected = referenceUV(geo.lat, geo.lon, current);
        expect(uv.getX(i)).toBe(Math.fround(expected.u)); expect(uv.getY(i)).toBe(Math.fround(expected.v));
      }
    }
  } finally { chunk.dispose(); }
});
