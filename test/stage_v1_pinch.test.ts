import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  PINCH_ENGAGE_DISTANCE,
  PINCH_RELEASE_DISTANCE,
  PINCH_CONFIRMATION_FRAMES,
  createPinchTracker,
  updatePinchTracker,
  evaluatePinchState,
} from '../src/xr/GestureMath.ts';
import { XRManager, ALL_HAND_JOINTS } from '../src/core/XRManager.ts';

describe('Stage V1: Strict Intentional Hand Pinch & Grab Precision', () => {
  describe('1.1 & 1.6 Physical Separation Thresholds', () => {
    it('enforces strict physical contact thresholds (20mm engage, 28mm release)', () => {
      expect(PINCH_ENGAGE_DISTANCE).toBe(0.020);
      expect(PINCH_RELEASE_DISTANCE).toBe(0.028);

      // Relaxed separation: 30mm -> NOT pinching
      expect(evaluatePinchState(0.030, false)).toBe(false);

      // Very relaxed: 40mm -> NOT pinching
      expect(evaluatePinchState(0.040, false)).toBe(false);

      // Near but not touching: 25mm -> must NOT initiate new pinch
      expect(evaluatePinchState(0.025, false)).toBe(false);

      // Actual fingertip contact: 19mm -> initiates pinch
      expect(evaluatePinchState(0.019, false)).toBe(true);

      // Inside hysteresis: 25mm -> stays latched if already pinching
      expect(evaluatePinchState(0.025, true)).toBe(true);

      // Exceeds release threshold: 29mm -> releases
      expect(evaluatePinchState(0.029, true)).toBe(false);
    });
  });

  describe('1.2 Temporal Confirmation & Edge States', () => {
    it('suppresses single-frame noise and confirms sustained contact with exactly one edge', () => {
      const tracker = createPinchTracker();
      expect(tracker.phase).toBe('open');
      expect(tracker.isPinching).toBe(false);

      // Frame 1: 1-frame noisy contact (18mm)
      updatePinchTracker(tracker, 0.018);
      expect(tracker.phase).toBe('candidate');
      expect(tracker.contactFrames).toBe(1);
      expect(tracker.isPinching).toBe(false);
      expect(tracker.justPinched).toBe(false);

      // Frame 2: Noise ends, separation opens to 35mm
      updatePinchTracker(tracker, 0.035);
      expect(tracker.phase).toBe('open');
      expect(tracker.contactFrames).toBe(0);
      expect(tracker.isPinching).toBe(false);
      expect(tracker.justPinched).toBe(false);

      // Now simulate sustained contact over confirmation interval (3 frames at 18mm)
      // Frame 1 of sustained contact
      updatePinchTracker(tracker, 0.018);
      expect(tracker.phase).toBe('candidate');
      expect(tracker.contactFrames).toBe(1);
      expect(tracker.isPinching).toBe(false);
      expect(tracker.justPinched).toBe(false);

      // Frame 2 of sustained contact
      updatePinchTracker(tracker, 0.018);
      expect(tracker.phase).toBe('candidate');
      expect(tracker.contactFrames).toBe(2);
      expect(tracker.isPinching).toBe(false);
      expect(tracker.justPinched).toBe(false);

      // Frame 3 of sustained contact: Confirmation reached!
      updatePinchTracker(tracker, 0.018);
      expect(tracker.phase).toBe('pinching');
      expect(tracker.isPinching).toBe(true);
      expect(tracker.justPinched).toBe(true); // Confirmed fresh edge

      // Frame 4: Continued contact: stays pinching, but justPinched is false
      updatePinchTracker(tracker, 0.018);
      expect(tracker.phase).toBe('pinching');
      expect(tracker.isPinching).toBe(true);
      expect(tracker.justPinched).toBe(false);

      // Frame 5: Finger opens to 32mm: immediate release
      updatePinchTracker(tracker, 0.032);
      expect(tracker.phase).toBe('released');
      expect(tracker.isPinching).toBe(false);
      expect(tracker.justReleased).toBe(true);
    });
  });

  describe('1.3 Fresh Pinch Edge Gating for Terrain Manipulation', () => {
    let mockSceneManager: any;
    let xrManager: XRManager;
    let mockControllers: THREE.Group[];
    let mockGrips: THREE.Group[];
    let mockHands: THREE.Group[];

    beforeEach(() => {
      mockControllers = [new THREE.Group(), new THREE.Group()];
      mockGrips = [new THREE.Group(), new THREE.Group()];
      mockHands = [];

      for (let i = 0; i < 2; i++) {
        const h = new THREE.Group();
        const joints: any = {};
        for (const jName of ALL_HAND_JOINTS) {
          const jointObj = new THREE.Object3D();
          jointObj.visible = true;
          joints[jName] = jointObj;
          h.add(jointObj);
        }
        (h as any).joints = joints;
        mockHands.push(h);
      }

      mockSceneManager = {
        scene: new THREE.Scene(),
        dioramaRoot: new THREE.Group(),
        camera: new THREE.PerspectiveCamera(),
        renderer: {
          xr: {
            getSession: () => ({ inputSources: [] }),
            getController: (i: number) => mockControllers[i],
            getControllerGrip: (i: number) => mockGrips[i],
            getHand: (i: number) => mockHands[i],
          },
        },
      };

      xrManager = new XRManager(mockSceneManager);

      // Setup diorama context (Mount Rainier bounds: ~10km width, elevation 1400m)
      xrManager.setDioramaContext(
        {
          minLat: 46.8,
          maxLat: 46.9,
          minLon: -121.8,
          maxLon: -121.7,
          minEle: 1000,
          maxEle: 4392,
          centerLat: 46.85,
          centerLon: -121.75,
          widthMeters: 10000,
          depthMeters: 10000,
          elevationSpan: 3392,
        },
        () => 1400,
        1400,
        1.0
      );

      // Tabletop diorama world-locked position
      mockSceneManager.dioramaRoot.position.set(0, 0.82, -0.80);
      mockSceneManager.dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);
      mockSceneManager.dioramaRoot.updateMatrixWorld(true);
    });

    function setTips(thumb: THREE.Vector3, index: THREE.Vector3) {
      const joints = (mockHands[0] as any).joints;
      joints['thumb-tip'].position.copy(thumb);
      joints['index-finger-tip'].position.copy(index);
    }

    it('rejects terrain grab when hand enters manipulation region while ALREADY pinching', () => {
      const handState = (xrManager as any).hands[0];
      expect(handState).toBeDefined();

      // Enable visual group
      handState.visualOutline.group.visible = true;

      // 1. Hand pinches in midair FAR away from diorama (e.g. at [1.0, 1.5, 0.5])
      const thumbPos = new THREE.Vector3(1.0, 1.5, 0.5);
      const indexPos = new THREE.Vector3(1.0, 1.518, 0.5); // dist = 18mm
      setTips(thumbPos, indexPos);

      // Run 3 frames in midair to confirm pinch
      for (let f = 0; f < PINCH_CONFIRMATION_FRAMES; f++) {
        (xrManager as any).updateHandTracking();
        (xrManager as any).processHandGrabs();
      }

      expect(handState.isPinching).toBe(true);
      expect(handState.activeInteraction).toBe('none'); // Midair: no grab claimed

      // 2. Next frame: hand MOVES into diorama reach area while STILL pinching!
      // Diorama is at [0, 0.82, -0.80]
      thumbPos.set(0, 0.82, -0.80);
      indexPos.set(0, 0.838, -0.80); // dist = 18mm
      setTips(thumbPos, indexPos);

      (xrManager as any).updateHandTracking();
      const grabs = (xrManager as any).processHandGrabs();

      // Invariant: Hand entered diorama while already pinching -> MUST NOT claim diorama grab!
      expect(handState.pinchTracker.justPinched).toBe(false);
      expect(handState.activeInteraction).toBe('none');
      expect(grabs.length).toBe(0);

      // 3. User releases pinch while within diorama reach area
      indexPos.set(0, 0.86, -0.80); // dist = 40mm (> 28mm release)
      setTips(thumbPos, indexPos);
      (xrManager as any).updateHandTracking();
      (xrManager as any).processHandGrabs();
      expect(handState.isPinching).toBe(false);
      expect(handState.activeInteraction).toBe('none');

      // 4. User now intentionally pinches within reach area over 3 frames
      indexPos.set(0, 0.838, -0.80); // dist = 18mm
      setTips(thumbPos, indexPos);
      for (let f = 0; f < PINCH_CONFIRMATION_FRAMES; f++) {
        (xrManager as any).updateHandTracking();
        (xrManager as any).processHandGrabs();
      }

      // Fresh pinch confirmed inside reach envelope -> claims diorama grab!
      expect(handState.isPinching).toBe(true);
      expect(handState.activeInteraction).toBe('diorama');
    });

    it('immediately cancels active diorama grab when joint tracking is lost or controller takes ownership', () => {
      const handState = (xrManager as any).hands[0];
      handState.visualOutline.group.visible = true;

      // Establish active diorama grab
      const thumbPos = new THREE.Vector3(0, 0.82, -0.80);
      const indexPos = new THREE.Vector3(0, 0.838, -0.80); // dist = 18mm
      setTips(thumbPos, indexPos);

      for (let f = 0; f < PINCH_CONFIRMATION_FRAMES; f++) {
        (xrManager as any).updateHandTracking();
        (xrManager as any).processHandGrabs();
      }

      expect(handState.activeInteraction).toBe('diorama');

      // Case A: Index tip tracking lost
      const joints = (mockHands[0] as any).joints;
      joints['index-finger-tip'].visible = false;
      (xrManager as any).updateHandTracking();
      expect(handState.isPinching).toBe(false);
      expect(handState.activeInteraction).toBe('none');

      // Re-establish grab
      joints['index-finger-tip'].visible = true;
      for (let f = 0; f < PINCH_CONFIRMATION_FRAMES; f++) {
        (xrManager as any).updateHandTracking();
        (xrManager as any).processHandGrabs();
      }
      expect(handState.activeInteraction).toBe('diorama');

      // Case B: Physical controller takes ownership
      vi.spyOn(xrManager as any, 'isPhysicalControllerActive').mockReturnValue(true);
      (xrManager as any).enforcePhysicalControllerOwnership();

      expect(handState.visualOutline.group.visible).toBe(false);
      expect(handState.isPinching).toBe(false);
      expect(handState.activeInteraction).toBe('none');
    });

    it('guarantees relaxed hand (30mm separation) never moves dioramaRoot over 100 frames', () => {
      const handState = (xrManager as any).hands[0];
      handState.visualOutline.group.visible = true;

      const initialPos = mockSceneManager.dioramaRoot.position.clone();
      const initialRot = mockSceneManager.dioramaRoot.rotation.clone();
      const initialScale = mockSceneManager.dioramaRoot.scale.clone();

      // Hand inside reach area with relaxed 32mm separation
      const thumbPos = new THREE.Vector3(0, 0.82, -0.80);
      const indexPos = new THREE.Vector3(0, 0.852, -0.80); // 32mm separation
      setTips(thumbPos, indexPos);

      // Simulate 100 frames (~1.4 seconds at 72Hz) of casual hand motion
      for (let frame = 0; frame < 100; frame++) {
        thumbPos.x = 0.05 * Math.sin(frame * 0.1);
        thumbPos.y = 0.82 + 0.02 * Math.cos(frame * 0.1);
        indexPos.x = thumbPos.x;
        indexPos.y = thumbPos.y + 0.032; // Always relaxed (32mm)
        setTips(thumbPos, indexPos);

        (xrManager as any).updateHandTracking();
        const grabs = (xrManager as any).processHandGrabs();
        (xrManager as any).applyManipulation(grabs);

        expect(handState.isPinching).toBe(false);
        expect(handState.activeInteraction).toBe('none');
        expect(grabs.length).toBe(0);
      }

      // DioramaRoot transform must remain strictly identical
      expect(mockSceneManager.dioramaRoot.position.distanceTo(initialPos)).toBe(0);
      expect(mockSceneManager.dioramaRoot.rotation.x).toBe(initialRot.x);
      expect(mockSceneManager.dioramaRoot.rotation.y).toBe(initialRot.y);
      expect(mockSceneManager.dioramaRoot.rotation.z).toBe(initialRot.z);
      expect(mockSceneManager.dioramaRoot.scale.distanceTo(initialScale)).toBe(0);
    });
  });
});
