import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { XRManager, maxTabletopScale, MAX_PLINTH_WIDTH_M } from '../src/core/XRManager.ts';
import { plinthBottomDepth } from '../src/visualization/DioramaBase.ts';

afterEach(() => vi.restoreAllMocks());

it('caps the plinth at 2.5 m wide', () => {
  expect(maxTabletopScale(10_000) * 10_000).toBeCloseTo(MAX_PLINTH_WIDTH_M);
});

it('keeps the plinth bottom on the table while zooming with the right stick, and stops at 2.5 m', () => {
  const controllers: THREE.Group[] = [];
  const dioramaRoot = new THREE.Group();
  dioramaRoot.scale.setScalar(0.0001); dioramaRoot.position.set(0, 0.75 + plinthBottomDepth() * 0.0001, -0.8);
  const sceneManager: any = {
    renderer: { xr: { isPresenting: true, getCamera: () => new THREE.PerspectiveCamera(),
      getController: () => { const c = new THREE.Group(); controllers.push(c); return c; },
      getControllerGrip: () => new THREE.Group(), getHand: () => new THREE.Group(), getSession: () => ({}) } },
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), dioramaRoot,
  };
  const xr = new XRManager(sceneManager);
  xr.setViewMode('diorama');
  xr.setDioramaContext({ minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
    widthMeters: 4000, depthMeters: 3000, minEle: 0, maxEle: 1000, elevationSpan: 1000 });
  const buttons = Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  controllers[1].dispatchEvent({ type: 'connected', data: { handedness: 'right', gamepad: { buttons, axes } } } as any);
  xr.update(1 / 60);
  axes[3] = -1; // push up: zoom in
  for (let i = 0; i < 600; i++) xr.update(1 / 60);
  const bottom = dioramaRoot.position.y - plinthBottomDepth() * dioramaRoot.scale.y;
  expect(bottom).toBeCloseTo(0.75, 6);
  expect(dioramaRoot.scale.x).toBeGreaterThan(0.0001);
  // 4 km route -> 8 km terrain block (terrainFootprint) + 40 m plinth margin, capped at 2.5 m.
  expect(dioramaRoot.scale.x * 8040).toBeCloseTo(MAX_PLINTH_WIDTH_M, 6);
});
