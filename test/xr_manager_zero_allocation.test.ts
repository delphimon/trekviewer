import * as THREE from 'three';
import assert from 'node:assert';
import { describe, it } from 'vitest';
import { XRManager } from '../src/core/XRManager.ts';

// Mock SceneManager for headless tests
function createMockSceneManager() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  const dioramaRoot = new THREE.Group();
  scene.add(dioramaRoot);

  const listeners: Record<string, Array<() => void>> = {};
  const mockSession = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const mockXR = {
    addEventListener: (type: string, cb: () => void) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(cb);
    },
    removeEventListener: () => {},
    getSession: () => mockSession,
    getController: (i: number) => {
      const targetRay = new THREE.Group() as any;
      targetRay.matrixWorld = new THREE.Matrix4();
      return targetRay;
    },
    getControllerGrip: (i: number) => {
      const grip = new THREE.Group() as any;
      grip.matrixWorld = new THREE.Matrix4();
      return grip;
    },
    getHand: (i: number) => {
      const hand = new THREE.Group() as any;
      hand.matrixWorld = new THREE.Matrix4();
      return hand;
    },
  };

  const renderer = {
    xr: mockXR,
  } as any;

  return {
    sceneManager: {
      scene,
      camera,
      dioramaRoot,
      renderer,
      isPointOnDiorama: () => false,
    } as any,
    triggerSessionEnd: () => {
      listeners['sessionend']?.forEach((cb) => cb());
    },
  };
}

describe('XRManager Zero-Allocation & Session Reset', () => {
  it('instantiates cleanly and registers sessionend listener', () => {
    const { sceneManager, triggerSessionEnd } = createMockSceneManager();
    const xrManager = new XRManager(sceneManager);

    assert.ok(xrManager, 'XRManager should be instantiated');

    // Trigger session end
    triggerSessionEnd();

    // Verify interaction state is reset cleanly
    xrManager.resetInteractionState();
    xrManager.dispose();
  });

  it('preserves buffer geometry attributes in-place during update and avoids per-frame geometry recreation', () => {
    const { sceneManager } = createMockSceneManager();
    const xrManager = new XRManager(sceneManager);

    const controllers = (xrManager as any).controllers;
    assert.strictEqual(controllers.length, 2, 'Should create 2 controllers');

    const ctrl0 = controllers[0];
    const initialRayGeo = ctrl0.rayLine.geometry;
    const initialPosAttr = initialRayGeo.attributes.position;
    assert.ok(initialPosAttr, 'Initial ray line position attribute should exist');
    const initialArray = initialPosAttr.array;

    // Simulate input source with gamepad
    ctrl0.inputSource = {
      handedness: 'right',
      gamepad: {
        axes: [0, 0, 0, 0],
        buttons: [{ pressed: false, value: 0 }],
      },
    };

    // Run update loop multiple times
    for (let i = 0; i < 5; i++) {
      xrManager.update(0.016);
    }

    // Ensure the geometry and array instances were reused in-place (zero garbage collection)
    assert.strictEqual(ctrl0.rayLine.geometry, initialRayGeo, 'Ray line geometry should not be re-allocated');
    assert.strictEqual(ctrl0.rayLine.geometry.attributes.position.array, initialArray, 'Float32Array buffer should be mutated in-place');

    xrManager.dispose();
  });

  it('resets interaction flags when session ends', () => {
    const { sceneManager, triggerSessionEnd } = createMockSceneManager();
    const xrManager = new XRManager(sceneManager);

    const controllers = (xrManager as any).controllers;
    const ctrl0 = controllers[0];
    ctrl0.isGripping = true;
    ctrl0.isDraggingHUD = true;
    ctrl0.isDraggingTerrain = true;
    ctrl0.prevButtons[0] = true;

    const hands = (xrManager as any).hands;
    const hand0 = hands[0];
    hand0.isPinching = true;
    hand0.isGrabbingDiorama = true;
    hand0.isClickingHUD = true;

    // Trigger sessionend event
    triggerSessionEnd();

    assert.strictEqual(ctrl0.isGripping, false, 'Gripping should be reset');
    assert.strictEqual(ctrl0.isDraggingHUD, false, 'HUD dragging should be reset');
    assert.strictEqual(ctrl0.isDraggingTerrain, false, 'Terrain dragging should be reset');
    assert.strictEqual(ctrl0.prevButtons[0], false, 'Prev buttons should be cleared');

    assert.strictEqual(hand0.isPinching, false, 'Pinching should be reset');
    assert.strictEqual(hand0.isGrabbingDiorama, false, 'Diorama grab should be reset');
    assert.strictEqual(hand0.isClickingHUD, false, 'HUD click should be reset');

    xrManager.dispose();
  });
});
