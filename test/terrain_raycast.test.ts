import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TerrainRaycast } from '../src/terrain/TerrainRaycast.ts';
import { BaseTerrainCoverage } from '../src/terrain/BaseTerrainCoverage.ts';
import { publishTerrainCellMask } from '../src/terrain/TerrainCellMask.ts';

it.each([16, 260])('reuses authoritative coverage across pickers and invalidates changed indices/ranges (%i)', segments => {
  const grid = { width: 8, depth: 8, segmentsX: segments, segmentsZ: segments };
  const geometry = new THREE.PlaneGeometry(8, 8, segments, segments); geometry.rotateX(-Math.PI / 2);
  const original = geometry.index!.array.slice() as Uint16Array | Uint32Array;
  const coverage = new BaseTerrainCoverage(grid, original), index = geometry.index!;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.set(0.3, 0.5, -0.1); mesh.rotation.set(0.1, 0.2, 0.05); mesh.scale.set(0.8, 0.7, 1.1); mesh.updateMatrixWorld(true);
  const pickers = [new TerrainRaycast(), new TerrainRaycast()];
  const check = (expectScan: boolean) => {
    const rays = [[0.173, 0.319], [-3.117, 2.217], [3.217, -2.317]].map(([x, z]) => {
      const origin = mesh.localToWorld(new THREE.Vector3(x, 10, z));
      const target = mesh.localToWorld(new THREE.Vector3(x, 0, z));
      const ray = new THREE.Raycaster(origin, target.sub(origin).normalize());
      return { ray, expected: ray.intersectObject(mesh)[0] ?? null };
    });
    const readIndex = vi.spyOn(index, 'getX');
    try {
      for (const picker of pickers) for (const { ray, expected } of rays) {
        const actual = picker.closest(ray, [mesh]);
        expect(actual === null).toBe(expected === null);
        if (actual && expected) expect(actual.point.distanceTo(expected.point)).toBeLessThan(1e-8);
      }
      expect(readIndex.mock.calls.length > 0).toBe(expectScan);
    } finally { readIndex.mockRestore(); }
  };
  try {
    for (const holes of [[{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }], [], [{ minX: -4, maxX: 0, minZ: -4, maxZ: 4 }]]) {
      geometry.setDrawRange(0, coverage.update(holes, index.array as Uint16Array | Uint32Array));
      index.needsUpdate = true;
      publishTerrainCellMask(geometry, segments, segments, coverage.hiddenCells, true);
      check(false);
    }
    // External edits must invalidate the borrowed coverage and rebuild exact visibility.
    const count = coverage.update([{ minX: 0, maxX: 4, minZ: -4, maxZ: 4 }], index.array as Uint16Array | Uint32Array);
    index.needsUpdate = true; geometry.setDrawRange(0, count);
    check(true); check(false); // The fallback scan is shared too.
    geometry.setDrawRange(0, 6); check(true); check(false);
    const column = Math.floor((3.217 + 4) * segments / 8), row = Math.floor((-2.317 + 4) * segments / 8);
    const offset = (row * segments + column) * 6;
    geometry.setIndex(new THREE.BufferAttribute(original.slice(offset, offset + 6), 1));
    check(false); // A scan on the replacement attribute must not touch the old one.
  } finally { geometry.dispose(); mesh.material.dispose(); }
});

it('respects shortened index buffers and falls back for incomplete cells with an unlimited draw range', () => {
  const geometry = new THREE.PlaneGeometry(8, 8, 4, 4); geometry.rotateX(-Math.PI / 2);
  const original = geometry.index!.array.slice();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld(true);
  try {
    for (const count of [6, 3]) {
      geometry.setIndex(new THREE.BufferAttribute(original.slice(0, count), 1));
      geometry.setDrawRange(0, Infinity);
      const picker = new TerrainRaycast();
      for (const [x, z] of [[-3.7, -3.8], [3.5, 3.2]]) {
        const ray = new THREE.Raycaster(new THREE.Vector3(x, 10, z), new THREE.Vector3(0, -1, 0));
        const expected = ray.intersectObject(mesh)[0] ?? null, actual = picker.closest(ray, [mesh]);
        expect(actual === null).toBe(expected === null);
        if (actual && expected) expect(actual.point.distanceTo(expected.point)).toBeLessThan(1e-10);
      }
    }
  } finally { geometry.dispose(); mesh.material.dispose(); }
});

it('uses native picking when PlaneGeometry constructor metadata has fractional segments', () => {
  const geometry = new THREE.PlaneGeometry(8, 8, 4.5, 4); geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld(true);
  try {
    const ray = new THREE.Raycaster(new THREE.Vector3(1.13, 10, 1.17), new THREE.Vector3(0, -1, 0));
    const native = ray.intersectObject(mesh)[0];
    expect(new TerrainRaycast().closest(ray, [mesh])!.point.distanceTo(native.point)).toBeLessThan(1e-10);
  } finally { geometry.dispose(); mesh.material.dispose(); }
});

it('keeps exact nearest terrain hits as rendered indices, elevation, and visible refinement change', () => {
  const root = new THREE.Group();
  root.position.set(0.4, 0.7, -0.3);
  root.rotation.set(0.22, 0.31, -0.13);
  root.scale.setScalar(0.7);

  const baseGeo = new THREE.PlaneGeometry(8, 8, 32, 32);
  baseGeo.rotateX(-Math.PI / 2);
  const basePos = baseGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < basePos.count; i++) {
    basePos.setY(i, 0.15 * Math.sin(basePos.getX(i)) + 0.08 * Math.cos(basePos.getZ(i)));
  }
  basePos.needsUpdate = true;
  baseGeo.computeBoundingSphere();
  const base = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  root.add(base);

  const localGeo = new THREE.PlaneGeometry(2, 2, 32, 32);
  localGeo.rotateX(-Math.PI / 2);
  const localPos = localGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < localPos.count; i++) localPos.setY(i, 0.6 + 0.1 * Math.sin(localPos.getX(i) * 3));
  localPos.needsUpdate = true;
  localGeo.computeBoundingSphere();
  const local = new THREE.Mesh(localGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  local.name = 'LocalHighResTerrainMesh';
  local.visible = false;
  root.add(local);

  const fast = new TerrainRaycast();
  const check = () => {
    root.updateWorldMatrix(true, true);
    const surfaces = [base, local].filter(mesh => mesh.visible);
    const rays = [[0, 0, 0, 0.5, 0.3], [0, 0.4, 0.3, 0, 0], [0, 1.7, -0.8, 0, 0],
      [0, -2.2, 1.1, 0, 0], [0, 3.7, 3.7, 0, 0]];
    for (let i = 0; i < 36; i++) {
      rays.push([i, -3.8 + (i * 1.73) % 7.6, -3.8 + (i * 2.29) % 7.6,
        Math.sin(i * 1.3) * 2, Math.cos(i * 0.7) * 2]);
    }
    for (const [i, x, z, offsetX, offsetZ] of rays) {
      const origin = root.localToWorld(new THREE.Vector3(x, i % 7 === 0 ? -8 : 8, z));
      const target = root.localToWorld(new THREE.Vector3(x + offsetX, 0, z + offsetZ));
      const raycaster = new THREE.Raycaster(origin, target.sub(origin).normalize());
      const expected = raycaster.intersectObjects(surfaces, false)[0] ?? null;
      const actual = fast.closest(raycaster, surfaces);
      expect(actual === null, `ray i=${i} x=${x} z=${z}`).toBe(expected === null);
      if (expected && actual) {
        expect(actual.point.distanceTo(expected.point)).toBeLessThan(1e-5);
        expect(actual.mesh).toBe(expected.object);
      }
    }
  };

  check();

  const index = baseGeo.index!;
  const original = index.array.slice();
  let count = 0;
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const cx = (x + 0.5) / 4 - 4;
    const cz = (z + 0.5) / 4 - 4;
    if (Math.abs(cx) <= 1 && Math.abs(cz) <= 1) continue;
    for (let j = 0; j < 6; j++) index.setX(count++, original[(z * 32 + x) * 6 + j]);
  }
  index.needsUpdate = true;
  baseGeo.setDrawRange(0, count);
  local.visible = true;
  check();

  for (let i = 0; i < localPos.count; i++) localPos.setY(i, localPos.getY(i) + 0.4);
  localPos.needsUpdate = true;
  localGeo.computeBoundingSphere();
  check();

  local.visible = false;
  index.array.set(original);
  index.needsUpdate = true;
  baseGeo.setDrawRange(0, original.length);
  check();

  (base.material as THREE.MeshBasicMaterial).side = THREE.FrontSide;
  check();
  (base.material as THREE.MeshBasicMaterial).side = THREE.BackSide;
  check();
});

it('stops after the nearest cell hit and preserves native hits with nonuniform transforms and near/far limits', () => {
  const geometry = new THREE.PlaneGeometry(400, 400, 446, 446); geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  positions.setY(0, 1000); positions.setY(positions.count - 1, -1000); positions.needsUpdate = true;
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.set(0.4, 0.7, -0.3); mesh.rotation.set(0.22, 0.31, -0.13); mesh.scale.set(0.001, 0.0008, 0.0012); mesh.updateMatrixWorld(true);
  const origin = mesh.localToWorld(new THREE.Vector3(-180, 30, 180));
  const target = mesh.localToWorld(new THREE.Vector3(-179, 29.2, 179));
  const raycaster = new THREE.Raycaster(origin, target.sub(origin).normalize());
  const expected = raycaster.intersectObject(mesh)[0]; expect(expected).toBeTruthy();
  const triangles = vi.spyOn(THREE.Ray.prototype, 'intersectTriangle');
  try {
    const actual = new TerrainRaycast().closest(raycaster, [mesh])!;
    expect(actual.point.distanceTo(expected.point)).toBeLessThan(1e-8);
    expect(actual.distance).toBeCloseTo(expected.distance, 8);
    expect(triangles.mock.calls.length).toBeLessThan(300); // old traversal visits over 800 triangles
    for (const [near, far] of [[expected.distance + 0.0001, Infinity], [0, expected.distance - 0.0001]]) {
      raycaster.near = near; raycaster.far = far;
      const native = raycaster.intersectObject(mesh)[0] ?? null;
      const hit = new TerrainRaycast().closest(raycaster, [mesh]);
      expect(hit === null).toBe(native === null);
      if (hit && native) expect(hit.point.distanceTo(native.point)).toBeLessThan(1e-8);
    }
  } finally { triangles.mockRestore(); geometry.dispose(); mesh.material.dispose(); }
});

it('keeps returned points independent across surfaces, queries, and raycaster instances', () => {
  const geometry = new THREE.PlaneGeometry(8, 8, 16, 16); geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const lower = new THREE.Mesh(geometry, material), upper = new THREE.Mesh(geometry, material);
  upper.position.y = 2; upper.updateMatrixWorld(true); lower.updateMatrixWorld(true);
  const picker = new TerrainRaycast(), otherPicker = new TerrainRaycast();
  const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 10, 0.3), new THREE.Vector3(0, -1, 0));
  const saved = picker.closest(ray, [upper, lower])!;
  const point = saved.point.clone();
  try {
    expect(saved.mesh).toBe(upper);
    for (const surfaces of [[lower, upper], [upper, lower]]) {
      const current = picker.closest(ray, surfaces)!;
      expect(current.mesh).toBe(upper);
      expect(current.point).not.toBe(saved.point);
      expect(current.point.distanceTo(new THREE.Vector3(ray.ray.origin.x, 2, 0.3))).toBeLessThan(1e-12);
      current.point.set(100, 100, 100);
      ray.ray.origin.x += 0.25;
      otherPicker.closest(ray, surfaces);
      picker.closest(ray, []);
      expect(saved.point.equals(point)).toBe(true);
    }
    upper.visible = false;
    expect(picker.closest(ray, [upper, lower])!.mesh).toBe(lower);
    expect(saved.point.equals(point)).toBe(true);
  } finally { geometry.dispose(); material.dispose(); }
});

it('preserves grid hits around a native fallback that issues a nested query', () => {
  const geometry = new THREE.PlaneGeometry(8, 8, 16, 16); geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const base = new THREE.Mesh(geometry, material), raised = new THREE.Mesh(geometry, material);
  raised.position.y = 2; raised.updateMatrixWorld(true); base.updateMatrixWorld(true);
  const fallbackGeometry = geometry.clone().toNonIndexed(); // generic BufferGeometry uses native raycast
  const fallback = new THREE.Mesh(fallbackGeometry, material); fallback.updateMatrixWorld(true);
  const picker = new TerrainRaycast();
  const ray = new THREE.Raycaster(new THREE.Vector3(0.1, 10, -0.2), new THREE.Vector3(0, -1, 0));
  const nestedRay = new THREE.Raycaster(new THREE.Vector3(2.5, 10, 2.5), new THREE.Vector3(0, -1, 0));
  const nativeRaycast = fallback.raycast;
  const nestedPoints: THREE.Vector3[] = [];
  fallback.raycast = function (caster, hits) {
    nestedPoints.push(picker.closest(nestedRay, [base])!.point);
    nativeRaycast.call(this, caster, hits);
  };
  try {
    for (const surfaces of [[raised, fallback, base], [base, fallback, raised]]) {
      const result = picker.closest(ray, surfaces)!;
      expect(result.mesh).toBe(raised);
      expect(result.point.distanceTo(new THREE.Vector3(0.1, 2, -0.2))).toBeLessThan(1e-12);
    }
    expect(nestedPoints).toHaveLength(2);
    for (const point of nestedPoints) expect(point.distanceTo(new THREE.Vector3(2.5, 0, 2.5))).toBeLessThan(1e-12);
    expect(nestedPoints[0]).not.toBe(nestedPoints[1]);
  } finally { geometry.dispose(); fallbackGeometry.dispose(); material.dispose(); }
});
