import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

export interface TerrainGridLayout {
  width: number;
  depth: number;
  segmentsX: number;
  segmentsZ: number;
}

/** Snap a replacement to whole coarse cells and subdivide those cells by integers.
 * Shared boundaries then reproduce the coarse triangles exactly, including valleys.
 */
export function refinementGrid(
  grid: TerrainGridLayout, x: number, z: number, radius: number, targetSegments: number
): TerrainGridLayout & { bounds: TerrainSurfaceBounds } {
  const dx = grid.width / grid.segmentsX;
  const dz = grid.depth / grid.segmentsZ;
  const x0 = Math.max(0, Math.min(grid.segmentsX - 1, Math.floor((x - radius + grid.width / 2) / dx)));
  const x1 = Math.max(x0 + 1, Math.min(grid.segmentsX, Math.ceil((x + radius + grid.width / 2) / dx)));
  const z0 = Math.max(0, Math.min(grid.segmentsZ - 1, Math.floor((z - radius + grid.depth / 2) / dz)));
  const z1 = Math.max(z0 + 1, Math.min(grid.segmentsZ, Math.ceil((z + radius + grid.depth / 2) / dz)));
  const spacing = 2 * radius / targetSegments;
  return {
    width: (x1 - x0) * dx,
    depth: (z1 - z0) * dz,
    segmentsX: (x1 - x0) * Math.max(1, Math.ceil(dx / spacing)),
    segmentsZ: (z1 - z0) * Math.max(1, Math.ceil(dz / spacing)),
    bounds: {
      minX: x0 * dx - grid.width / 2, maxX: x1 * dx - grid.width / 2,
      minZ: z0 * dz - grid.depth / 2, maxZ: z1 * dz - grid.depth / 2,
    },
  };
}
