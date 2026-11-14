import { expect, it } from 'vitest';
import * as THREE from 'three';
import { FlyoverController, CHASE_MIN_CLEARANCE_M, CHASE_BACK_M } from '../src/visualization/FlyoverController.ts';
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
