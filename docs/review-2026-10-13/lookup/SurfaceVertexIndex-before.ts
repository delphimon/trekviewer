import * as THREE from 'three';
import type { TerrainSurfaceBounds } from '../terrain/TerrainGenerator.ts';

/** Static X/Z buckets for a ribbon whose only changing coordinate is elevation. */
export class SurfaceVertexIndex {
  private readonly buckets = new Map<string, number[]>();
  private readonly incidentFaces: number[][] | null;
  constructor(private readonly geometry: THREE.BufferGeometry, private readonly cellM = 500, trackNormals = true) {
    const position = geometry.attributes.position;
    (position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    geometry.computeBoundingBox();
    geometry.boundingSphere ??= new THREE.Sphere();
    geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere);
    this.incidentFaces = trackNormals ? Array.from({ length: position.count }, () => []) : null;
    for (let i = 0; i < position.count; i++) {
      const key = `${Math.floor(position.getX(i) / cellM)}:${Math.floor(position.getZ(i) / cellM)}`;
      const bucket = this.buckets.get(key) ?? [];
      bucket.push(i); this.buckets.set(key, bucket);
    }
    const index = geometry.index;
    if (index && this.incidentFaces) for (let face = 0; face < index.count; face += 3) {
      for (let corner = 0; corner < 3; corner++) this.incidentFaces[index.getX(face + corner)].push(face);
    }
  }

  /** Elevation-only changes expand conservative bounds without rescanning the entire ribbon. */
  public updatePositions(changedVertices: readonly number[]): void {
    const position = this.geometry.attributes.position;
    const box = this.geometry.boundingBox!;
    let changed = false;
    for (const vertex of changedVertices) {
      const y = position.getY(vertex);
      box.min.y = Math.min(box.min.y, y); box.max.y = Math.max(box.max.y, y);
      changed = true;
    }
    if (!changed) return;
    box.getBoundingSphere(this.geometry.boundingSphere!);
    markChangedSpan(position as THREE.BufferAttribute, changedVertices);
  }

  public verticesIn(bounds?: TerrainSurfaceBounds): number[] {
    const position = this.geometry.attributes.position;
    if (!bounds) return Array.from({ length: position.count }, (_, i) => i);
    const selected: number[] = [];
    for (const [key, indices] of this.buckets) {
      const [x, z] = key.split(':').map(Number);
      if ((x + 1) * this.cellM < bounds.minX || x * this.cellM > bounds.maxX
        || (z + 1) * this.cellM < bounds.minZ || z * this.cellM > bounds.maxZ) continue;
      for (const i of indices) {
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

/** One merged span bounds upload calls and retains every change made before the next render. */
function markChangedSpan(attribute: THREE.BufferAttribute, vertices: Iterable<number>): void {
  let first = Infinity, last = -1;
  for (const vertex of vertices) { first = Math.min(first, vertex); last = Math.max(last, vertex); }
  if (last < 0) return;
  let start = first * attribute.itemSize, end = (last + 1) * attribute.itemSize;
  for (const range of attribute.updateRanges) { start = Math.min(start, range.start); end = Math.max(end, range.start + range.count); }
  attribute.clearUpdateRanges(); attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}
