import { deepStrictEqual } from 'node:assert/strict';
import { expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSurfacePatchGeometry } from '../src/terrain/SurfacePatchGeometry.ts';
import { buildSurfacePatchGeometry as previous } from '../docs/review-2026-10-13/patches/SurfacePatchGeometry-before.ts';

const cases = [
  { name: 'whole shared grid', bounds: [-800, 800, -900, 900], holes: false },
  { name: 'fractional clipping with refined holes', bounds: [-611.17, 497.63, -395.23, 651.77], holes: true },
  { name: 'interior and clipped vertices sharing edges', bounds: [-700, 700, -750, 750], holes: true },
  { name: 'thin strip crossing cells', bounds: [153.71, 153.73, -710.19, 505.31], holes: true },
  { name: 'small corner triangle', bounds: [-802, -799.97, -902, -899.99], holes: false },
  { name: 'outside every source', bounds: [5000, 5100, -900, 900], holes: true },
  { name: 'zero-area rectangle', bounds: [0, 0, 0, 0], holes: false },
];

it.each(cases)('preserves every output buffer for $name', ({ bounds: [minX, maxX, minZ, maxZ], holes }) => {
  const group = new THREE.Group();
  const makeMesh = (width: number, depth: number, sx: number, sz: number, x: number, y: number, z: number) => {
    const geometry = new THREE.PlaneGeometry(width, depth, sx, sz); geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, Math.sin(pos.getX(i) / 47) * 135 + Math.cos(pos.getZ(i) / 53) * 89);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry); mesh.position.set(x, y, z); group.add(mesh); return mesh;
  };
  const base = makeMesh(1600, 1800, 128, 96, 0, 0, 0);
  if (holes) {
    const detail = makeMesh(600, 350, 49, 37, 175, -55, -90); detail.name = 'LocalHighResTerrainMesh';
    base.geometry.userData.surfaceHoles = [{ minX: -125, maxX: 475, minZ: -265, maxZ: 85 }];
    const hidden = makeMesh(600, 350, 49, 37, -425, 350, -90); hidden.name = 'LocalHighResTerrainMesh'; hidden.visible = false;
  }
  const uv = (x: number, z: number) => ({ u: (x + 12.37) / 2019.53, v: Math.atan(z / 2037.1) });
  const expected = previous(base, { minX, maxX, minZ, maxZ }, uv)!;
  const actual = buildSurfacePatchGeometry(base, { minX, maxX, minZ, maxZ }, uv)!;
  try {
    for (const name of ['position', 'normal', 'uv']) deepStrictEqual(actual.attributes[name].array, expected.attributes[name].array);
    deepStrictEqual(actual.index!.array, expected.index!.array);
    expect(actual.boundingBox).toEqual(expected.boundingBox); expect(actual.boundingSphere).toEqual(expected.boundingSphere);
    expect(actual.attributes.position.count).toBe(expected.attributes.position.count);
  } finally {
    expected.dispose(); actual.dispose();
    for (const child of group.children as THREE.Mesh[]) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); }
  }
});

it('retains 32-bit output indices when a full patch exceeds 65,535 vertices', () => {
  const geometry = new THREE.PlaneGeometry(2000, 2000, 256, 256); geometry.rotateX(-Math.PI / 2);
  const base = new THREE.Mesh(geometry);
  const bounds = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
  const uv = (x: number, z: number) => ({ u: x / 2000 + .5, v: z / 2000 + .5 });
  const actual = buildSurfacePatchGeometry(base, bounds, uv)!, expected = previous(base, bounds, uv)!;
  try {
    expect(actual.index!.array).toBeInstanceOf(Uint32Array);
    for (const name of ['position', 'normal', 'uv']) deepStrictEqual(actual.attributes[name].array, expected.attributes[name].array);
    deepStrictEqual(actual.index!.array, expected.index!.array);
  } finally { actual.dispose(); expected.dispose(); geometry.dispose(); (base.material as THREE.Material).dispose(); }
});
