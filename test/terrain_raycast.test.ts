import { expect, it } from 'vitest';
import * as THREE from 'three';
import { TerrainRaycast } from '../src/terrain/TerrainRaycast.ts';

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
