import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
  ElevationTileService,
  type ElevationGrid,
} from '../src/terrain/ElevationTiles.ts';
import { tileToLatLon } from '../src/gpx/Coordinates.ts';

describe('DEM Missing-Tile & Partial Tile Failure Handling', () => {
  it('evaluates DEM tile validity, NaN isolation, and crater guards', () => {
    // Construct a synthetic 2x2 tile ElevationGrid (each tile 256x256 -> 512x512 total)
    const zoom = 12;
    const tileXMin = 1320;
    const tileXMax = 1321;
    const tileYMin = 2880;
    const tileYMax = 2881;
    const numTilesX = 2;
    const numTilesY = 2;
    const width = numTilesX * 256;
    const height = numTilesY * 256;

    const data = new Float32Array(width * height);
    const tileValidity = new Uint8Array(numTilesX * numTilesY);

    // Tile 0 (top-left, tx=0, ty=0): Valid tile, uniform elevation 2000m
    tileValidity[0] = 1;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        data[y * width + x] = 2000.0;
      }
    }

    // Tile 1 (top-right, tx=1, ty=0): FAILED/MISSING tile (tileValidity = 0)
    tileValidity[1] = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 256; x < 512; x++) {
        data[y * width + x] = NaN; // Missing tile data marked as NaN
      }
    }

    // Tile 2 (bottom-left, tx=0, ty=1): Valid tile with black pixel crater guard
    tileValidity[2] = 1;
    for (let y = 256; y < 512; y++) {
      for (let x = 0; x < 256; x++) {
        // Normal elevation is 1800m, but (100, 300) is an unmapped black pixel (decodes to -32768, guarded to NaN)
        if (x === 100 && y === 300) {
          data[y * width + x] = NaN;
        } else {
          data[y * width + x] = 1800.0;
        }
      }
    }

    // Tile 3 (bottom-right, tx=1, ty=1): Valid tile with slope from 1500 to 2500
    tileValidity[3] = 1;
    for (let y = 256; y < 512; y++) {
      for (let x = 256; x < 512; x++) {
        data[y * width + x] = 1500.0 + ((x - 256) / 256) * 1000.0;
      }
    }

    const mockGrid: ElevationGrid = {
      width,
      height,
      zoom,
      tileXMin,
      tileXMax,
      tileYMin,
      tileYMax,
      numTilesX,
      numTilesY,
      data,
      tileValidity,
      minElevation: 1500,
      maxElevation: 2500,
      isRealDEM: true,
    };

    // 1. Sampling inside fully valid Tile 0
    const coordTile0 = tileToLatLon(tileXMin + 0.5, tileYMin + 0.5, zoom);
    const sampleTile0 = ElevationTileService.sampleElevation(mockGrid, coordTile0.lat, coordTile0.lon);
    assert.strictEqual(sampleTile0.isValid, true);
    assert(Math.abs(sampleTile0.elevation - 2000.0) < 0.1);

    // 2. Sampling inside failed/missing Tile 1
    const coordTile1 = tileToLatLon(tileXMin + 1.5, tileYMin + 0.5, zoom);
    const sampleTile1 = ElevationTileService.sampleElevation(mockGrid, coordTile1.lat, coordTile1.lon);
    assert.strictEqual(sampleTile1.isValid, false, 'Failed tile must be marked invalid');
    assert(isNaN(sampleTile1.elevation), 'Failed tile elevation must be NaN, never -32768 or 0');

    // 3. Black pixel crater guard inside valid tile (Tile 2)
    const n = 2 ** zoom;
    const lonBlack = ((tileXMin + 100.2 / 256) / n) * 360 - 180;
    const yGlobal = tileYMin + 300.2 / 256;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yGlobal) / n)));
    const latBlack = (latRad * 180) / Math.PI;

    const sampleBlack = ElevationTileService.sampleElevation(mockGrid, latBlack, lonBlack);
    assert.strictEqual(sampleBlack.isValid, true);
    assert(!isNaN(sampleBlack.elevation), 'Black pixel guard must not corrupt surrounding valid terrain');
    assert(Math.abs(sampleBlack.elevation - 1800.0) < 0.1);

    // 4. Out of bounds coordinates (outside grid)
    const oobSample = ElevationTileService.sampleElevation(mockGrid, 0, 0);
    assert.strictEqual(oobSample.isValid, false);
    assert(isNaN(oobSample.elevation));
  });
});
