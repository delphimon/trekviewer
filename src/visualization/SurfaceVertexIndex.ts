import * as THREE from 'three';
import type { TerrainSurfaceBounds } from '../terrain/TerrainGenerator.ts';

interface VertexBucket { x: number; z: number; order: number; indices: number[]; }

/** Static X/Z buckets for a ribbon whose only changing coordinate is elevation. */
export class SurfaceVertexIndex {
  private readonly columns = new Map<number, Map<number, VertexBucket>>();
  private readonly buckets: VertexBucket[] = [];
  private minCellX = Infinity;
  private maxCellX = -Infinity;
  private minCellZ = Infinity;
  private maxCellZ = -Infinity;
  private readonly incidentFaces: number[][] | null;
  constructor(private readonly geometry: THREE.BufferGeometry, private readonly cellM = 500, trackNormals = true) {
    const position = geometry.attributes.position;
    (position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    geometry.computeBoundingBox();
    geometry.boundingSphere ??= new THREE.Sphere();
    geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere);
    this.incidentFaces = trackNormals ? Array.from({ length: position.count }, () => []) : null;
    for (let i = 0; i < position.count; i++) {
      const x = Math.floor(position.getX(i) / cellM), z = Math.floor(position.getZ(i) / cellM);
      let column = this.columns.get(x);
      if (!column) { column = new Map(); this.columns.set(x, column); }
      let bucket = column.get(z);
      if (!bucket) {
        bucket = { x, z, order: this.buckets.length, indices: [] };
        column.set(z, bucket); this.buckets.push(bucket);
        this.minCellX = Math.min(this.minCellX, x); this.maxCellX = Math.max(this.maxCellX, x);
        this.minCellZ = Math.min(this.minCellZ, z); this.maxCellZ = Math.max(this.maxCellZ, z);
      }
      bucket.indices.push(i);
    }
    const index = geometry.index;
    if (index && this.incidentFaces) for (let face = 0; face < index.count; face += 3) {
      for (let corner = 0; corner < 3; corner++) this.incidentFaces[index.getX(face + corner)].push(face);
    }
  }

  /** Elevation-only changes expand conservative bounds without rescanning the entire ribbon, or recompute when all vertices change. */
  public updatePositions(changedVertices: readonly number[]): void {
    const position = this.geometry.attributes.position;
    const box = this.geometry.boundingBox!;
    if (changedVertices.length === 0) return;
    if (changedVertices.length >= position.count) {
      let minY = Infinity, maxY = -Infinity;
      for (const vertex of changedVertices) {
        const y = position.getY(vertex);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      box.min.y = minY;
      box.max.y = maxY;
    } else {
      for (const vertex of changedVertices) {
        const y = position.getY(vertex);
        box.min.y = Math.min(box.min.y, y); box.max.y = Math.max(box.max.y, y);
      }
    }
    box.getBoundingSphere(this.geometry.boundingSphere!);
    markChangedSpan(position as THREE.BufferAttribute, changedVertices);
  }

  public verticesIn(bounds?: TerrainSurfaceBounds): number[] {
    const position = this.geometry.attributes.position;
    if (!bounds) return Array.from({ length: position.count }, (_, i) => i);
    const selected: number[] = [];
    // Clamp to indexed cells before estimating work, including open-ended bounds.
    const minX = Math.max(this.minCellX, Math.floor(bounds.minX / this.cellM));
    const maxX = Math.min(this.maxCellX, Math.floor(bounds.maxX / this.cellM));
    const minZ = Math.max(this.minCellZ, Math.floor(bounds.minZ / this.cellM));
    const maxZ = Math.min(this.maxCellZ, Math.floor(bounds.maxZ / this.cellM));
    if (minX > maxX || minZ > maxZ || bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ
      || Number.isNaN(minX) || Number.isNaN(maxX) || Number.isNaN(minZ) || Number.isNaN(maxZ)) return selected;
    let candidates: readonly VertexBucket[];
    const cells = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (cells <= this.buckets.length && Number.isSafeInteger(minX) && Number.isSafeInteger(maxX)
      && Number.isSafeInteger(minZ) && Number.isSafeInteger(maxZ)) {
      const nearby: VertexBucket[] = [];
      for (let x = minX; x <= maxX; x++) {
        const column = this.columns.get(x);
        if (!column) continue;
        for (let z = minZ; z <= maxZ; z++) {
          const bucket = column.get(z);
          if (bucket) nearby.push(bucket);
        }
      }
      // Keep sampling order stable for trails that revisit an earlier cell.
      nearby.sort((a, b) => a.order - b.order);
      candidates = nearby;
    } else {
      // Large or sparse footprints visit occupied buckets rather than empty cells.
      candidates = this.buckets;
    }
    for (const bucket of candidates) {
      if (bucket.x < minX || bucket.x > maxX || bucket.z < minZ || bucket.z > maxZ) continue;
      for (const i of bucket.indices) {
        if (position.getX(i) >= bounds.minX && position.getX(i) <= bounds.maxX
          && position.getZ(i) >= bounds.minZ && position.getZ(i) <= bounds.maxZ) selected.push(i);
      }
    }
    return selected;
  }

  /** Recompute every normal affected by changed faces, including their unchanged neighbors. */
  public updateNormals(changedVertices: readonly number[]): void {
    const index = this.geometry.index;
    if (!index || !this.incidentFaces || !this.geometry.attributes.normal) {
      this.geometry.computeVertexNormals();
      const normal = this.geometry.attributes.normal as THREE.BufferAttribute;
      normal.clearUpdateRanges(); normal.addUpdateRange(0, normal.array.length); normal.needsUpdate = true;
      return;
    }
    const affected = new Set<number>();
    for (const vertex of changedVertices) for (const face of this.incidentFaces[vertex]) {
      for (let corner = 0; corner < 3; corner++) affected.add(index.getX(face + corner));
    }
    const position = this.geometry.attributes.position, normal = this.geometry.attributes.normal;
    for (const vertex of affected) {
      let nx = 0, ny = 0, nz = 0;
      for (const face of this.incidentFaces[vertex]) {
        const a = index.getX(face), b = index.getX(face + 1), c = index.getX(face + 2);
        const bx = position.getX(b) - position.getX(a), by = position.getY(b) - position.getY(a), bz = position.getZ(b) - position.getZ(a);
        const cx = position.getX(c) - position.getX(a), cy = position.getY(c) - position.getY(a), cz = position.getZ(c) - position.getZ(a);
        nx += by * cz - bz * cy; ny += bz * cx - bx * cz; nz += bx * cy - by * cx;
      }
      const length = Math.hypot(nx, ny, nz) || 1;
      normal.setXYZ(vertex, nx / length, ny / length, nz / length);
    }
    markChangedSpan(normal as THREE.BufferAttribute, affected);
  }
}

/** Multi-span upload bounds GPU buffer transfers while coalescing nearby changes (up to 4 disjoint ranges). */
function markChangedSpan(attribute: THREE.BufferAttribute, vertices: Iterable<number>): void {
  const itemSize = attribute.itemSize;
  const mergeGap = 64 * itemSize;
  const maxRanges = 4;
  const sorted = Array.from(vertices).sort((a, b) => a - b);
  if (sorted.length === 0) return;

  const rawSpans: Array<[number, number]> = [];
  for (const range of attribute.updateRanges) {
    if (range.count > 0) {
      rawSpans.push([range.start, range.start + range.count]);
    }
  }
  let curStart = sorted[0] * itemSize;
  let curEnd = (sorted[0] + 1) * itemSize;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i] * itemSize;
    const e = (sorted[i] + 1) * itemSize;
    if (s - curEnd <= mergeGap) {
      if (e > curEnd) curEnd = e;
    } else {
      rawSpans.push([curStart, curEnd]);
      curStart = s;
      curEnd = e;
    }
  }
  rawSpans.push([curStart, curEnd]);
  rawSpans.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const span of rawSpans) {
    if (merged.length === 0) {
      merged.push([span[0], span[1]]);
    } else {
      const prev = merged[merged.length - 1];
      if (span[0] - prev[1] <= mergeGap) {
        if (span[1] > prev[1]) prev[1] = span[1];
      } else {
        merged.push([span[0], span[1]]);
      }
    }
  }

  while (merged.length > maxRanges) {
    let bestIdx = 0;
    let bestGap = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const gap = merged[i + 1][0] - merged[i][1];
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    merged[bestIdx][1] = Math.max(merged[bestIdx][1], merged[bestIdx + 1][1]);
    merged.splice(bestIdx + 1, 1);
  }

  attribute.clearUpdateRanges();
  for (const [start, end] of merged) {
    attribute.addUpdateRange(start, end - start);
  }
  attribute.needsUpdate = true;
}
