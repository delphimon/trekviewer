import { expect, it } from 'vitest';
import * as THREE from 'three';
import { FlyoverController, CHASE_MIN_CLEARANCE_M, CHASE_BACK_M, CHASE_DEFAULT_DISTANCE_M } from '../src/visualization/FlyoverController.ts';
import type { TrailResult } from '../src/visualization/TrailMesh.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

/** A straight trail heading +X over 5 km, with a ridge (`ridge(x)`) the camera must clear. */
function fixture(ridge: (x: number, z: number) => number) {
  const total = 5000;
  const routeGeometry = {
    getTelemetryAtProgress: (p: number) => ({ position: new THREE.Vector3(p * total, 0, 0), currentPoint: {} }),
    getRouteForwardAtProgress: () => new THREE.Vector3(1, 0, 0),
  };
  const trail = { routeGeometry, updateHikerPosition: () => ({ currentPoint: {}, position: new THREE.Vector3() }) } as unknown as TrailResult;
  const track = { totalDistance: total, totalPlaybackSeconds: 3600, points: [] } as unknown as TrackStats;
  const flyover = new FlyoverController(trail, track, ridge);
  flyover.setViewMode('first-person');
  return { flyover, camera: new THREE.PerspectiveCamera() };
}

it('chases from behind and above, looking ahead along the trail', () => {
  const { flyover, camera } = fixture(() => 100);
  flyover.setProgress(0.5);
  flyover.update(1 / 60, camera);
  expect(camera.position.x).toBeCloseTo(2500 - CHASE_BACK_M);
  expect(camera.position.y).toBeCloseTo(125);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  expect(dir.x).toBeGreaterThan(0.8); // facing the direction of travel
});

it('keeps at least 8 m of clearance over a ridge behind the hiker', () => {
  const ridge = (x: number, _z = 0) => Math.max(0, 300 - Math.abs(x - 2470) * 4); // 300 m spike 30 m behind
  const { flyover, camera } = fixture(ridge);
  for (const p of [0.48, 0.49, 0.5, 0.51]) {
    flyover.setProgress(p);
    flyover.update(1 / 60, camera);
    const hiker = p * 5000;
    // The sight line from the hiker's eye (ground + 2 m) to the camera clears the ridge.
    const eye = ridge(hiker, 0) + 2;
    for (let i = 1; i <= 6; i++) {
      const t = i / 6, x = hiker + (camera.position.x - hiker) * t;
      expect(eye + (camera.position.y - eye) * t).toBeGreaterThanOrEqual(ridge(x, 0) + CHASE_MIN_CLEARANCE_M * t - 1e-6);
    }
    expect(camera.position.y).toBeGreaterThanOrEqual(ridge(camera.position.x, 0) + CHASE_MIN_CLEARANCE_M);
  }
});

it('leaves the XR life-size placement unchanged', () => {
  const { flyover } = fixture(() => 650);
  const root = new THREE.Group();
  flyover.update(0.016, undefined, root, true);
  expect(root.position.y).toBeCloseTo(-650);
  expect(root.scale.x).toBe(1);
});

const offset = (camera: THREE.Camera) => camera.position.clone().sub(new THREE.Vector3(2500, 100, 0));
const run = (f: { flyover: FlyoverController; camera: THREE.Camera }, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) f.flyover.update(1 / 30, f.camera);
};

it('orbits around the hiker with pitch limits and a 15-400 m wheel range', () => {
  const f = fixture(() => 100); f.flyover.setProgress(0.5);
  f.flyover.setChaseDragging(true);
  f.flyover.chaseLook(Math.PI / 2, 10); // quarter turn, pitch pushed past the limit
  run(f, 0.1);
  const o = offset(f.camera);
  expect(Math.abs(o.z)).toBeGreaterThan(Math.abs(o.x)); // now beside the hiker, not behind
  expect(Math.atan2(o.y, Math.hypot(o.x, o.z))).toBeCloseTo(THREE.MathUtils.degToRad(80), 2);
  f.flyover.chaseZoom(100); run(f, 0.1);
  expect(offset(f.camera).length()).toBeCloseTo(400, 0);
  f.flyover.chaseZoom(0.0001); run(f, 0.1);
  expect(offset(f.camera).length()).toBeCloseTo(15, 0);
});

it('eases back to the default chase pose 3 s after the pointer is released', () => {
  const f = fixture(() => 100); f.flyover.setProgress(0.5);
  f.flyover.setChaseDragging(true);
  f.flyover.chaseLook(1.2, 0.5); f.flyover.chaseZoom(3);
  run(f, 5); // held: no easing
  expect(offset(f.camera).length()).toBeGreaterThan(150);
  f.flyover.setChaseDragging(false);
  run(f, 2.5); // still within 3 s
  expect(offset(f.camera).length()).toBeGreaterThan(150);
  run(f, 6);
  const o = offset(f.camera);
  expect(o.length()).toBeCloseTo(CHASE_DEFAULT_DISTANCE_M, 0);
  expect(o.x).toBeCloseTo(-CHASE_BACK_M, 0);
});

it('offers 1x/10x/30x/100x walking pace in the desktop trail view only', async () => {
  const { playbackPresentation, DESKTOP_TRAIL_SPEEDS } = await import('../src/visualization/PlaybackPresentation.ts');
  expect(playbackPresentation('tour', 'first-person', false, true).speeds).toEqual(DESKTOP_TRAIL_SPEEDS);
  expect(DESKTOP_TRAIL_SPEEDS).toEqual([1, 10, 30, 100]);
  expect(playbackPresentation('tour', 'diorama', false, true).speeds).toEqual([0.5, 1, 2, 3]);
  expect(playbackPresentation('recorded', 'first-person', false).speeds).toEqual([1, 5, 20, 60]); // HUD unchanged
});

it('moves at walking pace times the speed on desktop and stays at walking pace in XR', () => {
  const desktop = fixture(() => 0);
  desktop.flyover.setSpeed(30); desktop.flyover.play();
  desktop.flyover.update(1, desktop.camera);
  expect(desktop.flyover.getProgress() * 5000).toBeCloseTo(1.4 * 30);
  const xr = fixture(() => 0);
  xr.flyover.setSpeed(30); xr.flyover.play();
  xr.flyover.update(1, undefined, new THREE.Group(), true);
  expect(xr.flyover.getProgress() * 5000).toBeLessThanOrEqual(1.4 + 1e-9);
});
