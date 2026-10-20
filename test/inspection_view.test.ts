import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { configureDesktopInspection, fitInspectionBounds, levelHorizon, readHorizonLock, saveHorizonLock, updateInspectionClipping } from '../src/core/InspectionView.ts';
import { applyBimanualTransform, applyOneHandedManipulation } from '../src/xr/GestureMath.ts';
import { TrekViewerApp } from '../src/main.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { DioramaBase, BASE_MARKER_DIAMETER_LOCAL, DESIRED_MARKER_DIAMETER_WORLD } from '../src/visualization/DioramaBase.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  [1233, 821, [360, 1217, 110, 690], [8, 0.6, 2], 1],
  [1233, 821, [360, 1217, 110, 690], [2, 0.6, 8], 1],
  [390, 844, [16, 374, 150, 640], [8, 0.6, 2], 1],
  [844, 390, [16, 828, 95, 290], [2, 4, 8], 1],
  [1800, 1000, [400, 1784, 110, 850], [8, 6, 2], 2],
] as const)('fits every terrain corner inside the unobstructed area (%i × %i)', (width, height, rect, size, zoom) => {
  const camera = new THREE.PerspectiveCamera(60, 1, 1e-7, 1000), target = new THREE.Vector3();
  camera.zoom = zoom;
  const center = new THREE.Vector3(3, 1, -2), half = new THREE.Vector3(...size).multiplyScalar(0.5);
  const bounds = new THREE.Box3(center.clone().sub(half), center.clone().add(half));
  const area = { left: rect[0], right: rect[1], top: rect[2], bottom: rect[3] };
  expect(fitInspectionBounds(camera, target, bounds, width, height, area)).toBe(true);
  let touchedEdge = false;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const projected = new THREE.Vector3(x, y, z).project(camera);
    const px = (projected.x + 1) * width / 2, py = (1 - projected.y) * height / 2;
    expect(px).toBeGreaterThanOrEqual(area.left - 1e-8); expect(px).toBeLessThanOrEqual(area.right + 1e-8);
    expect(py).toBeGreaterThanOrEqual(area.top - 1e-8); expect(py).toBeLessThanOrEqual(area.bottom + 1e-8);
    expect(projected.z).toBeGreaterThan(-1); expect(projected.z).toBeLessThan(1);
    touchedEdge ||= Math.min(Math.abs(px - area.left), Math.abs(px - area.right), Math.abs(py - area.top), Math.abs(py - area.bottom)) < 1e-8;
  }
  expect(touchedEdge).toBe(true);
});

it('rejects unusable bounds and screen areas without changing the view', () => {
  const camera = new THREE.PerspectiveCamera(), target = new THREE.Vector3(1, 2, 3);
  camera.position.set(4, 5, 6);
  const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const area = { left: 10, right: 90, top: 10, bottom: 90 };
  expect(fitInspectionBounds(camera, target, new THREE.Box3(), 100, 100, area)).toBe(false);
  expect(fitInspectionBounds(camera, target, bounds, 0, 100, area)).toBe(false);
  expect(fitInspectionBounds(camera, target, bounds, 100, 100, { ...area, right: 5 })).toBe(false);
  bounds.max.x = Infinity;
  expect(fitInspectionBounds(camera, target, bounds, 100, 100, area)).toBe(false);
  expect(camera.position.toArray()).toEqual([4, 5, 6]); expect(target.toArray()).toEqual([1, 2, 3]);
});

it('fits terrain and skirts without changing model pose or progress, and leaves walking/XR cameras alone', () => {
  const app: any = Object.create(TrekViewerApp.prototype), root = new THREE.Group();
  const terrain = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 2)), skirt = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 2));
  skirt.position.y = -1; root.add(terrain, skirt); root.position.set(1, 2, -3); root.rotation.set(0.2, 0.7, -0.1); root.scale.setScalar(0.2);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.001, 10), controls = new OrbitControls(camera, null);
  app.routeLoader = { getActiveTrek: () => ({ terrainResult: { terrainMesh: terrain, skirtMesh: skirt, localChunks: [] } }) };
  app.controls = controls;
  const state = { progress: 0.65, viewMode: 'diorama' };
  app.session = { getState: () => state, setFollowRoute: vi.fn() };
  app.sceneManager = { camera, dioramaRoot: root, renderer: { xr: { isPresenting: false } }, updateCameraClipping: vi.fn() };
  vi.stubGlobal('window', { innerWidth: 1233, innerHeight: 821 });
  vi.stubGlobal('document', { querySelector: () => null });
  const pose = root.matrix.clone(); root.updateMatrix(); pose.copy(root.matrix);
  app.frameDesktopDiorama();
  expect(app.session.setFollowRoute).toHaveBeenCalledWith(false);
  expect(app.desktopViewFitted).toBe(true); expect(app.session.getState().progress).toBe(0.65);
  const fittedBounds = new THREE.Box3().setFromObject(terrain).union(new THREE.Box3().setFromObject(skirt));
  for (const x of [fittedBounds.min.x, fittedBounds.max.x]) for (const y of [fittedBounds.min.y, fittedBounds.max.y]) for (const z of [fittedBounds.min.z, fittedBounds.max.z]) {
    const projected = new THREE.Vector3(x, y, z).project(camera);
    const px = (projected.x + 1) * 1233 / 2, py = (1 - projected.y) * 821 / 2;
    expect(px).toBeGreaterThanOrEqual(360 - 1e-8); expect(px).toBeLessThanOrEqual(1217 + 1e-8);
    expect(py).toBeGreaterThanOrEqual(96 - 1e-8); expect(py).toBeLessThanOrEqual(665 + 1e-8);
  }
  root.updateMatrix(); expect(root.matrix.equals(pose)).toBe(true);
  const cameraPosition = camera.position.clone(), target = controls.target.clone();
  state.viewMode = 'first-person'; app.frameDesktopDiorama();
  state.viewMode = 'diorama'; app.sceneManager.renderer.xr.isPresenting = true; app.frameDesktopDiorama();
  app.sceneManager.renderer.xr.isPresenting = false; app.graphicsRecovery = { isSuspended: true }; app.frameDesktopDiorama();
  expect(camera.position.equals(cameraPosition)).toBe(true); expect(controls.target.equals(target)).toBe(true);
  expect(app.sceneManager.updateCameraClipping).toHaveBeenCalledTimes(1);
  terrain.geometry.dispose(); skirt.geometry.dispose();
});

it('allows desktop inspection beyond the old zoom floor and towards the cursor', () => {
  const controls = new OrbitControls(new THREE.PerspectiveCamera(), null);
  configureDesktopInspection(controls);
  expect(controls.minDistance).toBeLessThan(0.001);
  expect(controls.maxDistance).toBe(Infinity);
  expect(controls.zoomToCursor).toBe(true);
});

it('keeps close terrain in front of the clipping plane and avoids needless projection rebuilds', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 80000);
  camera.position.set(0, 0.06, 0.05); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const point = new THREE.Vector3();
  expect(point.clone().project(camera).z).toBeLessThan(-1);
  const distance = camera.position.length(), update = vi.spyOn(camera, 'updateProjectionMatrix');
  updateInspectionClipping(camera, true, distance, distance, 0.8);
  expect(point.clone().project(camera).z).toBeGreaterThan(-1);
  expect(point.clone().project(camera).z).toBeLessThan(1);
  expect(camera.far).toBe(10);
  updateInspectionClipping(camera, true, distance, distance, 0.8);
  expect(update).toHaveBeenCalledTimes(1);
});

it('restores metre-scale clipping for walking/XR after an extreme close-up', () => {
  const camera = new THREE.PerspectiveCamera();
  updateInspectionClipping(camera, true, 0.00001, 0.5, 0.8);
  expect(camera.near).toBe(1e-7);
  updateInspectionClipping(camera, false, 0, 0.5, 0.8);
  expect(camera.near).toBe(0.1); expect(camera.far).toBe(80000);
});

it('keeps large or distant tabletop models inside the far plane', () => {
  const camera = new THREE.PerspectiveCamera();
  updateInspectionClipping(camera, true, 80, 100, 200);
  expect(camera.far).toBeGreaterThan(100 + 200);
});

it('levels pitch and roll while preserving model yaw, pan and zoom', () => {
  const model = new THREE.Group();
  model.rotation.set(0.4, 0.7, -0.3, 'YXZ'); model.position.set(2, 3, 4); model.scale.setScalar(0.003);
  levelHorizon(model);
  const orientation = new THREE.Euler().setFromQuaternion(model.quaternion, 'YXZ');
  expect(orientation.x).toBeCloseTo(0); expect(orientation.z).toBeCloseTo(0); expect(orientation.y).toBeCloseTo(0.7);
  expect(model.position.toArray()).toEqual([2, 3, 4]); expect(model.scale.x).toBe(0.003);
});

it('keeps a one-hand contact anchored while locking pitch and allowing yaw', () => {
  const model = new THREE.Group(); model.scale.setScalar(0.001);
  const previous = new THREE.Vector3(0.2, 0.8, -0.5), current = previous.clone().add(new THREE.Vector3(0.1, 0.05, 0));
  model.updateMatrixWorld(); const contact = model.worldToLocal(previous.clone());
  const wrist = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0.15, 0, 'YXZ'));
  applyOneHandedManipulation(model, previous, current, new THREE.Quaternion(), wrist, true);
  expect(new THREE.Vector3(0, 1, 0).applyQuaternion(model.quaternion).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-10);
  expect(Math.abs(model.rotation.y)).toBeGreaterThan(0.01);
  model.updateMatrixWorld(); expect(model.localToWorld(contact).distanceTo(current)).toBeLessThan(1e-10);
});

it('keeps the midpoint anchored when a locked two-hand gesture zooms, moves and rotates', () => {
  const model = new THREE.Group(); model.scale.setScalar(0.001);
  const a = new THREE.Vector3(-0.2, 0.8, -0.5), b = new THREE.Vector3(0.2, 0.8, -0.5);
  const c = new THREE.Vector3(-0.3, 0.9, -0.6), d = new THREE.Vector3(0.3, 1.1, -0.4);
  const midpoint = a.clone().add(b).multiplyScalar(0.5), nextMidpoint = c.clone().add(d).multiplyScalar(0.5);
  model.updateMatrixWorld(); const contact = model.worldToLocal(midpoint.clone());
  applyBimanualTransform(model, a, b, c, d, undefined, undefined, undefined, undefined, true);
  expect(new THREE.Vector3(0, 1, 0).applyQuaternion(model.quaternion).y).toBeCloseTo(1);
  expect(model.scale.x).toBeGreaterThan(0.001); expect(Math.abs(model.rotation.y)).toBeGreaterThan(0.01);
  model.updateMatrixWorld(); expect(model.localToWorld(contact).distanceTo(nextMidpoint)).toBeLessThan(1e-10);
});

it('retains free model tilt when horizon lock is off', () => {
  const model = new THREE.Group(); model.scale.setScalar(0.001);
  const hand = new THREE.Vector3(0, 1, -0.5), wrist = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0));
  applyOneHandedManipulation(model, hand, hand, new THREE.Quaternion(), wrist, false);
  expect(new THREE.Vector3(0, 1, 0).applyQuaternion(model.quaternion).y).toBeLessThan(0.99);
});

it('resets the horizon without changing route progress, camera position or target', () => {
  const app: any = Object.create(TrekViewerApp.prototype), root = new THREE.Group(), camera = new THREE.PerspectiveCamera();
  root.rotation.set(0.4, 0.7, -0.2, 'YXZ'); camera.position.set(3, 4, 5); camera.up.set(0.3, 1, 0);
  const target = new THREE.Vector3(1, 2, 3);
  app.session = { getState: () => ({ viewMode: 'diorama', progress: 0.65 }) };
  app.controls = { target }; app.sceneManager = { camera, dioramaRoot: root, renderer: { xr: { isPresenting: false } } };
  app.savedTabletopTransform = { quaternion: root.quaternion.clone() };
  app.resetHorizon();
  expect(app.session.getState().progress).toBe(0.65);
  expect(camera.position.toArray()).toEqual([3, 4, 5]); expect(target.toArray()).toEqual([1, 2, 3]);
  expect(camera.up.toArray()).toEqual([0, 1, 0]); expect(root.rotation.x).toBeCloseTo(0);
  expect(new THREE.Euler().setFromQuaternion(app.savedTabletopTransform.quaternion, 'YXZ').x).toBeCloseTo(0);
});

it('persists horizon preference and tolerates unavailable storage', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
  expect(readHorizonLock()).toBe(true); saveHorizonLock(false); expect(readHorizonLock()).toBe(false);
  vi.stubGlobal('localStorage', { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } });
  expect(readHorizonLock()).toBe(true); expect(() => saveHorizonLock(false)).not.toThrow();
});

it('routes spatial horizon controls without triggering the full position reset', () => {
  const hud: any = Object.create(SpatialHUD.prototype);
  hud.horizonLocked = true; hud.canvas = { width: 1024, height: 740 }; hud.track = { waypoints: [] };
  hud.callbacks = { onSetHorizonLocked: vi.fn(), onResetHorizon: vi.fn(), onReset: vi.fn() };
  hud.drawHUD = vi.fn(); hud.setupInteractiveAreas();
  expect(hud.onPointerClick(new THREE.Vector2(180 / 1024, 1 - 645 / 740))).toBe(true);
  expect(hud.callbacks.onSetHorizonLocked).toHaveBeenCalledWith(false);
  expect(hud.onPointerClick(new THREE.Vector2(470 / 1024, 1 - 645 / 740))).toBe(true);
  expect(hud.callbacks.onResetHorizon).toHaveBeenCalledTimes(1);
  expect(hud.callbacks.onReset).not.toHaveBeenCalled();
});

it('bounds close desktop waypoint markers while preserving XR physical size', () => {
  const group = new THREE.Group(), waypoints = new THREE.Group(), pin = new THREE.Group();
  waypoints.name = 'Waypoints'; waypoints.add(pin); group.add(waypoints); group.scale.setScalar(0.001);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.001, 10); camera.position.z = 0.02;
  DioramaBase.updateWaypoints(group, camera, 0.001, 0, 800);
  const desktopDiameter = pin.scale.x * 0.001 * BASE_MARKER_DIAMETER_LOCAL;
  const projectedPixels = desktopDiameter / (2 * Math.tan(Math.PI / 6) * 0.02) * 800;
  expect(projectedPixels).toBeCloseTo(22);
  DioramaBase.updateWaypoints(group, camera, 0.001, 0);
  expect(pin.scale.x * 0.001 * BASE_MARKER_DIAMETER_LOCAL).toBeCloseTo(DESIRED_MARKER_DIAMETER_WORLD);
});
