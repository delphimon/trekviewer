import type { TerrainGridLayout } from './TerrainGrid.ts';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

type TerrainIndices = Uint16Array | Uint32Array;

/** Reuses one byte per coarse cell; preserves the original triangle order and winding. */
export class BaseTerrainCoverage {
  private readonly hidden: Uint8Array;

  constructor(private readonly grid: TerrainGridLayout, private readonly original: TerrainIndices) {
    this.hidden = new Uint8Array(grid.segmentsX * grid.segmentsZ);
  }

  public update(holes: readonly TerrainSurfaceBounds[], target: TerrainIndices): number {
    if (!holes.length) {
      target.set(this.original);
      return this.original.length;
    }
    this.hidden.fill(0);
    const { width, depth, segmentsX, segmentsZ } = this.grid;
    for (const bounds of holes) {
      if (!(bounds.minX <= bounds.maxX && bounds.minZ <= bounds.maxZ)) continue;
      const firstX = this.boundary(bounds.minX, width, segmentsX, false);
      const endX = this.boundary(bounds.maxX, width, segmentsX, true);
      const firstZ = this.boundary(bounds.minZ, depth, segmentsZ, false);
      const endZ = this.boundary(bounds.maxZ, depth, segmentsZ, true);
      for (let z = firstZ; z < endZ; z++) {
        this.hidden.fill(1, z * segmentsX + firstX, z * segmentsX + endX);
      }
    }

    let indexCount = 0;
    let cell = 0;
    while (cell < this.hidden.length) {
      while (cell < this.hidden.length && this.hidden[cell]) cell++;
      const first = cell;
      while (cell < this.hidden.length && !this.hidden[cell]) cell++;
      if (cell === first) continue;
      const count = (cell - first) * 6;
      target.set(this.original.subarray(first * 6, cell * 6), indexCount);
      indexCount += count;
    }
    return indexCount;
  }

  /** Use the original center expression, including its rounding, at inclusive edges. */
  private boundary(value: number, size: number, segments: number, upper: boolean): number {
    let low = 0, high = segments;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const center = (middle + 0.5) * size / segments - size / 2;
      if (upper ? center <= value : center < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
