import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DioramaCameraFollow, FOLLOW_SURFACE_CLEARANCE, FOLLOW_SURFACE_SAMPLES } from '../src/visualization/DioramaCameraFollow.ts';

function fixture(sampleHeight: (x: number, z: number) => number = (_x, z) => z >= 0.1 && z <= 0.2 ? 0.3 : 0) {
  const group = new THREE.Group();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0.18, 0.25);
  const target = new THREE.Vector3(), focus = new THREE.Vector3();
  const follower = new DioramaCameraFollow();
  const sample = vi.fn(sampleHeight);
  const terrain = { group, sampleRenderedSurfaceY: sample, getVerticalExaggeration: () => 1 };
  follower.setTerrain(terrain);
  follower.start(camera, target);
  return { group, camera, target, focus, follower, terrain, sample };
}

function minimumClearance(camera: THREE.Camera, focus: THREE.Vector3, group: THREE.Group,
  sample: (x: number, z: number) => number, exaggeration = 1) {
  group.updateWorldMatrix(true, false);
  const a = group.worldToLocal(focus.clone()), b = group.worldToLocal(camera.position.clone());
  let minimum = Infinity;
  for (let i = 1; i <= FOLLOW_SURFACE_SAMPLES; i++) {
    const t = i / FOLLOW_SURFACE_SAMPLES, point = a.clone().lerp(b, t);
    minimum = Math.min(minimum, point.y - sample(point.x, point.z) * exaggeration);
  }
  return minimum;
}

describe('desktop follow terrain clearance', () => {
  it('lifts over an intervening ridge even when the camera endpoint is above ground', () => {
    const f = fixture();
    expect(minimumClearance(f.camera, f.focus, f.group, f.terrain.sampleRenderedSurfaceY)).toBeCloseTo(-0.22125);
    f.sample.mockClear();
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    expect(f.sample).toHaveBeenCalledTimes(2 * FOLLOW_SURFACE_SAMPLES);
    expect(minimumClearance(f.camera, f.focus, f.group, f.terrain.sampleRenderedSurfaceY)).toBeGreaterThan(0);
    expect(f.camera.position.x).toBe(0);
    expect(f.camera.position.z).toBe(0.25);
    expect(f.camera.position.y).toBeGreaterThan(0.6);
  });

  it('corrects the actual camera during a scrub and keeps full endpoint clearance', () => {
    const f = fixture(() => 0.4);
    f.follower.update(f.camera, f.target, f.focus, 0);
    expect(f.camera.position.y).toBeGreaterThanOrEqual(0.4 + FOLLOW_SURFACE_CLEARANCE);
    expect(minimumClearance(f.camera, f.focus, f.group, f.terrain.sampleRenderedSurfaceY)).toBeGreaterThan(0);
  });

  it('uses current streamed heights and exaggeration, then descends smoothly when clear', () => {
    let height = 0.3, exaggeration = 1;
    const f = fixture((_x, z) => z >= 0.1 && z <= 0.2 ? height : 0);
    f.terrain.getVerticalExaggeration = () => exaggeration;
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    const firstHeight = f.camera.position.y;
    height = 0.5; exaggeration = 3;
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    expect(f.camera.position.y).toBeGreaterThan(firstHeight);
    expect(minimumClearance(f.camera, f.focus, f.group, f.terrain.sampleRenderedSurfaceY, exaggeration)).toBeGreaterThan(0);
    const raised = f.camera.position.y;
    height = 0;
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    expect(f.camera.position.y).toBeLessThan(raised);
    expect(f.camera.position.y).toBeGreaterThan(0.18);
  });

  it('samples in terrain space with translated, rotated and scaled parent groups', () => {
    const f = fixture();
    const parent = new THREE.Group(); parent.add(f.group);
    parent.position.set(0.2, -0.3, -1);
    parent.rotation.set(0.1, 0.4, 0.05); parent.scale.setScalar(0.002);
    parent.updateWorldMatrix(true, true);
    f.camera.position.copy(f.group.localToWorld(new THREE.Vector3(0, 0.18, 0.25)));
    f.focus.copy(f.group.localToWorld(new THREE.Vector3()));
    f.target.copy(f.focus);
    const before = parent.matrixWorld.clone();
    // A zero-time correction isolates the actual camera from follow framing.
    f.follower.update(f.camera, f.target, f.focus, 0);
    expect(minimumClearance(f.camera, f.focus, f.group, f.terrain.sampleRenderedSurfaceY)).toBeGreaterThan(0);
    expect(parent.matrixWorld.equals(before)).toBe(true);
    expect(f.group.position.length()).toBe(0);
  });

  it('releases the old terrain on replacement and teardown', () => {
    const f = fixture();
    f.follower.setTerrain({ group: new THREE.Group(), sampleRenderedSurfaceY: () => 0 });
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    expect(f.sample).not.toHaveBeenCalled();
    f.follower.setTerrain(null);
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    expect(f.sample).not.toHaveBeenCalled();
  });

  it('ignores unavailable heights and degenerate transforms without corrupting the camera', () => {
    const f = fixture(() => NaN);
    f.follower.update(f.camera, f.target, f.focus, NaN);
    expect(f.camera.position.toArray()).toEqual([0, 0.18, 0.25]);
    f.sample.mockClear(); f.group.scale.setScalar(0);
    f.follower.update(f.camera, f.target, f.focus, 1 / 60);
    expect(f.sample).not.toHaveBeenCalled();
    expect(f.camera.position.toArray().every(Number.isFinite)).toBe(true);
  });
});
