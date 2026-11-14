import { expect, it } from 'vitest';
import * as THREE from 'three';
import { DioramaCameraFollow, FOLLOW_PITCH_RAD } from '../src/visualization/DioramaCameraFollow.ts';

function fixture(height = (_x: number, _z: number) => 0) {
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 0.3, 0.4);
  const target = new THREE.Vector3(), focus = new THREE.Vector3();
  const follower = new DioramaCameraFollow();
  follower.setTerrain({ group: new THREE.Group(), sampleRenderedSurfaceY: height, getVerticalExaggeration: () => 1 });
  follower.start(camera, target);
  return { camera, target, focus, follower };
}
const settle = (f: ReturnType<typeof fixture>, travel: THREE.Vector3, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) f.follower.update(f.camera, f.target, f.focus, 1 / 60, travel);
};

it('follows from behind the direction of travel at about 35 degrees above the horizon', () => {
  const f = fixture();
  settle(f, new THREE.Vector3(1, 0, 0), 5);
  const offset = f.camera.position.clone().sub(f.focus);
  expect(offset.x).toBeLessThan(0); // behind an eastbound hiker
  expect(Math.abs(offset.z)).toBeLessThan(1e-3);
  expect(Math.atan2(offset.y, Math.hypot(offset.x, offset.z))).toBeCloseTo(FOLLOW_PITCH_RAD, 2);
});

it('smooths the heading over about two seconds so a switchback does not swing the camera', () => {
  const f = fixture();
  settle(f, new THREE.Vector3(1, 0, 0), 5);
  const before = f.camera.position.clone();
  settle(f, new THREE.Vector3(0, 0, 1), 0.25); // a short switchback leg
  expect(f.camera.position.distanceTo(before)).toBeLessThan(0.25 * before.distanceTo(f.focus));
  settle(f, new THREE.Vector3(0, 0, 1), 5);
  expect(f.camera.position.z).toBeLessThan(-0.1); // eventually behind a southbound hiker
});

it('keeps terrain clearance while following', () => {
  const f = fixture((x) => x < 0 ? 0.5 : 0); // a ridge behind the hiker
  settle(f, new THREE.Vector3(1, 0, 0), 5);
  expect(f.camera.position.y).toBeGreaterThan(0.5);
});
