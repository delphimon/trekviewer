import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { SceneManager, type XRAnchorPose } from '../src/core/SceneManager.ts';
import { TrekSession } from '../src/core/TrekSession.ts';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';
import { XRManager } from '../src/core/XRManager.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import type { TrackStats } from '../src/gpx/TrackTypes.ts';

function setupMockEnvironment() {
  const origDoc = (globalThis as any).document;
  const origWin = (globalThis as any).window;
  const origNav = (globalThis as any).navigator;

  const createdElements: Record<string, any> = {};

  const glProxy = new Proxy({
    getExtension: () => null,
    getParameter: () => 'WebGL 1.0',
    getShaderPrecisionFormat: () => ({ rangeMin: 1, rangeMax: 1, precision: 1 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  } as any, {
    get: (target: any, prop: string) => {
      if (prop in target) return target[prop];
      return () => {};
    },
  });

  function createMockElement(tag: string, id?: string) {
    const el: any = {
      tagName: tag.toUpperCase(),
      id: id || '',
      width: 1024,
      height: 768,
      classList: {
        classes: new Set<string>(),
        add(c: string) { el.classList.classes.add(c); },
        remove(c: string) { el.classList.classes.delete(c); },
        toggle(c: string, force?: boolean) {
          if (force !== undefined) {
            if (force) el.classList.classes.add(c);
            else el.classList.classes.delete(c);
          } else {
            if (el.classList.classes.has(c)) el.classList.classes.delete(c);
            else el.classList.classes.add(c);
          }
        },
        contains(c: string) { return el.classList.classes.has(c); },
      },
      attributes: {} as Record<string, string>,
      setAttribute(name: string, val: string) { el.attributes[name] = val; },
      removeAttribute(name: string) { delete el.attributes[name]; },
      getAttribute(name: string) { return el.attributes[name]; },
      style: {} as Record<string, string>,
      disabled: false,
      innerHTML: '',
      textContent: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
      appendChild: () => {},
      removeChild: () => {},
      getContext: () => glProxy,
    };
    if (id) createdElements[id] = el;
    return el;
  }

  const mockWin: any = {
    innerWidth: 1024,
    innerHeight: 768,
    devicePixelRatio: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    location: { origin: 'http://localhost' },
  };

  const mockDoc: any = {
    createElement: (tag: string) => createMockElement(tag),
    createElementNS: (_ns: string, tag: string) => createMockElement(tag),
    getElementById: (id: string) => {
      if (!createdElements[id]) createdElements[id] = createMockElement('div', id);
      return createdElements[id];
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const mockNav: any = {
    xr: {
      isSessionSupported: async () => true,
    },
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: mockNav,
    configurable: true,
    writable: true,
  });

  (globalThis as any).window = mockWin;
  (globalThis as any).document = mockDoc;

  return {
    mockDoc,
    mockWin,
    createdElements,
    restore: () => {
      (globalThis as any).document = origDoc;
      (globalThis as any).window = origWin;
      if (origNav) {
        Object.defineProperty(globalThis, 'navigator', {
          value: origNav,
          configurable: true,
          writable: true,
        });
      }
    },
  };
}

describe('Mixed Reality (MR) Stability & Deterministic Anchoring', () => {
  const dummyTrack: TrackStats = {
    name: 'MR Test Track',
    points: [
      { lat: 46.85, lon: -121.75, ele: 1500, time: new Date(), distanceFromStart: 0, grade: 0.05, speed: 1.2, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
      { lat: 46.86, lon: -121.76, ele: 3000, time: new Date(), distanceFromStart: 5000, grade: 0.1, speed: 1.0, elapsedSeconds: 100, playbackSeconds: 100, index: 1 },
    ],
    totalDistance: 5000,
    elevationGain: 1500,
    elevationLoss: 0,
    minElevation: 1500,
    maxElevation: 3000,
    movingTime: 5000,
    totalPlaybackSeconds: 60,
    avgSpeed: 1.0,
    maxSpeed: 2.0,
    bounds: {
      minLat: 46.85, maxLat: 46.86, minLon: -121.76, maxLon: -121.75,
      minEle: 1500, maxEle: 3000, centerLat: 46.855, centerLon: -121.755,
      widthMeters: 3000, depthMeters: 3000, elevationSpan: 1500,
    },
    waypoints: [],
    landmarks: [],
    segments: [],
    warnings: [],
  };

  it('anchors tabletop diorama deterministically at snapshot pose and locks world position against head movement', () => {
    const env = setupMockEnvironment();
    try {
      const container = env.mockDoc.createElement('div');
      const sm = new SceneManager(container);

      // Initial anchor pose snapshot when user is at (0, 1.6, 0) looking forward (-Z)
      const initialPose: XRAnchorPose = {
        headPosition: new THREE.Vector3(0, 1.6, 0),
        horizontalForward: new THREE.Vector3(0, 0, -1),
        yaw: 0,
      };

      sm.anchorDioramaAtPose(initialPose);

      // Target X = 0 + 0 * 0.8 = 0
      // Target Z = 0 + (-1) * 0.8 = -0.8
      // Target Y = max(0.60, 1.6 - 0.32) = 1.28
      assert.strictEqual(sm.dioramaRoot.position.x, 0);
      assert.strictEqual(sm.dioramaRoot.position.z, -0.80);
      assert.strictEqual(Math.abs(sm.dioramaRoot.position.y - 1.28) < 1e-4, true);

      const anchoredX = sm.dioramaRoot.position.x;
      const anchoredY = sm.dioramaRoot.position.y;
      const anchoredZ = sm.dioramaRoot.position.z;
      const anchoredRotY = sm.dioramaRoot.rotation.y;

      // In tabletop MR mode, dioramaRoot transform must NOT be updated by head movement!
      // Invariant: world-locked diorama remains fixed in 3D room space
      assert.strictEqual(sm.dioramaRoot.position.x, anchoredX);
      assert.strictEqual(sm.dioramaRoot.position.y, anchoredY);
      assert.strictEqual(sm.dioramaRoot.position.z, anchoredZ);
      assert.strictEqual(sm.dioramaRoot.rotation.y, anchoredRotY);
    } finally {
      env.restore();
    }
  });

  it('setViewMode("diorama") modifies scale only and does not implicitly move world anchor', () => {
    const env = setupMockEnvironment();
    try {
      const container = env.mockDoc.createElement('div');
      const sm = new SceneManager(container);

      // Place diorama at an intentional room position
      sm.dioramaRoot.position.set(0.35, 0.95, -0.75);
      sm.dioramaRoot.rotation.set(0, 0.45, 0);

      // Call setViewMode with route extent
      sm.setViewMode('diorama', 8000);

      // Position and rotation must be completely preserved!
      assert.strictEqual(sm.dioramaRoot.position.x, 0.35);
      assert.strictEqual(sm.dioramaRoot.position.y, 0.95);
      assert.strictEqual(sm.dioramaRoot.position.z, -0.75);
      assert.strictEqual(sm.dioramaRoot.rotation.y, 0.45);

      // Scale must be updated according to extent: 0.85 / 8000
      const expectedScale = 0.85 / 8000;
      assert.strictEqual(Math.abs(sm.dioramaRoot.scale.x - expectedScale) < 1e-6, true);
    } finally {
      env.restore();
    }
  });

  it('gates XR entry buttons in DesktopOverlay until terrain loadingPhase is "ready" with valid track', () => {
    const env = setupMockEnvironment();
    try {
      const session = new TrekSession();
      const container = env.mockDoc.createElement('div', 'ui-container');

      const overlay = new DesktopOverlay(
        container,
        {
          onSelectRoute: () => {},
          onUploadGPX: () => {},
          onEnterXR: () => {},
          onToggleViewMode: () => {},
          onTogglePlay: () => {},
          onSetSpeed: () => {},
          onScrub: () => {},
          onSetTextureStyle: () => {},
          onSetTrailColorMode: () => {},
        },
        session
      );

      const btnVR = env.mockDoc.getElementById('btnEnterVR');
      const btnAR = env.mockDoc.getElementById('btnEnterAR');

      // Initially in 'idle' phase with no track: XR buttons MUST be disabled
      assert.strictEqual(btnVR.disabled, true, 'VR button must start disabled');
      assert.strictEqual(btnAR.disabled, true, 'AR button must start disabled');
      assert.strictEqual(btnVR.classList.contains('btn-disabled'), true, 'VR button must have btn-disabled class');
      assert.strictEqual(btnAR.classList.contains('btn-disabled'), true, 'AR button must have btn-disabled class');

      // Simulate route elevation phase
      session.setLoadingStatus('elevation', 'Sampling DEM elevation tiles...');
      assert.strictEqual(btnAR.disabled, true, 'AR button must remain disabled during elevation phase');

      // Simulate route terrain phase
      session.setLoadingStatus('terrain', 'Building 3D terrain geometry...');
      assert.strictEqual(btnAR.disabled, true, 'AR button must remain disabled during terrain phase');

      // Route finishes and becomes ready with track
      session.setTrack(dummyTrack);
      session.setLoadingStatus('ready', 'Mount Rainier ready');

      assert.strictEqual(btnVR.disabled, false, 'VR button must be enabled when phase is ready with track');
      assert.strictEqual(btnAR.disabled, false, 'AR button must be enabled when phase is ready with track');
      assert.strictEqual(btnVR.classList.contains('btn-disabled'), false, 'VR button must not have btn-disabled');
      assert.strictEqual(btnAR.classList.contains('btn-disabled'), false, 'AR button must not have btn-disabled');
    } finally {
      env.restore();
    }
  });

  it('guarantees ImageryLODManager does not mutate dioramaRoot transform during update', () => {
    const lodManager = new ImageryLODManager({
      bounds: dummyTrack.bounds,
      terrainBaseElevation: 1000,
      centerLat: dummyTrack.bounds.centerLat,
      centerLon: dummyTrack.bounds.centerLon,
      elevationSampler: () => 1500,
      baseZoom: 12,
    });

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 1.2, 1.5);

    const dioramaRoot = new THREE.Group();
    dioramaRoot.position.set(0.12, 0.85, -0.72);
    dioramaRoot.rotation.set(0, 0.5, 0);
    dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);

    // Call update
    lodManager.update(camera, dioramaRoot, 'diorama', 0.016);

    // Verify diorama transform is completely untouched
    assert.strictEqual(dioramaRoot.position.x, 0.12);
    assert.strictEqual(dioramaRoot.position.y, 0.85);
    assert.strictEqual(dioramaRoot.position.z, -0.72);
    assert.strictEqual(dioramaRoot.rotation.y, 0.5);
    assert.strictEqual(dioramaRoot.scale.x, 0.0001);

    lodManager.dispose();
  });

  it('syncs held controller buttons on connect to prevent synthetic trigger edge on session start', () => {
    const scene = new THREE.Scene();
    const dioramaRoot = new THREE.Group();
    scene.add(dioramaRoot);

    const mockXR = {
      addEventListener: () => {},
      removeEventListener: () => {},
      getController: () => {
        const c = new THREE.Group() as any;
        c.matrixWorld = new THREE.Matrix4();
        return c;
      },
      getControllerGrip: () => {
        const g = new THREE.Group() as any;
        g.matrixWorld = new THREE.Matrix4();
        return g;
      },
      getHand: () => {
        const h = new THREE.Group() as any;
        h.matrixWorld = new THREE.Matrix4();
        return h;
      },
    };

    const mockSceneManager = {
      scene,
      dioramaRoot,
      camera: new THREE.PerspectiveCamera(),
      renderer: { xr: mockXR } as any,
      isPointOnDiorama: () => false,
    } as any;

    const xrManager = new XRManager(mockSceneManager);
    const ctrl0 = (xrManager as any).controllers[0];

    // Simulate controller connecting while trigger button is held down (e.g., clicking Enter MR)
    ctrl0.controller.dispatchEvent({
      type: 'connected',
      data: {
        handedness: 'right',
        gamepad: {
          buttons: [
            { pressed: true, value: 1.0 }, // Trigger held down
            { pressed: false, value: 0.0 },
          ],
          axes: [0, 0],
        },
      },
    });

    // prevButtons[0] must be synced to true immediately so frame 0 does not trigger a synthetic down edge
    assert.strictEqual(ctrl0.prevButtons[0], true, 'Trigger must be marked as previously pressed');

    // On session reset, interaction state is cleanly reset
    xrManager.resetInteractionState();
    assert.strictEqual(ctrl0.isDraggingTerrain, false);
    assert.strictEqual(ctrl0.isDraggingHUD, false);
    assert.strictEqual(ctrl0.isGripping, false);
    assert.strictEqual(ctrl0.prevButtons[0], false);

    xrManager.dispose();
  });

  it('resetToArmLength explicitly re-anchors diorama and updates position based on XR camera pose', () => {
    const env = setupMockEnvironment();
    try {
      const container = env.mockDoc.createElement('div');
      const sm = new SceneManager(container);

      // Start at default desktop position
      sm.setupDesktopDiorama();
      assert.strictEqual(sm.dioramaRoot.position.y, -0.15);

      // Mock XR presenting with valid head pose
      const xrCam = new THREE.PerspectiveCamera();
      xrCam.position.set(0.4, 1.7, 0.2);
      xrCam.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0); // facing -Z

      (sm.renderer.xr as any).isPresenting = true;
      (sm.renderer.xr as any).getCamera = () => xrCam;

      // User triggers explicit reset
      sm.resetToArmLength();

      // Expected target: headPos.x + fwd.x * 0.8 = 0.4 + 0 = 0.4
      // Target Z = headPos.z + fwd.z * 0.8 = 0.2 + (-1)*0.8 = -0.6
      // Target Y = max(0.60, 1.7 - 0.32) = 1.38
      assert.strictEqual(sm.dioramaRoot.position.x, 0.4);
      assert.strictEqual(Math.abs(sm.dioramaRoot.position.z - (-0.6)) < 1e-4, true);
      assert.strictEqual(Math.abs(sm.dioramaRoot.position.y - 1.38) < 1e-4, true);
    } finally {
      env.restore();
    }
  });

  it('verifies active camera selection strictly selects XR camera during presentation and desktop camera otherwise', () => {
    const desktopCam = new THREE.PerspectiveCamera();
    const xrCam = new THREE.PerspectiveCamera();

    let isPresenting = false;
    const mockRenderer = {
      xr: {
        get isPresenting() { return isPresenting; },
        getCamera: () => xrCam,
      },
    };

    function getActiveViewCamera() {
      return mockRenderer.xr.isPresenting
        ? mockRenderer.xr.getCamera()
        : desktopCam;
    }

    assert.strictEqual(getActiveViewCamera(), desktopCam, 'Must use desktop camera when not presenting');

    isPresenting = true;
    assert.strictEqual(getActiveViewCamera(), xrCam, 'Must use XR camera when presenting in WebXR');
  });

  it('positions first-person HUD viewer-relativly while preserving tabletop world-lock', () => {
    const hudGroup = new THREE.Group();
    const activeCam = new THREE.PerspectiveCamera();
    activeCam.position.set(1.5, 2.0, 3.0);
    activeCam.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);

    // In first-person mode, HUD follows active viewer camera
    const forward = new THREE.Vector3(0, -0.15, -1.2).applyQuaternion(activeCam.quaternion);
    hudGroup.position.copy(activeCam.position).add(forward);
    hudGroup.quaternion.copy(activeCam.quaternion);

    assert.strictEqual(Math.abs(hudGroup.position.x - (1.5 + forward.x)) < 1e-5, true);
    assert.strictEqual(Math.abs(hudGroup.position.y - (2.0 - 0.15)) < 1e-5, true);
    assert.strictEqual(Math.abs(hudGroup.position.z - (3.0 + forward.z)) < 1e-5, true);
  });
});
