import { expect, it } from 'vitest';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';

const zoom = 12, tileXMin = 650, tileYMin = 1430;
/** Two Terrarium tiles side by side; pixel (i, j) stores i. */
function grid(): ElevationGrid {
  const width = 512, height = 256, data = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) data[j * width + i] = i;
  return { width, height, zoom, tileXMin, tileXMax: tileXMin + 1, tileYMin, tileYMax: tileYMin, numTilesX: 2, numTilesY: 1,
    data, tileValidity: new Uint8Array([1, 1]), minElevation: 0, maxElevation: 511, isRealDEM: true };
}
/** Geographic centre of global tile pixel (px, py) at this zoom. */
function pixelCentre(px: number, py: number) {
  const n = 2 ** zoom;
  const x = tileXMin + (px + 0.5) / 256, y = tileYMin + (py + 0.5) / 256;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return { lat, lon };
}

it('samples a Terrarium pixel at its geographic centre with its own value', () => {
  const g = grid();
  for (const px of [10, 255, 256, 300]) {
    const { lat, lon } = pixelCentre(px, 100);
    const sample = ElevationTileService.sampleElevation(g, lat, lon);
    expect(sample.isValid).toBe(true);
    expect(sample.elevation).toBeCloseTo(px, 6);
  }
});

it('keeps the outer half pixel of the grid valid by clamping to the edge sample', () => {
  const g = grid();
  const first = pixelCentre(0, 100), lastCol = pixelCentre(511, 100);
  const n = 2 ** zoom;
  const westEdgeLon = tileXMin / n * 360 - 180 + 1e-9;
  expect(ElevationTileService.sampleElevation(g, first.lat, westEdgeLon).elevation).toBeCloseTo(0, 6);
  expect(ElevationTileService.sampleElevation(g, lastCol.lat, lastCol.lon).elevation).toBeCloseTo(511, 6);
});
