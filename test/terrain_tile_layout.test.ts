import { describe, expect, it } from 'vitest';
import { planTerrainTiles, selectTerrainFocus } from '../src/terrain/TerrainTileLayout.ts';

it('reserves current and upcoming ground before broad anchors within the same radius and vertex budget', () => {
  const input = { parent: { width: 9600, depth: 9600, segmentsX: 80, segmentsZ: 80 },
    focusX: -3500, focusZ: -3500, additionalFocus: [{ x: -3500, z: -1500 }, { x: -1500, z: -1500 }],
    radiusM: 4000, parentCellsPerTile: 8, targetCellM: 5, maxTiles: 3, maxVertices: 120000 };
  const original = planTerrainTiles(input);
  expect(original.tiles.map(tile => tile.id)).not.toContain('3:1');
  const upcoming = planTerrainTiles({ ...input, priorityFocus: { x: -1500, z: -3500 } });
  expect(upcoming.tiles.map(tile => tile.id).slice(0, 2)).toEqual(['1:1', '3:1']);
  expect(upcoming.tiles.length).toBe(original.tiles.length);
  expect(upcoming.vertexCount).toBe(original.vertexCount);
  expect(upcoming.vertexCount).toBeLessThanOrEqual(input.maxVertices);
  expect(planTerrainTiles({ ...input, priorityFocus: { x: 4000, z: 4000 } })).toEqual(original);
});

it('spreads detail across the view with stable ties, original point ownership and bounded spacing/count', () => {
  const points = [-200, 0, 200].flatMap(x => [-200, 0, 200].map(z => ({ x, z })));
  const before = [...points];
  const anchors = selectTerrainFocus(points, { x: 0, z: 0 });
  expect(anchors.map(p => [p.x, p.z])).toEqual([[-200, -200], [-200, 200], [200, -200], [200, 200], [-200, 0], [0, -200], [0, 200], [200, 0]]);
  expect(points).toEqual(before); expect(anchors[0]).toBe(points[0]);
  expect(selectTerrainFocus(points, { x: 0, z: 0 }, 3)).toEqual(anchors.slice(0, 3));
  expect(selectTerrainFocus([{ x: 59, z: 0 }, { x: 60, z: 0 }], { x: 0, z: 0 })).toEqual([{ x: 60, z: 0 }]);
});

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
  it('retains exact circle-boundary contacts between separated focus neighborhoods', () => {
    const plan = planTerrainTiles({ parent: { width: 4000, depth: 2000, segmentsX: 40, segmentsZ: 20 },
      focusX: -1500, focusZ: 0, additionalFocus: [{ x: 500, z: 0 }], radiusM: 500,
      parentCellsPerTile: 1, targetCellM: 50, maxTiles: 1000, maxVertices: 100000 });
    expect(plan.tiles.some(tile => tile.id === '19:9')).toBe(true);
    expect(plan.tiles.some(tile => tile.id === '30:9')).toBe(true);
    expect(plan.tiles.some(tile => tile.id === '18:9')).toBe(false);
  });
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
