import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { XRManager } from '../src/core/XRManager.ts';

describe('Stage T1: Explicit XR Input-Source Ownership & Hand Exclusivity (Section 4)', () => {
  let mockSceneManager: any;
  let mockControllers: THREE.Group[];
  let mockGrips: THREE.Group[];
  let mockHands: THREE.Group[];
  let mockSession: any;
  let xrManager: XRManager;

  beforeEach(() => {
    mockControllers = [];
    mockGrips = [];
    mockHands = [];

    for (let i = 0; i < 2; i++) {
      const ctrl = new THREE.Group();
      const grip = new THREE.Group();
      const hand = new THREE.Group();
      mockControllers.push(ctrl);
      mockGrips.push(grip);
      mockHands.push(hand);
    }

    mockSession = {
      inputSources: [],
    };

    mockSceneManager = {
      scene: new THREE.Scene(),
      dioramaRoot: new THREE.Group(),
      camera: new THREE.PerspectiveCamera(),
      renderer: {
        xr: {
          getSession: () => mockSession,
          getController: (i: number) => mockControllers[i],
          getControllerGrip: (i: number) => mockGrips[i],
          getHand: (i: number) => mockHands[i],
        },
      },
    };

    xrManager = new XRManager(mockSceneManager);
  });

  afterEach(() => {
    xrManager.dispose();
  });

  it('correctly identifies whether a physical controller is active for each handedness', () => {
    expect(xrManager.isPhysicalControllerActive('left')).toBe(false);
    expect(xrManager.isPhysicalControllerActive('right')).toBe(false);

    // Simulate right Touch Plus controller connection
    const controllers = (xrManager as any).controllers;
    controllers[0].inputSource = {
      handedness: 'right',
      hand: undefined,
      targetRayMode: 'tracked-pointer',
    };

    expect(xrManager.isPhysicalControllerActive('right')).toBe(true);
    expect(xrManager.isPhysicalControllerActive('left')).toBe(false);

    // Simulate left Touch Plus controller connection
    controllers[1].inputSource = {
      handedness: 'left',
      hand: undefined,
      targetRayMode: 'tracked-pointer',
    };

    expect(xrManager.isPhysicalControllerActive('left')).toBe(true);
    expect(xrManager.isPhysicalControllerActive('right')).toBe(true);

    // Simulate disconnect of right controller
    controllers[0].inputSource = null;
    expect(xrManager.isPhysicalControllerActive('right')).toBe(false);
    expect(xrManager.isPhysicalControllerActive('left')).toBe(true);
  });

  it('immediately hides hand outline and pinch reticle when physical controller connects', () => {
    const hands = (xrManager as any).hands;
    const rightHand = hands[1]; // right hand
    rightHand.inputSource = { handedness: 'right', hand: {} };

    // Initially simulate bare hand tracking with active visible outline
    rightHand.visualOutline.group.visible = true;
    rightHand.pinchReticle.visible = true;
    rightHand.isPinching = true;
    rightHand.activeInteraction = 'diorama';

    // Verify initial hand state
    expect(rightHand.visualOutline.group.visible).toBe(true);

    // Pick up right physical controller
    const controllers = (xrManager as any).controllers;
    const rightController = controllers[1];

    // Trigger connected event on controller
    const connectEvent = {
      data: {
        handedness: 'right',
        hand: undefined,
        targetRayMode: 'tracked-pointer',
      },
    };
    rightController.controller.dispatchEvent({ type: 'connected', data: connectEvent.data } as any);

    // Verify right hand visuals and interactions are immediately hidden/suppressed
    expect(rightHand.visualOutline.group.visible).toBe(false);
    expect(rightHand.pinchReticle.visible).toBe(false);
    expect(rightHand.isPinching).toBe(false);
    expect(rightHand.activeInteraction).toBe('none');
  });

  it('keeps hand skeleton hidden even if stale joints report visible while controller is active (Quest bug)', () => {
    const hands = (xrManager as any).hands;
    const rightHand = hands[1];
    rightHand.inputSource = { handedness: 'right', hand: {} };

    // Set up mock joints that persistently report visible: true
    const joints: Record<string, any> = {};
    for (const jointName of (xrManager as any).constructor.ALL_HAND_JOINTS || [
      'wrist',
      'thumb-metacarpal',
      'index-finger-tip',
    ]) {
      joints[jointName] = {
        visible: true,
        position: new THREE.Vector3(0.1, 1.0, -0.5),
      };
    }
    rightHand.hand.joints = joints;

    // Right physical controller is active
    const controllers = (xrManager as any).controllers;
    controllers[1].inputSource = {
      handedness: 'right',
      hand: undefined,
    };

    // Run frame update
    (xrManager as any).updateHandTracking();

    // Hand outline MUST stay hidden despite visible joints!
    expect(rightHand.visualOutline.group.visible).toBe(false);
    expect(rightHand.hand.visible).toBe(false);
    expect(rightHand.isPinching).toBe(false);
  });

  it('allows hand outline to reappear when controller is put down and hand tracking resumes', () => {
    const hands = (xrManager as any).hands;
    const rightHand = hands[1];
    rightHand.inputSource = { handedness: 'right', hand: {} };

    const joints: Record<string, any> = {};
    joints['wrist'] = {
      visible: true,
      position: new THREE.Vector3(0.1, 1.0, -0.5),
    };
    rightHand.hand.joints = joints;

    const controllers = (xrManager as any).controllers;
    const rightController = controllers[1];
    rightController.inputSource = {
      handedness: 'right',
      hand: undefined,
    };

    // Active controller -> hidden
    (xrManager as any).updateHandTracking();
    expect(rightHand.visualOutline.group.visible).toBe(false);

    // Put down controller (disconnects)
    rightController.controller.dispatchEvent({
      type: 'disconnected',
      data: { handedness: 'right' },
    } as any);

    expect(xrManager.isPhysicalControllerActive('right')).toBe(false);

    // Update hand tracking -> hand visuals reappear cleanly
    (xrManager as any).updateHandTracking();
    expect(rightHand.visualOutline.group.visible).toBe(true);
  });

  it('handles mixed hand + controller state (e.g. left bare hand + right Touch Plus controller)', () => {
    const hands = (xrManager as any).hands;
    const controllers = (xrManager as any).controllers;

    const leftHand = hands[0];
    leftHand.inputSource = { handedness: 'left', hand: {} };
    leftHand.hand.joints = {
      wrist: { visible: true, position: new THREE.Vector3(-0.1, 1.0, -0.5) },
    };

    const rightHand = hands[1];
    rightHand.inputSource = { handedness: 'right', hand: {} };
    rightHand.hand.joints = {
      wrist: { visible: true, position: new THREE.Vector3(0.1, 1.0, -0.5) },
    };

    // Right controller is active; left controller is not
    controllers[1].inputSource = { handedness: 'right', hand: undefined };
    controllers[0].inputSource = null;

    (xrManager as any).updateHandTracking();

    // Left hand is visible (bare hand tracking active)
    expect(leftHand.visualOutline.group.visible).toBe(true);

    // Right hand is suppressed (Touch Plus controller has ownership)
    expect(rightHand.visualOutline.group.visible).toBe(false);
  });
});
