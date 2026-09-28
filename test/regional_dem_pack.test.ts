import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import manifest from '../src/terrain/data/enchantments-3dep-2019.json';
import { EnchantmentsRegionalDEMProvider } from '../src/terrain/providers/RegionalDEMProvider.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';

describe('optional Enchantments 3DEP pack', () => {
  afterEach(() => {
    ElevationTileService.setRegionalDEMEnabled(false);
    vi.restoreAllMocks();
  });

  it('ships exactly the declared complete 256px tiles and excludes partial source coverage', () => {
    const provider = new EnchantmentsRegionalDEMProvider();
    expect(manifest.tiles.length).toBe(26);
    for (const key of manifest.tiles) {
      const [x, y] = key.split('/').map(Number);
      expect(provider.covers(15, x, y)).toBe(true);
      const path = resolve('public', 'dem', 'enchantments-3dep-2019', '15', String(x), `${y}.png`);
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.readUInt32BE(16)).toBe(256);
      expect(bytes.readUInt32BE(20)).toBe(256);
      expect(provider.getTileUrls(15, x, y)[0]).toMatch(new RegExp(`dem/enchantments-3dep-2019/15/${x}/${y}\\.png$`));
    }
    expect(provider.covers(15, 5385, 11461)).toBe(false);
    expect(provider.getTileUrls(15, 5385, 11461)).toEqual([]);
    expect(provider.covers(14, 5385, 11459)).toBe(false);
  });

  it('invalidates decoded local grids when the source experiment changes', async () => {
    ElevationTileService.clearLocalGridCache();
    const center = latLonToTile(47.49, -120.83, 15);
    expect(new EnchantmentsRegionalDEMProvider().covers(15, center.x, center.y)).toBe(true);
    let calls = 0;
    vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockImplementation(async () => {
      calls++;
      return { quality: { validTileRatio: 1 }, sourceCall: calls };
    });
    ElevationTileService.setRegionalDEMEnabled(false);
    await ElevationTileService.fetchLocalElevationGrid(47.49, -120.83, 500, 15, 16);
    await ElevationTileService.fetchLocalElevationGrid(47.49, -120.83, 500, 15, 16);
    expect(calls).toBe(1);
    ElevationTileService.setRegionalDEMEnabled(true);
    await ElevationTileService.fetchLocalElevationGrid(47.49, -120.83, 500, 15, 16);
    expect(calls).toBe(2);
  });
});
