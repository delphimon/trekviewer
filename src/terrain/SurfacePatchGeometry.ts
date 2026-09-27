import * as THREE from 'three';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

type Vertex = { x: number; y: number; z: number; nx: number; ny: number; nz: number };

/** Clip the actual terrain triangles, preserving elevations and smooth normals.
 * Visit only grid cells intersecting the tile, including the visible refinement.
 * No raycasts, DEM resampling, or independent approximating mesh are needed.
 */
export function buildSurfacePatchGeometry(
  base: THREE.Mesh,
  bounds: TerrainSurfaceBounds,
  uvForPoint: (x: number, z: number) => { u: number; v: number },
): THREE.BufferGeometry | null {
  if (!(base.geometry instanceof THREE.PlaneGeometry)) return null;
  const sources = [base, ...(base.parent?.children.filter(
    (obj): obj is THREE.Mesh => obj instanceof THREE.Mesh && obj.visible && obj.name === 'LocalHighResTerrainMesh',
  ) ?? [])];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const emitted = new Map<Vertex, number>();
  const emit = (vertex: Vertex): number => {
    const existing = emitted.get(vertex);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    emitted.set(vertex, index);
    positions.push(vertex.x, vertex.y + 0.04, vertex.z);
    normals.push(vertex.nx, vertex.ny, vertex.nz);
    const uv = uvForPoint(vertex.x, vertex.z);
    uvs.push(uv.u, uv.v);
    return index;
  };
  for (const mesh of sources) {
    const geo = mesh.geometry as THREE.PlaneGeometry;
    const { width, height: depth, widthSegments: sx, heightSegments: sz } = geo.parameters;
    const ox = mesh.position.x - width / 2, oz = mesh.position.z - depth / 2;
    const dx = width / sx, dz = depth / sz;
    const x0 = Math.max(0, Math.floor((bounds.minX - ox) / dx));
    const x1 = Math.min(sx, Math.ceil((bounds.maxX - ox) / dx));
    const z0 = Math.max(0, Math.floor((bounds.minZ - oz) / dz));
    const z1 = Math.min(sz, Math.ceil((bounds.maxZ - oz) / dz));
    const holes: TerrainSurfaceBounds[] = geo.userData.surfaceHoles ?? [];
    const pos = geo.attributes.position, normal = geo.attributes.normal;
    const vertices = new Map<number, Vertex>();
    const read = (i: number): Vertex => {
      let vertex = vertices.get(i);
      if (!vertex) {
        vertex = {
          x: pos.getX(i) + mesh.position.x, y: pos.getY(i) + mesh.position.y,
          z: pos.getZ(i) + mesh.position.z,
          nx: normal.getX(i), ny: normal.getY(i), nz: normal.getZ(i),
        };
        vertices.set(i, vertex);
      }
      return vertex;
    };
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const cx = ox + (x + 0.5) * dx, cz = oz + (z + 0.5) * dz;
      if (holes.some(b => cx >= b.minX && cx <= b.maxX && cz >= b.minZ && cz <= b.maxZ)) continue;
      const a = z * (sx + 1) + x, b = a + 1, c = a + sx + 1, d = c + 1;
      if (ox + x * dx >= bounds.minX && ox + (x + 1) * dx <= bounds.maxX &&
          oz + z * dz >= bounds.minZ && oz + (z + 1) * dz <= bounds.maxZ) {
        // Interior cells share vertices exactly as the source mesh does.
        const ia = emit(read(a)), ib = emit(read(b)), ic = emit(read(c)), id = emit(read(d));
        indices.push(ia, ic, ib, ib, ic, id);
        continue;
      }
      for (const triangle of [[a, c, b], [b, c, d]]) {
        let polygon = triangle.map(read);
        for (const [axis, edge, keepAbove] of [
          ['x', bounds.minX, true], ['x', bounds.maxX, false],
          ['z', bounds.minZ, true], ['z', bounds.maxZ, false],
        ] as const) {
          polygon = clip(polygon, axis, edge, keepAbove);
          if (polygon.length < 3) break;
        }
        for (let i = 1; i < polygon.length - 1; i++) {
          indices.push(emit(polygon[0]), emit(polygon[i]), emit(polygon[i + 1]));
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function clip(vertices: Vertex[], axis: 'x' | 'z', edge: number, keepAbove: boolean): Vertex[] {
  if (!vertices.length) return vertices;
  const out: Vertex[] = [];
  let previous = vertices[vertices.length - 1];
  let previousInside = keepAbove ? previous[axis] >= edge : previous[axis] <= edge;
  for (const current of vertices) {
    const inside = keepAbove ? current[axis] >= edge : current[axis] <= edge;
    if (inside !== previousInside) {
      const t = (edge - previous[axis]) / (current[axis] - previous[axis]);
      const intersection = {} as Vertex;
      for (const k of ['x', 'y', 'z', 'nx', 'ny', 'nz'] as const) {
        intersection[k] = previous[k] + t * (current[k] - previous[k]);
      }
      intersection[axis] = edge;
      out.push(intersection);
    }
    if (inside) out.push(current);
    previous = current;
    previousInside = inside;
  }
  return out;
}
