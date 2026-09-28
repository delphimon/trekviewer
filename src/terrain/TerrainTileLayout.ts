import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';
import type { TerrainGridLayout } from './TerrainGrid.ts';

export interface TerrainTileLayout extends TerrainGridLayout {
  id: string;
  column: number;
  row: number;
  bounds: TerrainSurfaceBounds;
  vertexCount: number;
}

export interface TerrainTilePlan {
  tiles: TerrainTileLayout[];
  requestedTiles: number;
  vertexCount: number;
}

export interface TerrainTilePlanOptions {
  parent: TerrainGridLayout;
  focusX: number;
  focusZ: number;
  radiusM: number;
  parentCellsPerTile: number;
  targetCellM: number;
  maxTiles: number;
  maxVertices: number;
}

function distanceToBoundsSquared(x: number, z: number, bounds: TerrainSurfaceBounds): number {
  const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
  const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
  return dx * dx + dz * dz;
}

/**
 * Partition a stable, head-direction-independent neighborhood into non-overlapping
 * rectangles of whole parent cells. Each child subdivides those cells by the
 * same integer factor, so neighboring children have identical boundary samples.
 * This only plans geometry; the renderer must retain parent coverage until a
 * validated child is ready and blend child edges to the parent surface.
 */
export function planTerrainTiles(options: TerrainTilePlanOptions): TerrainTilePlan {
  const { parent, focusX, focusZ, radiusM, targetCellM, maxTiles, maxVertices } = options;
  const cellsPerTile = options.parentCellsPerTile;
  const values = [parent.width, parent.depth, parent.segmentsX, parent.segmentsZ,
    focusX, focusZ, radiusM, cellsPerTile, targetCellM, maxTiles, maxVertices];
  if (values.some(value => !Number.isFinite(value)) ||
      parent.width <= 0 || parent.depth <= 0 ||
      !Number.isInteger(parent.segmentsX) || !Number.isInteger(parent.segmentsZ) ||
      parent.segmentsX < 1 || parent.segmentsZ < 1 ||
      !Number.isInteger(cellsPerTile) || cellsPerTile < 1 ||
      !Number.isInteger(maxTiles) || maxTiles < 1 ||
      !Number.isInteger(maxVertices) || maxVertices < 4 ||
      radiusM <= 0 || targetCellM <= 0) {
    throw new RangeError('Invalid terrain tile plan options');
  }

  const cellX = parent.width / parent.segmentsX;
  const cellZ = parent.depth / parent.segmentsZ;
  const subdivisionsX = Math.max(1, Math.ceil(cellX / targetCellM));
  const subdivisionsZ = Math.max(1, Math.ceil(cellZ / targetCellM));
  const columns = Math.ceil(parent.segmentsX / cellsPerTile);
  const rows = Math.ceil(parent.segmentsZ / cellsPerTile);
  const tileWidth = cellsPerTile * cellX;
  const tileDepth = cellsPerTile * cellZ;
  const firstColumn = Math.max(0, Math.floor((focusX - radiusM + parent.width / 2) / tileWidth));
  const lastColumn = Math.min(columns - 1, Math.floor((focusX + radiusM + parent.width / 2) / tileWidth));
  const firstRow = Math.max(0, Math.floor((focusZ - radiusM + parent.depth / 2) / tileDepth));
  const lastRow = Math.min(rows - 1, Math.floor((focusZ + radiusM + parent.depth / 2) / tileDepth));
  const candidates: TerrainTileLayout[] = [];

  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const startX = column * cellsPerTile;
      const endX = Math.min(parent.segmentsX, startX + cellsPerTile);
      const startZ = row * cellsPerTile;
      const endZ = Math.min(parent.segmentsZ, startZ + cellsPerTile);
      const bounds = {
        minX: startX * cellX - parent.width / 2,
        maxX: endX * cellX - parent.width / 2,
        minZ: startZ * cellZ - parent.depth / 2,
        maxZ: endZ * cellZ - parent.depth / 2,
      };
      if (distanceToBoundsSquared(focusX, focusZ, bounds) > radiusM * radiusM) continue;
      const segmentsX = (endX - startX) * subdivisionsX;
      const segmentsZ = (endZ - startZ) * subdivisionsZ;
      candidates.push({
        id: `${column}:${row}`,
        column,
        row,
        bounds,
        width: bounds.maxX - bounds.minX,
        depth: bounds.maxZ - bounds.minZ,
        segmentsX,
        segmentsZ,
        vertexCount: (segmentsX + 1) * (segmentsZ + 1),
      });
    }
  }

  candidates.sort((a, b) =>
    distanceToBoundsSquared(focusX, focusZ, a.bounds) - distanceToBoundsSquared(focusX, focusZ, b.bounds) ||
    a.row - b.row || a.column - b.column);
  const tiles: TerrainTileLayout[] = [];
  let vertexCount = 0;
  for (const tile of candidates) {
    if (tiles.length >= maxTiles) break;
    if (vertexCount + tile.vertexCount > maxVertices) continue;
    tiles.push(tile);
    vertexCount += tile.vertexCount;
  }
  return { tiles, requestedTiles: candidates.length, vertexCount };
}
