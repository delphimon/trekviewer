import { expect, it } from 'vitest';
import * as THREE from 'three';
import { BaseTerrainCoverage } from '../src/terrain/BaseTerrainCoverage.ts';
import type { TerrainGridLayout } from '../src/terrain/TerrainGrid.ts';
import type { TerrainSurfaceBounds } from '../src/terrain/TerrainGenerator.ts';

function reference(grid: TerrainGridLayout, original: Uint16Array | Uint32Array, holes: readonly TerrainSurfaceBounds[]) {
  const indices: number[] = [];
  for (let z = 0; z < grid.segmentsZ; z++) {
    for (let x = 0; x < grid.segmentsX; x++) {
      const cx = (x + 0.5) * grid.width / grid.segmentsX - grid.width / 2;
      const cz = (z + 0.5) * grid.depth / grid.segmentsZ - grid.depth / 2;
      if (holes.some(b => cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ)) continue;
      const offset = (z * grid.segmentsX + x) * 6;
      for (let i = 0; i < 6; i++) indices.push(original[offset + i]);
    }
  }
  return indices;
}

it.each([
  { width: 1379.13, depth: 2678.47, segmentsX: 13, segmentsZ: 29 },
  { width: 25091.71, depth: 28179.43, segmentsX: 289, segmentsZ: 317 },
])('matches whole-cell reference coverage across overlapping, off-grid and exact center boundaries (%j)', grid => {
  const geometry = new THREE.PlaneGeometry(grid.width, grid.depth, grid.segmentsX, grid.segmentsZ);
  const original = geometry.index!.array.slice() as Uint16Array | Uint32Array;
  const target = original.slice();
  const coverage = new BaseTerrainCoverage(grid, original);
  let seed = 17;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  const x = (5.5) * grid.width / grid.segmentsX - grid.width / 2;
  const z = (3.5) * grid.depth / grid.segmentsZ - grid.depth / 2;
  const fixtures: TerrainSurfaceBounds[][] = [
    [],
    [{ minX: x, maxX: x, minZ: z, maxZ: z }],
    [{ minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }],
    [{ minX: grid.width, maxX: grid.width * 2, minZ: -grid.depth, maxZ: grid.depth }],
    [{ minX: 0, maxX: NaN, minZ: 0, maxZ: 1 }, { minX: 1, maxX: -1, minZ: 0, maxZ: 1 }],
  ];
  for (let i = 0; i < 12; i++) {
    fixtures.push(Array.from({ length: 24 }, () => {
      const minX = (random() - 0.7) * grid.width * 1.5;
      const minZ = (random() - 0.7) * grid.depth * 1.5;
      return { minX, maxX: minX + random() * grid.width / 3, minZ, maxZ: minZ + random() * grid.depth / 3 };
    }));
  }
  for (const holes of fixtures) {
    const count = coverage.update(holes, target);
    expect(Array.from(target.subarray(0, count))).toEqual(reference(grid, original, holes));
    expect(count % 6).toBe(0);
  }
  const restored = coverage.update([], target);
  expect(target).toEqual(original);
  expect(restored).toBe(original.length);
  geometry.dispose();
});

it('keeps immutable source indices and the same live allocation across consecutive coverage changes', () => {
  const grid = { width: 400, depth: 400, segmentsX: 4, segmentsZ: 4 };
  const geometry = new THREE.PlaneGeometry(400, 400, 4, 4);
  const original = geometry.index!.array.slice() as Uint16Array;
  const saved = original.slice(), target = original.slice(), buffer = target.buffer;
  const coverage = new BaseTerrainCoverage(grid, original);
  const left = { minX: -200, maxX: 0, minZ: -200, maxZ: 200 };
  const right = { minX: 0, maxX: 200, minZ: -200, maxZ: 200 };
  for (const holes of [[left], [left, right], [right], []]) {
    const count = coverage.update(holes, target);
    expect(Array.from(target.subarray(0, count))).toEqual(reference(grid, original, holes));
    expect(target.buffer).toBe(buffer);
    expect(original).toEqual(saved);
  }
  geometry.dispose();
});
