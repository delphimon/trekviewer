import { expect, it } from 'vitest';
import { TextureBudget } from '../src/terrain/TextureBudget.ts';

it('refines the Enchantments base mesh without exceeding the Quest vertex cap', () => {
  const width = 15474;
  const depth = 11227;
  const normal = TextureBudget.getTerrainMeshResolution(width, depth, true);
  const refined = TextureBudget.getTerrainMeshResolution(width, depth, true, 60);
  const normalCellX = width / normal.segX;
  const refinedCellX = width / refined.segX;

  expect(normalCellX).toBeGreaterThan(100);
  expect(refinedCellX).toBeLessThanOrEqual(60);
  expect(refinedCellX).toBeLessThan(normalCellX * 0.55);
  expect((refined.segX + 1) * (refined.segZ + 1)).toBeLessThan(125000);
});

it('keeps very large experimental terrain within the existing vertex budget', () => {
  const refined = TextureBudget.getTerrainMeshResolution(60000, 60000, true, 60);
  expect((refined.segX + 1) * (refined.segZ + 1)).toBeLessThanOrEqual(125000);
});
