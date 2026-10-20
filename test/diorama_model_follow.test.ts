import { expect, it } from 'vitest';
import * as THREE from 'three';
import { DioramaModelFollow } from '../src/visualization/DioramaModelFollow.ts';

function fixture() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.3, 1.6, 0.2);
  const parent = new THREE.Group(), root = new THREE.Group(), hiker = new THREE.Object3D();
  parent.position.set(0.1, 0.2, 0.3); parent.rotation.y = 0.4; parent.scale.setScalar(1.5);
  parent.add(root); root.add(hiker);
  root.position.set(0, 0.6, -0.6); root.rotation.set(0.05, 0.3, 0); root.scale.setScalar(0.001);
  hiker.position.set(200, 350, -100);
  const follow = new DioramaModelFollow(); follow.start(camera);
  return { camera, parent, root, hiker, follow };
}

it('keeps a moving hiker in an anchored inspection view without changing the viewer, scale or rotation', () => {
  const f = fixture(), camera = f.camera.position.clone();
  const rotation = f.root.quaternion.clone(), scale = f.root.scale.clone();
  const anchor = new THREE.Vector3(0.3, 1.15, -0.6);
  for (let i = 0; i < 720; i++) {
    f.hiker.position.x += 0.1;
    f.follow.update(f.root, f.hiker.getWorldPosition(new THREE.Vector3()), 1 / 72);
  }
  expect(f.hiker.getWorldPosition(new THREE.Vector3()).distanceTo(anchor)).toBeLessThan(0.003);
  expect(f.camera.position.equals(camera)).toBe(true);
  expect(f.root.quaternion.equals(rotation)).toBe(true);
  expect(f.root.scale.equals(scale)).toBe(true);
  // Looking away doesn't drag the terrain around the room.
  f.camera.position.x += 1; f.camera.rotation.y = 1;
  for (let i = 0; i < 72; i++) f.follow.update(f.root, f.hiker.getWorldPosition(new THREE.Vector3()), 1 / 72);
  expect(f.hiker.getWorldPosition(new THREE.Vector3()).distanceTo(anchor)).toBeLessThan(0.003);
});

it('bounds travel after scrubs and ignores invalid time without moving the model', () => {
  const f = fixture();
  f.hiker.position.x = 500_000;
  const before = f.root.getWorldPosition(new THREE.Vector3());
  f.follow.update(f.root, f.hiker.getWorldPosition(new THREE.Vector3()), 1 / 72);
  expect(f.root.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeCloseTo(0.6 / 72);
  const position = f.root.position.clone();
  for (const dt of [0, -1, NaN]) f.follow.update(f.root, f.hiker.getWorldPosition(new THREE.Vector3()), dt);
  expect(f.root.position.distanceTo(position)).toBeLessThan(1e-12);
});

it('reanchors to the new viewing direction on restart and remains finite looking vertically', () => {
  const f = fixture();
  f.camera.rotation.y = Math.PI / 2;
  f.follow.start(f.camera);
  for (let i = 0; i < 720; i++) f.follow.update(f.root, f.hiker.getWorldPosition(new THREE.Vector3()), 1 / 72);
  expect(f.hiker.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(-0.5, 1.15, 0.2))).toBeLessThan(1e-8);
  f.camera.rotation.set(Math.PI / 2, 0, 0); f.follow.start(f.camera);
  f.follow.update(f.root, f.hiker.getWorldPosition(new THREE.Vector3()), 1 / 72);
  expect(f.root.position.toArray().every(Number.isFinite)).toBe(true);
});
