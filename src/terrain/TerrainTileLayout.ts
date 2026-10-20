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
  additionalFocus?: readonly { x: number; z: number }[];
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

/** Farthest-point anchors with cached nearest distances. Preserve input-order
 * ties and the same spacing/count policy without rescanning all prior anchors. */
export function selectTerrainFocus<T extends { x: number; z: number }>(points: readonly T[], focus: { x: number; z: number }, limit = 25, spacing = 60): T[] {
  const candidates = [...points];
  const nearest = candidates.map(p => (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2);
  const selected: T[] = [];
  while (candidates.length && selected.length < limit) {
    let farthest = 0;
    for (let i = 1; i < candidates.length; i++) if (nearest[i] > nearest[farthest]) farthest = i;
    if (nearest[farthest] < spacing * spacing) break;
    const point = candidates.splice(farthest, 1)[0]; nearest.splice(farthest, 1); selected.push(point);
    for (let i = 0; i < candidates.length; i++) {
      const other = candidates[i];
      nearest[i] = Math.min(nearest[i], (other.x - point.x) ** 2 + (other.z - point.z) ** 2);
    }
  }
  return selected;
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
  const focuses = [{ x: focusX, z: focusZ }, ...(options.additionalFocus ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.z)).slice(0, 25)];
  const firstColumn = Math.max(0, Math.floor((Math.min(...focuses.map(p => p.x)) - radiusM + parent.width / 2) / tileWidth));
  const lastColumn = Math.min(columns - 1, Math.floor((Math.max(...focuses.map(p => p.x)) + radiusM + parent.width / 2) / tileWidth));
  const firstRow = Math.max(0, Math.floor((Math.min(...focuses.map(p => p.z)) - radiusM + parent.depth / 2) / tileDepth));
  const lastRow = Math.min(rows - 1, Math.floor((Math.max(...focuses.map(p => p.z)) + radiusM + parent.depth / 2) / tileDepth));
  const candidates: TerrainTileLayout[] = [];
  const distances = new Map<number, number>();
  // Visit each anchor's radius, rather than testing every anchor against the
  // rectangle between distant view samples. The one-cell margin covers exact
  // boundary contacts; the original bounds-distance test decides admission.
  for (const focus of focuses) {
    const x0 = Math.max(firstColumn, Math.floor((focus.x - radiusM + parent.width / 2) / tileWidth) - 1);
    const x1 = Math.min(lastColumn, Math.floor((focus.x + radiusM + parent.width / 2) / tileWidth) + 1);
    const z0 = Math.max(firstRow, Math.floor((focus.z - radiusM + parent.depth / 2) / tileDepth) - 1);
    const z1 = Math.min(lastRow, Math.floor((focus.z + radiusM + parent.depth / 2) / tileDepth) + 1);
    for (let row = z0; row <= z1; row++) for (let column = x0; column <= x1; column++) {
      const bounds = {
        minX: column * cellsPerTile * cellX - parent.width / 2,
        maxX: Math.min(parent.segmentsX, (column + 1) * cellsPerTile) * cellX - parent.width / 2,
        minZ: row * cellsPerTile * cellZ - parent.depth / 2,
        maxZ: Math.min(parent.segmentsZ, (row + 1) * cellsPerTile) * cellZ - parent.depth / 2,
      };
      const distance = distanceToBoundsSquared(focus.x, focus.z, bounds);
      if (distance > radiusM * radiusM) continue;
      const key = row * columns + column;
      if (distance < (distances.get(key) ?? Infinity)) distances.set(key, distance);
    }
  }

  for (const key of distances.keys()) {
    const row = Math.floor(key / columns), column = key % columns;
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

  candidates.sort((a, b) =>
    distances.get(a.row * columns + a.column)! - distances.get(b.row * columns + b.column)! ||
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
