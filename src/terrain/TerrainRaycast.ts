import * as THREE from 'three';

export interface TerrainHit {
  point: THREE.Vector3;
  distance: number;
}

interface CellMask {
  index: THREE.BufferAttribute;
  version: number;
  start: number;
  count: number;
  cells: Uint8Array;
}

/**
 * Exact ray hits on the regular PlaneGeometry grids used by the base and local terrain.
 * The ray crosses at most widthSegments + heightSegments cells, even when a local
 * chunk changes the base mesh's visible index range. No spatial tree is rebuilt.
 */
export class TerrainRaycast {
  private readonly masks = new WeakMap<THREE.BufferGeometry, CellMask>();
  private readonly boxVersions = new WeakMap<THREE.BufferGeometry, { position: THREE.BufferAttribute; version: number }>();

  public closest(raycaster: THREE.Raycaster, surfaces: readonly THREE.Mesh[]): TerrainHit | null {
    let nearest: TerrainHit | null = null;
    for (const mesh of surfaces) {
      if (!mesh.visible) continue;
      const hit = this.intersectGrid(raycaster, mesh);
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
    }
    return nearest;
  }

  private intersectGrid(raycaster: THREE.Raycaster, mesh: THREE.Mesh): TerrainHit | null {
    const geometry = mesh.geometry;
    if (!(geometry instanceof THREE.PlaneGeometry) || Array.isArray(mesh.material)) {
      return this.nativeHit(raycaster, mesh);
    }
    const { width, height: depth, widthSegments: sx, heightSegments: sz } = geometry.parameters;
    if (!Number.isFinite(width) || !Number.isFinite(depth) || sx < 1 || sz < 1) {
      return this.nativeHit(raycaster, mesh);
    }
    const mask = this.getCellMask(geometry, sx, sz);
    if (mask === undefined) return this.nativeHit(raycaster, mesh);
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const boxVersion = this.boxVersions.get(geometry);
    if (!geometry.boundingBox || boxVersion?.position !== positions || boxVersion.version !== positions.version) {
      geometry.computeBoundingBox();
      this.boxVersions.set(geometry, { position: positions, version: positions.version });
    }
    const localRay = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const range = intersectBoxRange(localRay, geometry.boundingBox!);
    if (!range) return null;

    const cellW = width / sx, cellD = depth / sz;
    const firstT = Math.max(0, range[0]);
    const lastT = range[1];
    const start = localRay.at(Math.min(lastT, firstT + 1e-7), new THREE.Vector3());
    let x = clampCell(Math.floor((start.x + width / 2) / cellW), sx);
    let z = clampCell(Math.floor((start.z + depth / 2) / cellD), sz);
    const stepX = Math.sign(localRay.direction.x);
    const stepZ = Math.sign(localRay.direction.z);
    const nextX = stepX > 0 ? -width / 2 + (x + 1) * cellW : -width / 2 + x * cellW;
    const nextZ = stepZ > 0 ? -depth / 2 + (z + 1) * cellD : -depth / 2 + z * cellD;
    let crossX = stepX ? (nextX - localRay.origin.x) / localRay.direction.x : Infinity;
    let crossZ = stepZ ? (nextZ - localRay.origin.z) / localRay.direction.z : Infinity;
    const deltaX = stepX ? cellW / Math.abs(localRay.direction.x) : Infinity;
    const deltaZ = stepZ ? cellD / Math.abs(localRay.direction.z) : Infinity;

    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const c = new THREE.Vector3(), d = new THREE.Vector3();
    const scratch = new THREE.Vector3();
    let nearest: TerrainHit | null = null;
    // A diagonal ray can cross at most sx + sz - 1 cells. The extra iterations
    // accommodate an entry exactly on a grid boundary.
    for (let steps = 0; steps <= sx + sz + 2 && x >= 0 && x < sx && z >= 0 && z < sz; steps++) {
      if (!mask || mask[z * sx + x]) {
        const vertex = z * (sx + 1) + x;
        a.fromBufferAttribute(positions, vertex);
        b.fromBufferAttribute(positions, vertex + 1);
        c.fromBufferAttribute(positions, vertex + sx + 1);
        d.fromBufferAttribute(positions, vertex + sx + 2);
        const side = mesh.material.side;
        for (let triangle = 0; triangle < 2; triangle++) {
          const p0 = triangle === 0 ? a : c;
          const p1 = triangle === 0 ? c : d;
          const p2 = b;
          const point = side === THREE.BackSide
            ? localRay.intersectTriangle(p2, p1, p0, true, scratch)
            : localRay.intersectTriangle(p0, p1, p2, side === THREE.FrontSide, scratch);
          if (!point) continue;
          const worldPoint = point.clone().applyMatrix4(mesh.matrixWorld);
          const distance = worldPoint.distanceTo(raycaster.ray.origin);
          if (distance >= raycaster.near && distance <= raycaster.far &&
              (!nearest || distance < nearest.distance)) {
            nearest = { point: worldPoint, distance };
          }
        }
      }
      const nextCrossing = Math.min(crossX, crossZ);
      if (nextCrossing > lastT + 1e-7 || !Number.isFinite(nextCrossing)) break;
      if (crossX <= nextCrossing + 1e-9) { x += stepX; crossX += deltaX; }
      if (crossZ <= nextCrossing + 1e-9) { z += stepZ; crossZ += deltaZ; }
    }
    return nearest;
  }

  private getCellMask(geometry: THREE.PlaneGeometry, sx: number, sz: number): Uint8Array | null | undefined {
    const index = geometry.index;
    if (!index) return undefined;
    const { start, count } = geometry.drawRange;
    if (start === 0 && count >= sx * sz * 6) return null;
    const cached = this.masks.get(geometry);
    if (cached && cached.index === index && cached.version === index.version &&
        cached.start === start && cached.count === count) return cached.cells;
    // TerrainGenerator compacts whole cells when a visible local DEM chunk
    // replaces coarse terrain. The first index in each six-index cell identifies it.
    if (start % 6 !== 0 || count % 6 !== 0) return undefined;
    const cells = new Uint8Array(sx * sz);
    for (let offset = start; offset < Math.min(index.count, start + count); offset += 6) {
      const vertex = index.getX(offset);
      const z = Math.floor(vertex / (sx + 1));
      const x = vertex % (sx + 1);
      if (x < sx && z < sz) cells[z * sx + x] = 1;
    }
    this.masks.set(geometry, { index, version: index.version, start, count, cells });
    return cells;
  }

  private nativeHit(raycaster: THREE.Raycaster, mesh: THREE.Mesh): TerrainHit | null {
    const hits: THREE.Intersection[] = [];
    mesh.raycast(raycaster, hits);
    if (!hits.length) return null;
    const hit = hits.reduce((best, current) => current.distance < best.distance ? current : best);
    return { point: hit.point, distance: hit.distance };
  }
}

function clampCell(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index));
}

function intersectBoxRange(ray: THREE.Ray, box: THREE.Box3): [number, number] | null {
  let enter = 0, exit = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const origin = ray.origin[axis], direction = ray.direction[axis];
    if (Math.abs(direction) < 1e-12) {
      if (origin < box.min[axis] - 1e-7 || origin > box.max[axis] + 1e-7) return null;
      continue;
    }
    let a = (box.min[axis] - origin) / direction;
    let b = (box.max[axis] - origin) / direction;
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a);
    exit = Math.min(exit, b);
    if (exit < enter) return null;
  }
  return [enter, exit];
}
