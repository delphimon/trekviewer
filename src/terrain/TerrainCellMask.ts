import type * as THREE from 'three';

export interface TerrainCellMask {
  index: THREE.BufferAttribute;
  version: number;
  start: number;
  count: number;
  segmentsX: number;
  segmentsZ: number;
  cells: Uint8Array;
  hidden: boolean;
}

// One mask per live geometry/revision, shared by all terrain pickers. Weak keys
// do not keep disposed terrain alive. Coverage publication can lend its existing
// mask; externally changed indices fall back to rebuilding one from triangles.
const masks = new WeakMap<THREE.BufferGeometry, TerrainCellMask>();

export function publishTerrainCellMask(geometry: THREE.BufferGeometry, segmentsX: number, segmentsZ: number,
  cells: Uint8Array, hidden: boolean): TerrainCellMask {
  if (!geometry.index || cells.length !== segmentsX * segmentsZ) throw new RangeError('Coverage mask must match an indexed terrain grid');
  const mask = { index: geometry.index!, version: geometry.index!.version,
    start: geometry.drawRange.start, count: geometry.drawRange.count, segmentsX, segmentsZ, cells, hidden };
  masks.set(geometry, mask);
  return mask;
}

export function retainedTerrainCellMask(geometry: THREE.BufferGeometry, segmentsX: number, segmentsZ: number): TerrainCellMask | undefined {
  const mask = masks.get(geometry);
  return mask && mask.index === geometry.index && mask.version === geometry.index!.version
    && mask.start === geometry.drawRange.start && mask.count === geometry.drawRange.count
    && mask.segmentsX === segmentsX && mask.segmentsZ === segmentsZ ? mask : undefined;
}
