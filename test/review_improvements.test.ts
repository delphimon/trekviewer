import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { XRManager } from '../src/core/XRManager.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { DEFAULT_COMFORT } from '../src/xr/ComfortPreferences.ts';
import { decodeTerrarium } from '../src/terrain/TerrariumDecode.ts';
import { runTerrainJob, disposeTerrainJobs } from '../src/terrain/TerrainJobs.ts';
import { sampleTerrainSurface } from '../src/terrain/TerrainGrid.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function directHUD() {
  const xr: any = Object.create(XRManager.prototype);
  xr.comfort = { ...DEFAULT_COMFORT };
  xr.spatialHUD = { group: new THREE.Group(), onPointerHover: vi.fn(), onPointerClick: vi.fn(), onPointerDrag: vi.fn(), onPointerRelease: vi.fn() };
  xr.getActiveCamera = () => new THREE.PerspectiveCamera();
  return xr;
}

function handState(): any {
  return { visualOutline: { group: { visible: true } }, jointPosMap: new Map([['index-finger-tip', new THREE.Vector3(0, 0, -0.5)]]),
    inputSource: { handedness: 'left' }, isPinching: true, prevPinching: false, activeInteraction: 'none', isClickingHUD: false,
    pinchWorldPos: new THREE.Vector3(0, 0, -0.5), prevPinchWorldPos: new THREE.Vector3(), wristWorldPos: new THREE.Vector3(),
    prevWristWorldPos: new THREE.Vector3(), wristWorldQuat: new THREE.Quaternion(), prevWristWorldQuat: new THREE.Quaternion(),
    indexTipWorldPos: new THREE.Vector3(0, 0, -0.5), pinchTracker: { justPinched: true } };
}

it('re-arms direct pokes after fast withdrawal and hidden-panel cancellation', () => {
  const xr = directHUD(), hand: any = { isClickingHUD: false };
  for (const z of [0, 0.2, 0]) xr.checkHandHUDInteraction(hand, new THREE.Vector3(0, 0, z), false);
  expect(xr.spatialHUD.onPointerClick).toHaveBeenCalledTimes(2);
  xr.spatialHUD.group.visible = false;
  xr.checkHandHUDInteraction(hand, new THREE.Vector3(), false);
  expect(hand.isClickingHUD).toBe(false);
});

it('keeps a scaled HUD grab stable and captured when the fingertip leaves the handle volume', () => {
  const xr = directHUD(), hand: any = { isClickingHUD: false };
  xr.spatialHUD.group.scale.setScalar(1.55);
  xr.spatialHUD.group.updateMatrixWorld(true);
  const finger = new THREE.Vector3(0, 0.29 * 1.55, 0);
  expect(xr.checkHandHUDInteraction(hand, finger, true)).toBe(true);
  expect(xr.spatialHUD.group.position.length()).toBe(0);
  finger.x += 0.4;
  expect(xr.checkHandHUDInteraction(hand, finger, true)).toBe(true);
  expect(xr.spatialHUD.group.position.x).toBeCloseTo(0.4);
});

it('dispatches a near hand pinch exactly once when the far ray also intersects the HUD', () => {
  const xr = directHUD(), hand = handState();
  xr.spatialHUD.group.position.z = -0.5;
  xr.spatialHUD.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.53), new THREE.MeshBasicMaterial());
  xr.spatialHUD.grabMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
  xr.spatialHUD.grabMesh.position.y = 2;
  xr.spatialHUD.group.add(xr.spatialHUD.mesh, xr.spatialHUD.grabMesh);
  xr.spatialHUD.group.updateMatrixWorld(true);
  const controller = new THREE.Group(); controller.updateMatrixWorld(true);
  const ctrl: any = { controller, grip: new THREE.Group(), inputSource: { handedness: 'left', hand: {} }, prevButtons: [], rayLine: new THREE.Line(), reticle: new THREE.Mesh() };
  xr.controllers = [ctrl]; xr.hands = [hand]; xr.renderer = { xr: { getSession: () => ({}) } };
  xr.currentViewMode = 'diorama'; xr.updateHandTracking = () => {}; xr.updateHandVisuals = () => {};
  xr.checkHandWaypointInteraction = () => false; xr.getDioramaProximity = () => ({ isTouching: false, proximityFactor: 0 });
  xr.applyManipulation = () => {}; xr.updatePointerRaycast = vi.fn();
  let playing = false;
  xr.spatialHUD.onPointerClick.mockImplementation(() => { playing = !playing; });
  xr.update();
  expect(playing).toBe(true);
  expect(xr.spatialHUD.onPointerClick).toHaveBeenCalledTimes(1);
  expect(xr.updatePointerRaycast).not.toHaveBeenCalled();
  hand.prevPinching = true;
  xr.update();
  expect(xr.spatialHUD.onPointerClick).toHaveBeenCalledTimes(1);
});

it('keeps terrain capture exclusive when a grabbing hand crosses a HUD and waypoint', () => {
  const xr = directHUD(), hand = handState();
  hand.activeInteraction = 'diorama'; xr.hands = [hand]; xr.controllers = [];
  xr.checkHandWaypointInteraction = vi.fn(); xr.checkHandHUDInteraction = vi.fn();
  xr.getDioramaProximity = () => ({ isTouching: true, proximityFactor: 1 }); xr.updateHandVisuals = () => {};
  expect(xr.processHandGrabs()).toHaveLength(1);
  expect(xr.checkHandHUDInteraction).not.toHaveBeenCalled();
  expect(xr.checkHandWaypointInteraction).not.toHaveBeenCalled();
});

it('cancels a direct hand capture when only the fingertip loses tracking', () => {
  const xr = directHUD(), hand = handState();
  hand.indexTipTracked = false; hand.activeInteraction = 'hud'; hand.isClickingHUD = true;
  hand.pinchReticle = new THREE.Mesh(); xr.hands = [hand];
  expect(xr.processHandGrabs()).toEqual([]);
  expect(xr.spatialHUD.onPointerClick).not.toHaveBeenCalled();
  expect(hand.isClickingHUD).toBe(false);
  expect(xr.spatialHUD.onPointerRelease).toHaveBeenCalledWith('hand_left');
});

it('does not dispatch HUD actions while a controller grip owns the terrain', () => {
  const xr = directHUD();
  const state: any = { isGripping: true, rayLine: new THREE.Line(), reticle: new THREE.Mesh() };
  xr.updatePointerRaycast(0, state, true, false);
  expect(xr.spatialHUD.onPointerClick).not.toHaveBeenCalled();
  expect(xr.spatialHUD.onPointerRelease).toHaveBeenCalledWith('controller_0');
});

it('requires chart-origin capture and keeps a second pointer from dragging or releasing it', () => {
  const hud: any = Object.create(SpatialHUD.prototype);
  hud.canvas = { width: 1024, height: 680 }; hud.callbacks = { onScrub: vi.fn() };
  hud.interactiveAreas = []; hud.drawHUD = vi.fn(); hud.isDraggingScrubber = false; hud.scrubPointer = null;
  const uv = new THREE.Vector2(0.5, 0.6);
  hud.onPointerDrag(uv, 'left'); expect(hud.callbacks.onScrub).not.toHaveBeenCalled();
  hud.onPointerClick(uv, 'left');
  hud.onPointerDrag(uv, 'right'); hud.onPointerRelease('right');
  expect(hud.callbacks.onScrub).toHaveBeenCalledTimes(1);
  hud.onPointerDrag(uv, 'left'); expect(hud.callbacks.onScrub).toHaveBeenCalledTimes(2);
  hud.onPointerRelease('left'); hud.onPointerDrag(uv, 'left');
  expect(hud.callbacks.onScrub).toHaveBeenCalledTimes(2);
});

function physicalXR(): any {
  const xr = directHUD();
  const state: any = { controller: new THREE.Group(), grip: new THREE.Group(), inputSource: { handedness: 'right', gamepad: { axes: [0, 0, 1, 0], buttons: [] } },
    rayLine: new THREE.Line(), reticle: new THREE.Mesh(), prevButtons: [], prevGripWorldPos: new THREE.Vector3() };
  xr.renderer = { xr: { getSession: () => ({}) } }; xr.controllers = [state]; xr.hands = [];
  xr.callbacks = { onTurn: vi.fn() }; xr.currentViewMode = 'first-person';
  xr.updateHandTracking = () => {}; xr.updatePointerRaycast = vi.fn(); xr.processHandGrabs = () => []; xr.applyManipulation = () => {};
  return xr;
}

it('suspends untracked controllers and requires button release before reacquisition', () => {
  const xr = physicalXR(), state = xr.controllers[0];
  state.controller.visible = state.grip.visible = false;
  xr.update(); expect(state.controller.visible).toBe(false); expect(xr.updatePointerRaycast).not.toHaveBeenCalled();
  expect(xr.isPhysicalControllerActive('right')).toBe(false);
  state.controller.visible = state.grip.visible = true;
  state.inputSource.gamepad.buttons = [{ pressed: true, value: 1 }];
  xr.update(); expect(xr.updatePointerRaycast).not.toHaveBeenCalled();
  state.inputSource.gamepad.buttons[0] = { pressed: false, value: 0 };
  xr.update(); expect(xr.updatePointerRaycast).toHaveBeenCalledTimes(1);
});

it.each([60, 72, 90, 120])('snap turns once per deflection at %s Hz', (fps) => {
  const xr = physicalXR();
  for (let i = 0; i < fps; i++) xr.update(1 / fps);
  expect(xr.callbacks.onTurn).toHaveBeenCalledTimes(1);
  expect(xr.callbacks.onTurn).toHaveBeenCalledWith(-Math.PI / 6);
  xr.controllers[0].inputSource.gamepad.axes[2] = 0; xr.update();
  xr.controllers[0].inputSource.gamepad.axes[2] = 1; xr.update();
  expect(xr.callbacks.onTurn).toHaveBeenCalledTimes(2);
});

it('rejects date-line crossings and oversized geographic workloads before DEM decoding', async () => {
  const xml = '<gpx><trk><trkseg><trkpt lat="46" lon="179.999"><ele>100</ele></trkpt><trkpt lat="46.001" lon="-179.999"><ele>100</ele></trkpt></trkseg></trk></gpx>';
  expect(() => GPXParser.calculateRawBounds(GPXParser.parseRaw(xml))).toThrow(/date line/);
  const spy = vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockResolvedValue(null);
  await expect(ElevationTileService.fetchElevationGrid({ minLat: 0, maxLat: 60, minLon: 0, maxLon: 100, minEle: 0, maxEle: 100 } as any)).rejects.toThrow(/25-tile/);
  expect(spy).not.toHaveBeenCalled();
});

it('rejects excessive GPX point and waypoint counts before parsing', () => {
  expect(() => GPXParser.parseRaw('<trkpt '.repeat(100_001))).toThrow(/100,000/);
  expect(() => GPXParser.parseRaw('<wpt '.repeat(1_001))).toThrow(/1,000/);
});

it('anchors first-person entry at current feet and preserves subsequent physical movement', () => {
  const point = new THREE.Vector3(100, 50, 200);
  const trail: any = { routeGeometry: { getTelemetryAtProgress: () => ({ position: point }), getRouteForwardAtProgress: () => new THREE.Vector3(0, 0, -1) } };
  const controller = new FlyoverController(trail, { totalPlaybackSeconds: 60 } as any, () => 50);
  controller.setViewMode('first-person');
  const camera = new THREE.PerspectiveCamera(); camera.position.set(2, 1.6, 3); camera.rotation.y = Math.PI / 2;
  controller.recenterViewer(camera);
  const root = new THREE.Group(); controller.update(0, camera, root, true); root.updateMatrixWorld(true);
  const atEntry = point.clone().applyMatrix4(root.matrixWorld);
  expect(atEntry.x).toBeCloseTo(2); expect(atEntry.z).toBeCloseTo(3); expect(atEntry.y).toBeCloseTo(0);
  camera.position.x += 1;
  controller.update(0, camera, root, true); root.updateMatrixWorld(true);
  expect(point.clone().applyMatrix4(root.matrixWorld).distanceTo(atEntry)).toBeLessThan(1e-5);
});

it('pauses on trail entry and caps accelerated first-person playback to 1.4 m/s', () => {
  const points = [{ distanceFromStart: 0, playbackSeconds: 0 }, { distanceFromStart: 1000, playbackSeconds: 100 }];
  const trail: any = { updateHikerPosition: () => ({ currentPoint: points[0], position: new THREE.Vector3() }), routeGeometry: { getTelemetryAtProgress: () => ({ position: new THREE.Vector3() }), getRouteForwardAtProgress: () => new THREE.Vector3(0, 0, -1) } };
  const controller = new FlyoverController(trail, { points, totalDistance: 1000, totalPlaybackSeconds: 100 } as any);
  controller.play(); controller.setSpeed(60); controller.setViewMode('first-person');
  expect(controller.getIsPlaying()).toBe(false);
  controller.play(); controller.update(1);
  expect(controller.getProgress() * 1000).toBeCloseTo(1.4);
});

it('decodes original Terrarium precision and excludes missing/black pixels', () => {
  const pixels = new Uint8ClampedArray(256 * 256 * 4);
  pixels.set([128, 100, 128, 255]);
  const result = decodeTerrarium({ width: 256, height: 256, pixels, validity: new Uint8Array([1]) });
  expect(result.data[0]).toBe(100.5); expect(result.min).toBe(100.5);
  expect(Number.isNaN(result.data[1])).toBe(true);
  expect(() => decodeTerrarium({ width: 16384, height: 16384, pixels, validity: new Uint8Array() })).toThrow(/oversized/);
});

it('cancels queued terrain work before invoking its fallback', async () => {
  const aborted = new AbortController(); aborted.abort();
  const fallback = vi.fn();
  await expect(runTerrainJob({ kind: 'decode', input: {} as any }, fallback, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fallback).not.toHaveBeenCalled();
});

it('serializes worker jobs, aborts the active worker, and allows a subsequent job to complete', async () => {
  const instances: any[] = [];
  class MockWorker {
    public onmessage: any = null;
    public onerror: any = null;
    public messages: any[] = [];
    public terminate = vi.fn();
    constructor() { instances.push(this); queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
    public postMessage(message: any): void { this.messages.push(message); }
  }
  vi.stubGlobal('Worker', MockWorker);
  const controller = new AbortController();
  const first = runTerrainJob({ kind: 'decode', input: {} as any }, () => 1, controller.signal);
  const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = runTerrainJob({ kind: 'decode', input: {} as any }, () => 2);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(instances).toHaveLength(1); expect(instances[0].messages).toHaveLength(1);
  controller.abort(); await firstResult;
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(instances[0].terminate).toHaveBeenCalled(); expect(instances).toHaveLength(2);
  instances[1].onmessage({ data: { result: 2 } }); expect(await second).toBe(2);
  disposeTerrainJobs(); expect(instances[1].terminate).toHaveBeenCalled();
});

it('preserves valleys and reproduces coarse diagonal sampling in prepared local geometry', () => {
  const grid = { width: 100, depth: 100, segmentsX: 1, segmentsZ: 1, heights: new Float32Array([0, 10, 20, 40]) };
  expect(sampleTerrainSurface(grid, 0, 0)).toBe(15);
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ elevation: 80, isValid: true });
  const options: any = { localGrid: { zoom: 15, isRealDEM: true }, centerLat: 46, centerLon: -120, terrainBaseElevation: 100, radiusMeters: 100, segments: 8 };
  const chunk = new LocalTerrainChunk(options);
  expect(chunk.sampleLocalSurfaceY(0, 0)).toBe(-20);
  const prepared = new LocalTerrainChunk({ ...options, preparedData: chunk.getBuildData() });
  expect(prepared.sampleLocalSurfaceY(0, 0)).toBe(-20);
  expect(prepared.geometry.attributes.normal.array).toEqual(chunk.geometry.attributes.normal.array);
  chunk.dispose(); prepared.dispose();
});

it('keeps hidden HUD state dirty without rasterization and meets angular sizing targets', () => {
  const hud: any = Object.create(SpatialHUD.prototype);
  hud.group = new THREE.Group(); hud.group.visible = false; hud.staticDirty = true;
  hud.renderStaticLayer = vi.fn(); hud.renderDynamicLayer = vi.fn();
  hud.drawHUD(true); hud.update();
  expect(hud.renderStaticLayer).not.toHaveBeenCalled(); expect(hud.renderDynamicLayer).not.toHaveBeenCalled();
  expect(hud.dynamicDirty).toBe(true);
  hud.setAngularSize(1.49);
  const scale = hud.group.scale.x;
  expect(2 * Math.atan(0.8 * 58 / 1024 * scale / (2 * 1.49)) * 180 / Math.PI).toBeCloseTo(2.7);
  expect(0.8 * 10 / 1024 * scale).toBeGreaterThanOrEqual(0.012);
});
