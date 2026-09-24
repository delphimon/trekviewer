import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  clampDeltaSeconds,
  computeThumbstickWalkDelta,
  computeThumbstickPan,
  computeThumbstickRotation,
  computeThumbstickZoomFactor,
  evaluatePinchState,
} from '../src/xr/GestureMath.ts';
import { XRManager } from '../src/core/XRManager.ts';

describe('XR Frame-Rate Independence & Timing Math (Stage N)', () => {
  it('clamps pathological frame deltas to safe bounds [0.001, 0.1]', () => {
    // Zero or negative delta (e.g. clock pause / skew)
    assert.strictEqual(clampDeltaSeconds(0), 0.001);
    assert.strictEqual(clampDeltaSeconds(-0.5), 0.001);
    assert.strictEqual(clampDeltaSeconds(NaN), 0.001);

    // Normal VR frame deltas (60, 72, 90, 120 Hz)
    assert(Math.abs(clampDeltaSeconds(1 / 60) - 1 / 60) < 1e-6);
    assert(Math.abs(clampDeltaSeconds(1 / 72) - 1 / 72) < 1e-6);
    assert(Math.abs(clampDeltaSeconds(1 / 90) - 1 / 90) < 1e-6);
    assert(Math.abs(clampDeltaSeconds(1 / 120) - 1 / 120) < 1e-6);

    // Pathological large lag spike / tab freeze (e.g. 5 seconds) clamped to 0.1s
    assert.strictEqual(clampDeltaSeconds(5.0), 0.1);
    assert.strictEqual(clampDeltaSeconds(0.25), 0.1);
  });

  it('first-person thumbstick walking yields identical distance per second across 60, 72, 90, and 120 Hz', () => {
    const frameRates = [60, 72, 90, 120];
    const stickY = -1.0; // full forward

    // Normal speed (18 m/s)
    const normalResults = frameRates.map((fps) => {
      const dt = 1 / fps;
      let totalDist = 0;
      for (let i = 0; i < fps; i++) {
        totalDist += computeThumbstickWalkDelta(stickY, false, dt);
      }
      return totalDist;
    });

    for (const dist of normalResults) {
      assert(Math.abs(dist - 18.0) < 1e-5, `Expected 18.0m, got ${dist}`);
    }

    // Turbo speed (75 m/s)
    const turboResults = frameRates.map((fps) => {
      const dt = 1 / fps;
      let totalDist = 0;
      for (let i = 0; i < fps; i++) {
        totalDist += computeThumbstickWalkDelta(stickY, true, dt);
      }
      return totalDist;
    });

    for (const dist of turboResults) {
      assert(Math.abs(dist - 75.0) < 1e-5, `Expected 75.0m, got ${dist}`);
    }

    // Deadzone check (|stickY| <= 0.1)
    assert.strictEqual(computeThumbstickWalkDelta(0.08, false, 1 / 72), 0);
    assert.strictEqual(computeThumbstickWalkDelta(-0.05, true, 1 / 72), 0);
  });

  it('tabletop panning displacement is identical per second across 60, 72, 90, and 120 Hz', () => {
    const frameRates = [60, 72, 90, 120];
    const stickX = 0.8;
    const stickY = -0.6;

    // Normal pan speed (0.7 m/s)
    const normalPans = frameRates.map((fps) => {
      const dt = 1 / fps;
      let totalDx = 0;
      let totalDz = 0;
      for (let i = 0; i < fps; i++) {
        const pan = computeThumbstickPan(stickX, stickY, false, dt);
        totalDx += pan.dx;
        totalDz += pan.dz;
      }
      return { totalDx, totalDz };
    });

    const expectedDx = 0.8 * 0.7 * 1.0; // 0.56 m
    const expectedDz = -0.6 * 0.7 * 1.0; // -0.42 m

    for (const { totalDx, totalDz } of normalPans) {
      assert(Math.abs(totalDx - expectedDx) < 1e-5, `Expected dx ${expectedDx}, got ${totalDx}`);
      assert(Math.abs(totalDz - expectedDz) < 1e-5, `Expected dz ${expectedDz}, got ${totalDz}`);
    }

    // Turbo pan speed (1.5 m/s)
    const turboPans = frameRates.map((fps) => {
      const dt = 1 / fps;
      let totalDx = 0;
      for (let i = 0; i < fps; i++) {
        totalDx += computeThumbstickPan(1.0, 0, true, dt).dx;
      }
      return totalDx;
    });

    for (const dx of turboPans) {
      assert(Math.abs(dx - 1.5) < 1e-5, `Expected turbo dx 1.5m, got ${dx}`);
    }

    // Deadzone (|stick| <= 0.1)
    const deadzone = computeThumbstickPan(0.05, -0.08, false, 1 / 72);
    assert.strictEqual(deadzone.dx, 0);
    assert.strictEqual(deadzone.dz, 0);
  });

  it('tabletop yaw rotation is identical per second across 60, 72, 90, and 120 Hz', () => {
    const frameRates = [60, 72, 90, 120];
    const stickX = 1.0;

    const rotResults = frameRates.map((fps) => {
      const dt = 1 / fps;
      let totalRot = 0;
      for (let i = 0; i < fps; i++) {
        totalRot += computeThumbstickRotation(stickX, dt);
      }
      return totalRot;
    });

    const expectedRot = 2.1 * 1.0; // 2.1 rad/s

    for (const rot of rotResults) {
      assert(Math.abs(rot - expectedRot) < 1e-5, `Expected rot ${expectedRot}, got ${rot}`);
    }

    // Deadzone (|stickX| <= 0.12)
    assert.strictEqual(computeThumbstickRotation(0.10, 1 / 72), 0);
    assert.strictEqual(computeThumbstickRotation(-0.11, 1 / 72), 0);
  });

  it('tabletop exponential zoom is strictly frame-rate independent across 60, 72, 90, and 120 Hz', () => {
    const frameRates = [60, 72, 90, 120];
    const initialScale = 0.002;
    const stickY = -0.8; // Zoom in (push stick up)

    const finalScales = frameRates.map((fps) => {
      const dt = 1 / fps;
      let scale = initialScale;
      for (let i = 0; i < fps; i++) {
        const factor = computeThumbstickZoomFactor(stickY, dt);
        scale *= factor;
      }
      return scale;
    });

    // Under exponential model: scale(t) = initialScale * exp(-stickY * zoomRate * t)
    const expectedScale = initialScale * Math.exp(-stickY * 2.1 * 1.0);

    for (let i = 0; i < finalScales.length; i++) {
      const scale = finalScales[i];
      const relDiff = Math.abs(scale - expectedScale) / expectedScale;
      assert(relDiff < 1e-7, `Scale at ${frameRates[i]} Hz differs by ${relDiff * 100}%`);
    }

    // Zoom out (stickY > 0)
    const zoomOutScales = frameRates.map((fps) => {
      const dt = 1 / fps;
      let scale = initialScale;
      for (let i = 0; i < fps; i++) {
        const factor = computeThumbstickZoomFactor(0.9, dt);
        scale *= factor;
      }
      return scale;
    });

    const expectedZoomOut = initialScale * Math.exp(-0.9 * 2.1 * 1.0);
    for (const scale of zoomOutScales) {
      assert(Math.abs(scale - expectedZoomOut) / expectedZoomOut < 1e-7);
    }

    // Deadzone (|stickY| <= 0.12)
    assert.strictEqual(computeThumbstickZoomFactor(0.10, 1 / 72), 1.0);
    assert.strictEqual(computeThumbstickZoomFactor(-0.08, 1 / 72), 1.0);
  });

  it('XRManager end-to-end simulation achieves frame-rate independence on dioramaRoot', () => {
    const createMockXRManager = () => {
      const scene = new THREE.Scene();
      const dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0, 1.2, -1.0);
      dioramaRoot.rotation.set(0, 0, 0);
      dioramaRoot.scale.set(0.002, 0.002, 0.002);
      scene.add(dioramaRoot);

      const mockSession = {};
      const mockControllers: any[] = [];
      const mockGrips: any[] = [];
      const mockHands: any[] = [];

      for (let i = 0; i < 2; i++) {
        const ctrl = new THREE.Group();
        const grip = new THREE.Group();
        const hand = new THREE.Group();
        mockControllers.push(ctrl);
        mockGrips.push(grip);
        mockHands.push(hand);
      }

      const mockSceneManager = {
        scene,
        dioramaRoot,
        camera: new THREE.PerspectiveCamera(),
        renderer: {
          xr: {
            getSession: () => mockSession,
            getController: (i: number) => mockControllers[i],
            getControllerGrip: (i: number) => mockGrips[i],
            getHand: (i: number) => mockHands[i],
          },
        },
      } as any;

      const xrManager = new XRManager(mockSceneManager);

      // Connect left and right controllers
      const leftInputSource = {
        handedness: 'left',
        gamepad: {
          axes: [0, 0, 0.8, -0.6], // stickX = 0.8, stickY = -0.6
          buttons: [{ pressed: false }, { pressed: false }],
        },
      };
      const rightInputSource = {
        handedness: 'right',
        gamepad: {
          axes: [0, 0, 0.9, -0.7], // stickX = 0.9 (rotate), stickY = -0.7 (zoom)
          buttons: [{ pressed: false }, { pressed: false }],
        },
      };

      // Dispatch connected events
      mockControllers[0].dispatchEvent({ type: 'connected', data: leftInputSource });
      mockControllers[1].dispatchEvent({ type: 'connected', data: rightInputSource });

      return { xrManager, dioramaRoot };
    };

    const frameRates = [60, 72, 90, 120];
    const results: { pos: THREE.Vector3; rotY: number; scale: number }[] = [];

    for (const fps of frameRates) {
      const { xrManager, dioramaRoot } = createMockXRManager();
      const dt = 1 / fps;

      for (let f = 0; f < fps; f++) {
        xrManager.update(dt);
      }

      results.push({
        pos: dioramaRoot.position.clone(),
        rotY: dioramaRoot.rotation.y,
        scale: dioramaRoot.scale.x,
      });

      xrManager.dispose();
    }

    const baseline = results[0]; // 60 Hz baseline
    for (let i = 1; i < results.length; i++) {
      const r = results[i];
      const fps = frameRates[i];

      // Position (Pan) difference < 0.001%
      assert(
        r.pos.distanceTo(baseline.pos) < 1e-4,
        `Position differs at ${fps} Hz: baseline=${baseline.pos.toArray()} vs ${r.pos.toArray()}`
      );

      // Rotation difference < 0.001%
      assert(
        Math.abs(r.rotY - baseline.rotY) < 1e-4,
        `Rotation differs at ${fps} Hz: baseline=${baseline.rotY} vs ${r.rotY}`
      );

      // Scale (Zoom) difference < 0.001%
      const scaleRelDiff = Math.abs(r.scale - baseline.scale) / baseline.scale;
      assert(
        scaleRelDiff < 1e-4,
        `Scale differs at ${fps} Hz: baseline=${baseline.scale} vs ${r.scale} (${scaleRelDiff * 100}%)`
      );
    }
  });

  it('XRManager.dispose() cleans up scene objects, geometries, and materials idempotently', () => {
    const scene = new THREE.Scene();
    const dioramaRoot = new THREE.Group();
    scene.add(dioramaRoot);

    const mockControllers: any[] = [];
    const mockGrips: any[] = [];
    const mockHands: any[] = [];

    for (let i = 0; i < 2; i++) {
      mockControllers.push(new THREE.Group());
      mockGrips.push(new THREE.Group());
      mockHands.push(new THREE.Group());
    }

    const mockSceneManager = {
      scene,
      dioramaRoot,
      camera: new THREE.PerspectiveCamera(),
      renderer: {
        xr: {
          getSession: () => null,
          getController: (i: number) => mockControllers[i],
          getControllerGrip: (i: number) => mockGrips[i],
          getHand: (i: number) => mockHands[i],
        },
      },
    } as any;

    const xr = new XRManager(mockSceneManager);

    // Initial scene should contain controllers, grips, hands, visual outlines, reticles
    const initialChildrenCount = scene.children.length;
    assert(initialChildrenCount > 5, `Expected >5 scene children, got ${initialChildrenCount}`);

    // First dispose call
    xr.dispose();

    // Scene should now only have dioramaRoot (all XR meshes and groups detached)
    assert.strictEqual(scene.children.length, 1, 'Only dioramaRoot should remain in scene');
    assert.strictEqual(scene.children[0], dioramaRoot);

    // Second dispose call (must be strictly idempotent)
    assert.doesNotThrow(() => {
      xr.dispose();
    });

    // Update call after dispose should safely be a no-op
    assert.doesNotThrow(() => {
      xr.update(1 / 72);
    });
  });
});
