import * as THREE from 'three';
import type { TerrainSurfaceBounds } from './TerrainGenerator.ts';

type Vertex = {
  x: number; y: number; z: number; nx: number; ny: number; nz: number;
  sourceIndex?: number; outputIndex?: number;
};

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
  const append = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const index = positions.length / 3;
    positions.push(x, y + 0.04, z);
    normals.push(nx, ny, nz);
    const uv = uvForPoint(x, z);
    uvs.push(uv.u, uv.v);
    return index;
  };
  const clipEdges = [
    ['x', bounds.minX, true], ['x', bounds.maxX, false],
    ['z', bounds.minZ, true], ['z', bounds.maxZ, false],
  ] as const;
  for (const mesh of sources) {
    const geo = mesh.geometry as THREE.PlaneGeometry;
    const { width, height: depth, widthSegments: sx, heightSegments: sz } = geo.parameters;
    const ox = mesh.position.x - width / 2, oz = mesh.position.z - depth / 2;
    const dx = width / sx, dz = depth / sz;
    const x0 = Math.max(0, Math.floor((bounds.minX - ox) / dx));
    const x1 = Math.min(sx, Math.ceil((bounds.maxX - ox) / dx));
    const z0 = Math.max(0, Math.floor((bounds.minZ - oz) / dz));
    const z1 = Math.min(sz, Math.ceil((bounds.maxZ - oz) / dz));
    if (x0 >= x1 || z0 >= z1) continue;
    const holes: TerrainSurfaceBounds[] = geo.userData.surfaceHoles ?? [];
    const pos = geo.attributes.position, normal = geo.attributes.normal;
    // Cache only the intersecting rectangle, rather than the entire source grid.
    // Interior vertices go straight to output without allocating clipping objects.
    const cacheWidth = x1 - x0 + 1;
    const emitted = new Int32Array(cacheWidth * (z1 - z0 + 1)).fill(-1);
    const emitOriginal = (i: number): number => {
      const slot = (Math.floor(i / (sx + 1)) - z0) * cacheWidth + i % (sx + 1) - x0;
      const existing = emitted[slot];
      if (existing !== -1) return existing;
      const index = append(pos.getX(i) + mesh.position.x, pos.getY(i) + mesh.position.y,
        pos.getZ(i) + mesh.position.z, normal.getX(i), normal.getY(i), normal.getZ(i));
      emitted[slot] = index;
      return index;
    };
    const emit = (vertex: Vertex): number => {
      if (vertex.outputIndex !== undefined) return vertex.outputIndex;
      if (vertex.sourceIndex !== undefined) {
        const i = vertex.sourceIndex;
        const slot = (Math.floor(i / (sx + 1)) - z0) * cacheWidth + i % (sx + 1) - x0;
        if (emitted[slot] !== -1) return vertex.outputIndex = emitted[slot];
        return vertex.outputIndex = emitted[slot] = append(vertex.x, vertex.y, vertex.z, vertex.nx, vertex.ny, vertex.nz);
      }
      return vertex.outputIndex = append(vertex.x, vertex.y, vertex.z, vertex.nx, vertex.ny, vertex.nz);
    };
    const vertices = new Map<number, Vertex>();
    const read = (i: number): Vertex => {
      let vertex = vertices.get(i);
      if (!vertex) {
        vertex = {
          x: pos.getX(i) + mesh.position.x, y: pos.getY(i) + mesh.position.y,
          z: pos.getZ(i) + mesh.position.z,
          nx: normal.getX(i), ny: normal.getY(i), nz: normal.getZ(i),
          sourceIndex: i,
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
        const ia = emitOriginal(a), ib = emitOriginal(b), ic = emitOriginal(c), id = emitOriginal(d);
        indices.push(ia, ic, ib, ib, ic, id);
        continue;
      }
      for (let triangle = 0; triangle < 2; triangle++) {
        let polygon = triangle === 0 ? [read(a), read(c), read(b)] : [read(b), read(c), read(d)];
        for (const [axis, edge, keepAbove] of clipEdges) {
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
      const intersection: Vertex = {
        x: previous.x + t * (current.x - previous.x),
        y: previous.y + t * (current.y - previous.y),
        z: previous.z + t * (current.z - previous.z),
        nx: previous.nx + t * (current.nx - previous.nx),
        ny: previous.ny + t * (current.ny - previous.ny),
        nz: previous.nz + t * (current.nz - previous.nz),
      };
      intersection[axis] = edge;
      out.push(intersection);
    }
    if (inside) out.push(current);
    previous = current;
    previousInside = inside;
  }
  return out;
}
