import { afterEach, expect, it, vi } from 'vitest';
import { elevationRasterRequest, paddedElevationFootprint, requiredElevationWindow } from '../src/terrain/BestAvailableElevation.ts';
import * as BestElevation from '../src/terrain/BestAvailableElevation.ts';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { localMetersToGeo } from '../src/gpx/Coordinates.ts';

afterEach(() => { vi.restoreAllMocks(); ElevationTileService.setBestAvailableEnabled(false); ElevationTileService.setCompactFootprintsEnabled(false); ElevationTileService.clearLocalGridCache(); });

it.each([46.8, 60, -40, 84.8])('keeps every actual Float32 mesh axis inside complete guarded support at latitude %s', lat => {
  const center = { x: 18000, z: 7000 }, width = 754.7, depth = 188.6;
  const a = localMetersToGeo(center.x - width / 2, center.z - depth / 2, lat, -120);
  const b = localMetersToGeo(center.x + width / 2, center.z + depth / 2, lat, -120);
  const required = { minLat: b.lat, maxLat: a.lat, minLon: a.lon, maxLon: b.lon };
  const request = elevationRasterRequest(paddedElevationFootprint(required), 1, 1024, true);
  const window = requiredElevationWindow(request, required), r = request.rasterBounds;
  for (let i = 0; i <= 160; i++) {
    const geo = localMetersToGeo(center.x + Math.fround(i * width / 160 - width / 2),
      center.z + Math.fround(i * depth / 160 - depth / 2), lat, -120);
    const x = geo.lon * Math.PI * 6378137 / 180, y = Math.asinh(Math.tan(geo.lat * Math.PI / 180)) * 6378137;
    const gx = (x - r.west) * (request.width - 1) / (r.east - r.west), gy = (r.north - y) * (request.height - 1) / (r.north - r.south);
    expect(Math.floor(gx)).toBeGreaterThanOrEqual(window.minX); expect(Math.floor(gx) + 1).toBeLessThanOrEqual(window.maxX);
    expect(Math.floor(gy)).toBeGreaterThanOrEqual(window.minY); expect(Math.floor(gy) + 1).toBeLessThanOrEqual(window.maxY);
    expect(gx).toBeLessThan(request.width - 1); expect(gy).toBeLessThan(request.height - 1);
  }
  expect(request.sampleSpacingMeters).toBeLessThanOrEqual(1.00000001);
});

it('does not reuse a footprint-validated partial raster for a larger or legacy station request', async () => {
  const grid: ElevationGrid = { width: 2, height: 2, data: new Float32Array([1, 2, 3, 4]), zoom: 0,
    tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0, numTilesX: 1, numTilesY: 1,
    minElevation: 1, maxElevation: 4, isRealDEM: true, tileValidity: new Uint8Array([1]),
    quality: { validTileRatio: 1, totalTiles: 1, validTiles: 1, zoom: 0, validRasterSampleRatio: 0.99 } };
  const fetch = vi.spyOn(BestElevation, 'fetchBestAvailableElevation').mockResolvedValue(grid);
  ElevationTileService.setBestAvailableEnabled(true);
  const a = { minLat: 46.799, maxLat: 46.801, minLon: -120.001, maxLon: -119.999 };
  const b = { ...a, maxLat: 46.802 };
  await ElevationTileService.fetchLocalElevationGrid(46.8, -120, 500, 15, 16, undefined, a);
  await ElevationTileService.fetchLocalElevationGrid(46.8, -120, 500, 15, 16, undefined, { ...a });
  expect(fetch).toHaveBeenCalledTimes(1);
  await ElevationTileService.fetchLocalElevationGrid(46.8, -120, 500, 15, 16, undefined, b);
  await ElevationTileService.fetchLocalElevationGrid(46.8, -120, 500, 15, 16);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[0][3]).toEqual(a); expect(fetch.mock.calls[1][3]).toEqual(b); expect(fetch.mock.calls[2][3]).toBeUndefined();
  expect(fetch.mock.calls[0][4]).toBe(false);
  ElevationTileService.setCompactFootprintsEnabled(true);
  await ElevationTileService.fetchLocalElevationGrid(46.8, -120, 500, 15, 16, undefined, a);
  expect(fetch).toHaveBeenCalledTimes(4); expect(fetch.mock.calls[3][0]).toEqual(paddedElevationFootprint(a));
  expect(fetch.mock.calls[3][4]).toBe(true);
});
