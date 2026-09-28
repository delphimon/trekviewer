import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

const colchuck: GeoBounds = {
  minLat: 47.485, maxLat: 47.5, minLon: -120.84, maxLon: -120.81,
  centerLat: 47.4925, centerLon: -120.825,
  minEle: 1600, maxEle: 2700, widthMeters: 2300, depthMeters: 1700, elevationSpan: 1100,
};

function grid(zoom: number, elevation: number): ElevationGrid {
  return {
    width: 256, height: 256, zoom,
    tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0,
    numTilesX: 1, numTilesY: 1,
    data: new Float32Array(256 * 256).fill(elevation),
    tileValidity: new Uint8Array([1]),
    minElevation: elevation, maxElevation: elevation, isRealDEM: true,
    quality: { validTileRatio: 1, totalTiles: 1, validTiles: 1, zoom },
  };
}

describe('regional elevation for base terrain', () => {
  afterEach(() => {
    ElevationTileService.setRegionalDEMEnabled(false);
    vi.restoreAllMocks();
  });

  it('limits the high-resolution request to the pack footprint and skips unrelated routes', async () => {
    ElevationTileService.setRegionalDEMEnabled(false);
    const decode = vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockResolvedValue(grid(15, 2200));
    await ElevationTileService.fetchRegionalElevationGrid(colchuck);
    expect(decode).toHaveBeenCalledOnce();
    const [zoom, minX, maxX, minY, maxY] = decode.mock.calls[0];
    expect(zoom).toBe(15);
    expect(minX).toBeGreaterThanOrEqual(5383);
    expect(maxX).toBeLessThanOrEqual(5388);
    expect(minY).toBeGreaterThanOrEqual(11457);
    expect(maxY).toBeLessThanOrEqual(11461);
    await ElevationTileService.fetchRegionalElevationGrid({ ...colchuck, minLat: 46, maxLat: 46.01, minLon: -122, maxLon: -121.99 });
    expect(decode).toHaveBeenCalledOnce();
  });

  it('uses regional heights where valid and preserves the route DEM fallback', async () => {
    const base = grid(12, 2000);
    const regional = grid(15, 2200);
    vi.spyOn(ElevationTileService, 'fetchElevationGrid').mockResolvedValue(base);
    vi.spyOn(ElevationTileService, 'fetchRegionalElevationGrid').mockResolvedValue(regional);
    vi.spyOn(ElevationTileService, 'sampleElevation').mockImplementation((source, lat) =>
      source === regional && lat >= 47.49
        ? { elevation: 2200, isValid: true }
        : { elevation: NaN, isValid: false }
    );
    vi.spyOn(ElevationTileService, 'sampleElevationValue').mockReturnValue(2000);

    const prepared = await TerrainGenerator.prepareElevation(colchuck, undefined, undefined, true);
    expect(prepared.regionalGrid).toBe(regional);
    expect(prepared.elevationSamplerForGeo(47.495, -120.825)).toBe(2200);
    expect(prepared.elevationSamplerForGeo(47.485, -120.825)).toBe(2000);
  });

  it('continues with the route DEM if optional regional loading fails', async () => {
    vi.spyOn(ElevationTileService, 'fetchElevationGrid').mockResolvedValue(grid(12, 2000));
    vi.spyOn(ElevationTileService, 'fetchRegionalElevationGrid').mockRejectedValue(new Error('offline'));
    vi.spyOn(ElevationTileService, 'sampleElevationValue').mockReturnValue(2000);
    const prepared = await TerrainGenerator.prepareElevation(colchuck, undefined, undefined, true);
    expect(prepared.regionalGrid).toBeNull();
    expect(prepared.elevationSamplerForGeo(47.495, -120.825)).toBe(2000);
  });
});
