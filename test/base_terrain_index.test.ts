import { expect, it } from 'vitest';
import * as THREE from 'three';
import { deepStrictEqual } from 'node:assert/strict';
import { BaseTerrainCoverage } from '../src/terrain/BaseTerrainCoverage.ts';
import { BaseTerrainIndex } from '../src/terrain/BaseTerrainIndex.ts';

it.each([3, 16, 260])('preserves complete cells, winding and GPU-visible bytes across incremental coverage changes (%i)', segments => {
  const grid = { width: 1379.13, depth: 2678.47, segmentsX: segments, segmentsZ: segments };
  const geometry = new THREE.PlaneGeometry(grid.width, grid.depth, segments, segments);
  const original = geometry.index!.array.slice() as Uint16Array | Uint32Array;
  const target = original.slice(), ordered = original.slice(), gpu = original.slice();
  const buffer = target.buffer, originalSaved = original.slice();
  const coverage = new BaseTerrainIndex(grid, original), reference = new BaseTerrainCoverage(grid, original);
  const cellCount = segments * segments;
  const pending: { start: number; count: number }[] = [];
  let seed = 571;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const centerX = 5.5 * grid.width / segments - grid.width / 2, centerZ = 3.5 * grid.depth / segments - grid.depth / 2;
  const fixtures = [[], [{ minX: centerX, maxX: centerX, minZ: centerZ, maxZ: centerZ }],
    [{ minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }], [],
    [{ minX: 0, maxX: NaN, minZ: 0, maxZ: 1 }, { minX: 1, maxX: -1, minZ: 0, maxZ: 1 }],
    ...Array.from({ length: 24 }, () => Array.from({ length: 12 }, () => {
      const x = (random() - 0.6) * grid.width * 1.5, z = (random() - 0.6) * grid.depth * 1.5;
      return { minX: x, maxX: x + random() * grid.width / 4, minZ: z, maxZ: z + random() * grid.depth / 4 };
    })), []];
  try {
    for (const [revision, holes] of fixtures.entries()) {
      const count = coverage.update(holes, target, pending), expectedCount = reference.update(holes, ordered);
      expect(count).toBe(expectedCount); expect(target.buffer).toBe(buffer);
      deepStrictEqual(coverage.hiddenCells, reference.hiddenCells);
      const seen = new Uint8Array(cellCount);
      for (let offset = 0; offset < count; offset += 6) {
        const vertex = target[offset], cell = Math.floor(vertex / (segments + 1)) * segments + vertex % (segments + 1);
        if (seen[cell] || coverage.hiddenCells[cell]) throw new Error('Duplicate or hidden cell in the rendered prefix');
        seen[cell] = 1;
        for (let i = 0; i < 6; i++) if (target[offset + i] !== original[cell * 6 + i]) throw new Error('Cell winding or triangle changed');
      }
      for (let cell = 0; cell < cellCount; cell++) if (!coverage.hiddenCells[cell] && !seen[cell]) throw new Error('Missing visible cell');
      pending.length = 0;
      for (const range of coverage.dirtyRanges) {
        expect(range.start % 6).toBe(0); expect(range.count % 6).toBe(0);
        expect(range.start).toBeGreaterThanOrEqual(0); expect(range.start + range.count).toBeLessThanOrEqual(target.length);
        pending.push({ ...range });
      }
      expect(pending.length).toBeLessThanOrEqual(Math.ceil(cellCount / 64));
      // Several surface revisions may arrive before the renderer consumes ranges.
      if (revision % 3 === 0 || revision === fixtures.length - 1) {
        for (const range of pending) gpu.set(target.subarray(range.start, range.start + range.count), range.start);
        pending.length = 0;
        deepStrictEqual(gpu.subarray(0, count), target.subarray(0, count));
      }
      deepStrictEqual(original, originalSaved);
      expect(coverage.update(holes, target)).toBe(count);
      expect(coverage.dirtyRanges).toEqual([]);
    }
  } finally { geometry.dispose(); }
});

it('shrinks the draw range without uploading when only the last cell is hidden', () => {
  const grid = { width: 8, depth: 8, segmentsX: 4, segmentsZ: 4 };
  const geometry = new THREE.PlaneGeometry(8, 8, 4, 4);
  const original = geometry.index!.array.slice() as Uint16Array, target = original.slice();
  const coverage = new BaseTerrainIndex(grid, original);
  try {
    expect(coverage.update([{ minX: 2, maxX: 4, minZ: 2, maxZ: 4 }], target)).toBe(original.length - 6);
    expect(coverage.dirtyRanges).toEqual([]);
    expect(coverage.update([], target)).toBe(original.length);
    deepStrictEqual(target, original);
    expect(coverage.dirtyRanges).toEqual([{ start: 0, count: original.length }]);
  } finally { geometry.dispose(); }
});

it('bounds pending uploads through hundreds of coverage revisions while the mesh is culled', () => {
  const grid = { width: 2600, depth: 2600, segmentsX: 260, segmentsZ: 260 };
  const geometry = new THREE.PlaneGeometry(2600, 2600, 260, 260);
  const original = geometry.index!.array.slice() as Uint32Array, target = original.slice(), gpu = original.slice();
  const coverage = new BaseTerrainIndex(grid, original);
  let pending: { start: number; count: number }[] = [], count = original.length;
  try {
    for (let i = 0; i < 300; i++) {
      const x = -1300 + (i * 193 % 2500), z = -1300 + (i * 157 % 2500);
      count = coverage.update([{ minX: x, maxX: x + 80, minZ: z, maxZ: z + 80 }], target, pending);
      pending = coverage.dirtyRanges.map(range => ({ ...range }));
      expect(pending.length).toBeLessThanOrEqual(Math.ceil(260 * 260 / 64));
    }
    for (const range of pending) gpu.set(target.subarray(range.start, range.start + range.count), range.start);
    deepStrictEqual(gpu.subarray(0, count), target.subarray(0, count));
    count = coverage.update([{ minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity }], target, pending);
    expect(count).toBe(0); expect(coverage.dirtyRanges.length).toBeGreaterThan(0);
    pending = coverage.dirtyRanges.map(range => ({ ...range }));
    count = coverage.update([], target, pending);
    for (const range of coverage.dirtyRanges) gpu.set(target.subarray(range.start, range.start + range.count), range.start);
    deepStrictEqual(gpu.subarray(0, count), target.subarray(0, count));
  } finally { geometry.dispose(); }
});
