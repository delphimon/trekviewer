import { describe, expect, it } from 'vitest';
import { planTerrainTiles } from '../src/terrain/TerrainTileLayout.ts';

const parent = { width: 2400, depth: 1800, segmentsX: 20, segmentsZ: 15 };
const options = {
  parent,
  focusX: 0,
  focusZ: 0,
  radiusM: 5000,
  parentCellsPerTile: 5,
  targetCellM: 30,
  maxTiles: 20,
  maxVertices: 10000,
};

describe('terrain tile layout', () => {
  it('partitions the complete parent surface on shared cell boundaries', () => {
    const plan = planTerrainTiles(options);
    expect(plan.tiles).toHaveLength(12);
    expect(plan.requestedTiles).toBe(12);
    expect(new Set(plan.tiles.map(tile => tile.id)).size).toBe(12);
    expect(plan.vertexCount).toBe(plan.tiles.reduce((sum, tile) => sum + tile.vertexCount, 0));

    for (const tile of plan.tiles) {
      expect(tile.width / tile.segmentsX).toBe(30);
      expect(tile.depth / tile.segmentsZ).toBe(30);
      const right = plan.tiles.find(other => other.column === tile.column + 1 && other.row === tile.row);
      const below = plan.tiles.find(other => other.column === tile.column && other.row === tile.row + 1);
      if (right) expect(tile.bounds.maxX).toBe(right.bounds.minX);
      if (below) expect(tile.bounds.maxZ).toBe(below.bounds.minZ);
    }
    expect(Math.min(...plan.tiles.map(tile => tile.bounds.minX))).toBe(-1200);
    expect(Math.max(...plan.tiles.map(tile => tile.bounds.maxX))).toBe(1200);
    expect(Math.min(...plan.tiles.map(tile => tile.bounds.minZ))).toBe(-900);
    expect(Math.max(...plan.tiles.map(tile => tile.bounds.maxZ))).toBe(900);
  });

  it('keeps partial edge tiles aligned to the actual parent boundary', () => {
    const plan = planTerrainTiles({ ...options,
      parent: { width: 2160, depth: 1560, segmentsX: 18, segmentsZ: 13 },
    });
    const edge = plan.tiles.find(tile => tile.column === 3 && tile.row === 2)!;
    expect(edge.bounds.maxX).toBe(1080);
    expect(edge.bounds.maxZ).toBe(780);
    expect(edge.segmentsX).toBe(12);
    expect(edge.segmentsZ).toBe(12);
  });

  it('bounds a stable 360-degree neighborhood by tile and vertex budgets', () => {
    const plan = planTerrainTiles({ ...options, radiusM: 850, maxTiles: 3, maxVertices: 900 });
    expect(plan.requestedTiles).toBeGreaterThan(3);
    expect(plan.tiles.length).toBeLessThanOrEqual(3);
    expect(plan.vertexCount).toBeLessThanOrEqual(900);
    expect(plan.tiles[0].bounds.minX).toBeLessThanOrEqual(0);
    expect(plan.tiles[0].bounds.maxX).toBeGreaterThanOrEqual(0);
    expect(plan.tiles[0].bounds.minZ).toBeLessThanOrEqual(0);
    expect(plan.tiles[0].bounds.maxZ).toBeGreaterThanOrEqual(0);
    expect(planTerrainTiles({ ...options, radiusM: 850, maxTiles: 3, maxVertices: 900 })).toEqual(plan);
  });

  it('rejects impossible or unbounded plans', () => {
    expect(() => planTerrainTiles({ ...options, targetCellM: 0 })).toThrow(RangeError);
    expect(() => planTerrainTiles({ ...options, maxTiles: Infinity })).toThrow(RangeError);
    expect(() => planTerrainTiles({ ...options, parentCellsPerTile: 2.5 })).toThrow(RangeError);
  });
});
