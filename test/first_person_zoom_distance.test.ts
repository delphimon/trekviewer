import { expect, it } from 'vitest';
import { zoomForViewDistance, computeBroadDetailTiles } from '../src/terrain/BroadDetailSelection.ts';

it('picks zoom from view distance: full within 300 m, one level per doubling', () => {
  expect([100, 600, 2400, 9600].map(d => zoomForViewDistance(d, 19))).toEqual([19, 18, 16, 14]);
  expect(zoomForViewDistance(300, 19)).toBe(19);
  expect(zoomForViewDistance(1e7, 19)).toBe(13); // never below the base composite level
  expect(zoomForViewDistance(5000, 17)).toBe(13);
});

it('promotes a far view hit at its distance zoom instead of zoom 19', () => {
  const bounds = { minLat: 46.7, maxLat: 47.0, minLon: -121.9, maxLon: -121.5, centerLat: 46.85, centerLon: -121.7,
    widthMeters: 30000, depthMeters: 30000, minEle: 0, maxEle: 4000, elevationSpan: 4000 };
  const center = { lat: 46.85, lon: -121.7 };
  const far = { lat: 46.93, lon: -121.62, zoom: zoomForViewDistance(9600, 19) };
  const tiles = computeBroadDetailTiles(center, 19, 400, bounds, [far]);
  // The far hit gets z14 coverage, and no z19 tiles are spent there.
  expect(tiles.some(t => t.zoom === 14)).toBe(true);
  const z19 = tiles.filter(t => t.zoom === 19);
  const farTileAt19 = Math.floor(((-121.62 + 180) / 360) * 2 ** 19);
  expect(z19.every(t => Math.abs(t.x - farTileAt19) > 64)).toBe(true);
});
