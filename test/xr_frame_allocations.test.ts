import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { XRManager } from '../src/core/XRManager.ts';

afterEach(() => vi.restoreAllMocks());

it('looks the waypoints up once per route and never rebuilds the laser geometry per frame', () => {
  const controllers: THREE.Group[] = [];
  const dioramaRoot = new THREE.Group();
  const base = new THREE.Group(); const waypoints = new THREE.Group(); waypoints.name = 'Waypoints';
  waypoints.add(new THREE.Mesh(new THREE.SphereGeometry(1)));
  base.add(waypoints); dioramaRoot.add(base);
  const sceneManager: any = {
    renderer: { xr: { isPresenting: true, getCamera: () => new THREE.PerspectiveCamera(),
      getController: () => { const c = new THREE.Group(); controllers.push(c); return c; },
      getControllerGrip: () => new THREE.Group(), getHand: () => new THREE.Group(), getSession: () => ({}) } },
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), dioramaRoot,
  };
  const xr = new XRManager(sceneManager);
  xr.setViewMode('diorama');
  const buttons = Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 }));
  controllers[1].dispatchEvent({ type: 'connected', data: { handedness: 'right', gamepad: { buttons, axes: [0, 0, 0, 0] } } } as any);
  const lookup = vi.spyOn(dioramaRoot, 'getObjectByName');
  const beam = controllers[1].getObjectByName('LaserRay') as THREE.Line;
  const positions = beam.geometry.getAttribute('position') as THREE.BufferAttribute;
  const version = positions.version;
  for (let frame = 0; frame < 10; frame++) xr.update();
  expect(lookup.mock.calls.filter(([name]) => name === 'Waypoints').length).toBeLessThanOrEqual(1);
  expect(beam.geometry.getAttribute('position')).toBe(positions);
  expect(positions.version).toBe(version);
  expect(positions.getZ(1)).toBe(-1); // unit beam, length carried by scale.z
  expect(beam.scale.z).toBeGreaterThan(0);
  const ray = xr.getActivePointerRay();
  expect(ray === null || ray !== xr.getActivePointerRay()).toBe(true); // callers get copies
});
