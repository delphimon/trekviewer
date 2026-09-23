import * as THREE from 'three';
import { SceneManager } from './SceneManager.ts';
import { SpatialHUD } from '../ui/SpatialHUD.ts';
import type { GeoBounds } from '../gpx/TrackTypes.ts';

export interface XRInteractionCallbacks {
  onToggleViewMode?: () => void;
  onTogglePlay?: () => void;
  onReset?: () => void;
  onExitMR?: () => void;
  onFocusHiker?: () => void;
  onScrub?: (fraction: number) => void;
  onScrubDistance?: (metersDelta: number) => void;
  onSelectWaypoint?: (name: string) => void;
}

export interface ActiveGrab {
  id: string;
  source: 'hand' | 'controller';
  worldPos: THREE.Vector3;
  prevWorldPos: THREE.Vector3;
  wristQuat?: THREE.Quaternion;
  prevWristQuat?: THREE.Quaternion;
}

export const ALL_HAND_JOINTS: string[] = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
];

export const BONE_CONNECTIONS: [string, string][] = [
  // Thumb
  ['wrist', 'thumb-metacarpal'],
  ['thumb-metacarpal', 'thumb-phalanx-proximal'],
  ['thumb-phalanx-proximal', 'thumb-phalanx-distal'],
  ['thumb-phalanx-distal', 'thumb-tip'],

  // Index
  ['wrist', 'index-finger-metacarpal'],
  ['index-finger-metacarpal', 'index-finger-phalanx-proximal'],
  ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate'],
  ['index-finger-phalanx-intermediate', 'index-finger-phalanx-distal'],
  ['index-finger-phalanx-distal', 'index-finger-tip'],

  // Middle
  ['wrist', 'middle-finger-metacarpal'],
  ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal'],
  ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate'],
  ['middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal'],
  ['middle-finger-phalanx-distal', 'middle-finger-tip'],

  // Ring
  ['wrist', 'ring-finger-metacarpal'],
  ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal'],
  ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate'],
  ['ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal'],
  ['ring-finger-phalanx-distal', 'ring-finger-tip'],

  // Pinky
  ['wrist', 'pinky-finger-metacarpal'],
  ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal'],
  ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate'],
  ['pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal'],
  ['pinky-finger-phalanx-distal', 'pinky-finger-tip'],

  // Knuckle transverse arch across palm
  ['thumb-metacarpal', 'index-finger-metacarpal'],
  ['index-finger-metacarpal', 'middle-finger-metacarpal'],
  ['middle-finger-metacarpal', 'ring-finger-metacarpal'],
  ['ring-finger-metacarpal', 'pinky-finger-metacarpal'],
];

export interface HandVisualOutline {
  group: THREE.Group;
  jointMeshes: Map<string, THREE.Mesh>;
  boneLines: THREE.LineSegments;
  bonePositions: THREE.BufferAttribute;
}

const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();
const _scratchV3 = new THREE.Vector3();
const _scratchM1 = new THREE.Matrix4();
const _scratchV2D1 = new THREE.Vector2();
const _scratchV2D2 = new THREE.Vector2();

export interface HandState {
  hand: THREE.XRHandSpace;
  inputSource: any;
  pinchReticle: THREE.Mesh;
  visualOutline: HandVisualOutline;
  isPinching: boolean;
  isClickingHUD: boolean;
  activeInteraction: 'none' | 'hud' | 'diorama';
  jointPosMap: Map<string, THREE.Vector3>;
  pinchWorldPos: THREE.Vector3;
  prevPinchWorldPos: THREE.Vector3;
  wristWorldPos: THREE.Vector3;
  prevWristWorldPos: THREE.Vector3;
  wristWorldQuat: THREE.Quaternion;
  prevWristWorldQuat: THREE.Quaternion;
  indexTipWorldPos: THREE.Vector3;
}

interface ControllerState {
  controller: THREE.XRTargetRaySpace;
  grip: THREE.XRGripSpace;
  rayLine: THREE.Line;
  reticle: THREE.Mesh;
  inputSource: any;
  prevButtons: boolean[];
  prevGripWorldPos: THREE.Vector3;
  isGripping: boolean;
  isDraggingHUD: boolean;
  hudDragDistance: number;
  isDraggingTerrain: boolean;
  terrainDragStartHit: THREE.Vector3;
  terrainDragStartDioramaPos: THREE.Vector3;
  isHoveringHUD: boolean;
  isInteractingWithHUD: boolean;
}

export class XRManager {
  private sceneManager: SceneManager;
  private renderer: THREE.WebGLRenderer;
  private controllers: ControllerState[] = [];
  private hands: HandState[] = [];
  private raycaster: THREE.Raycaster;
  private spatialHUD: SpatialHUD | null = null;
  private currentViewMode: 'diorama' | 'first-person' | 'flyover' = 'diorama';
  private hapticDistanceAccumulator: number = 0;

  private callbacks: XRInteractionCallbacks = {};

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.renderer = sceneManager.renderer;
    this.raycaster = new THREE.Raycaster();
    this.setupControllers();
    this.setupHands();
  }

  public setCallbacks(cb: XRInteractionCallbacks): void {
    this.callbacks = cb;
  }

  public setViewMode(mode: 'diorama' | 'first-person' | 'flyover'): void {
    this.currentViewMode = mode;
  }

  public setSpatialHUD(hud: SpatialHUD | null): void {
    this.spatialHUD = hud;
  }

  // Tabletop Diorama Proximity Context
  private dioramaBounds: GeoBounds | null = null;
  private dioramaWidthMeters: number = 2000;
  private dioramaDepthMeters: number = 2000;
  private dioramaElevationSampler: ((x: number, z: number) => number) | null = null;
  private dioramaBaseElevation: number = 0;
  private dioramaVerticalExaggeration: number = 1.0;
  private dioramaPlinthBottomY: number = -105; // Plinth bottom in local diorama coords (-80 - 25 = -105)

  public setDioramaContext(
    bounds: GeoBounds,
    elevationSampler?: (x: number, z: number) => number,
    baseElevation: number = bounds.minEle,
    verticalExaggeration: number = 1.0
  ): void {
    this.dioramaBounds = bounds;
    const margin = 0.25;
    this.dioramaWidthMeters = Math.max(bounds.widthMeters * (1 + margin * 2), 1500);
    this.dioramaDepthMeters = Math.max(bounds.depthMeters * (1 + margin * 2), 1500);
    this.dioramaElevationSampler = elevationSampler || null;
    this.dioramaBaseElevation = baseElevation;
    this.dioramaVerticalExaggeration = verticalExaggeration;
  }

  public setVerticalExaggeration(factor: number): void {
    this.dioramaVerticalExaggeration = factor;
  }

  public isHandTouchingDiorama(handWorldPos: THREE.Vector3): boolean {
    if (this.currentViewMode !== 'diorama') return false;
    const dioramaRoot = this.sceneManager.dioramaRoot;
    if (!dioramaRoot.visible) return false;

    const dioramaScale = dioramaRoot.scale.x;
    if (dioramaScale <= 0) return false;

    // Transform hand world position to local diorama coordinates
    const local = _scratchV1.copy(handWorldPos);
    dioramaRoot.worldToLocal(local);

    const halfW = this.dioramaWidthMeters * 0.5;
    const halfD = this.dioramaDepthMeters * 0.5;

    // 1. Horizontal distance outside diorama boundary (sides) in real-world meters
    const dxLocal = Math.max(0, Math.abs(local.x) - halfW);
    const dzLocal = Math.max(0, Math.abs(local.z) - halfD);
    const distHorizWorld = Math.hypot(dxLocal, dzLocal) * dioramaScale;

    // Hand is away to the sides if > 8cm outside diorama footprint
    if (distHorizWorld > 0.08) {
      return false;
    }

    // 2. Local terrain surface elevation at hand (x, z)
    const clampedX = Math.max(-halfW, Math.min(halfW, local.x));
    const clampedZ = Math.max(-halfD, Math.min(halfD, local.z));

    let localSurfaceY = 0;
    if (this.dioramaElevationSampler) {
      try {
        const sample = this.dioramaElevationSampler(clampedX, clampedZ);
        if (typeof sample === 'number' && !isNaN(sample)) {
          localSurfaceY = sample * this.dioramaVerticalExaggeration;
        }
      } catch {
        localSurfaceY = 0;
      }
    }

    // Hand is above map if > 8cm above local terrain surface
    const dyAboveWorld = (local.y - localSurfaceY) * dioramaScale;
    if (dyAboveWorld > 0.08) {
      return false;
    }

    // Hand is below map if > 6cm below diorama plinth bottom
    const dyBelowWorld = (this.dioramaPlinthBottomY - local.y) * dioramaScale;
    if (dyBelowWorld > 0.06) {
      return false;
    }

    return true;
  }

  private setupControllers(): void {
    for (let i = 0; i < 2; i++) {
      // 1. Target ray space (laser pointer direction)
      const controller = this.renderer.xr.getController(i);
      controller.name = `ControllerRay_${i}`;
      this.sceneManager.scene.add(controller);

      // Visual laser pointer beam
      const rayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2.5),
      ]);
      const rayMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.65,
      });
      const rayLine = new THREE.Line(rayGeo, rayMat);
      rayLine.name = 'LaserRay';
      controller.add(rayLine);

      // Pointer cursor reticle dot
      const reticleGeo = new THREE.RingGeometry(0.008, 0.015, 24);
      const reticleMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      });
      const reticle = new THREE.Mesh(reticleGeo, reticleMat);
      reticle.visible = false;
      this.sceneManager.scene.add(reticle);

      // 2. Grip space (physical controller location)
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.name = `ControllerGrip_${i}`;
      this.sceneManager.scene.add(grip);

      // No black cylinder bar handle - physical controllers are held in real life,
      // and in hand mode no artificial bar should appear in the palm!

      const state: ControllerState = {
        controller,
        grip,
        rayLine,
        reticle,
        inputSource: null,
        prevButtons: [false, false, false, false, false, false, false, false],
        prevGripWorldPos: new THREE.Vector3(),
        isGripping: false,
        isDraggingHUD: false,
        hudDragDistance: 1.0,
        isDraggingTerrain: false,
        terrainDragStartHit: new THREE.Vector3(),
        terrainDragStartDioramaPos: new THREE.Vector3(),
        isHoveringHUD: false,
        isInteractingWithHUD: false,
      };

      controller.addEventListener('connected', (event: any) => {
        state.inputSource = event.data;
      });

      controller.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.isGripping = false;
        state.isDraggingHUD = false;
        state.isDraggingTerrain = false;
        state.isHoveringHUD = false;
        state.isInteractingWithHUD = false;
        state.rayLine.visible = false;
        state.reticle.visible = false;
      });

      this.controllers.push(state);
    }
  }

  private setupHands(): void {
    for (let i = 0; i < 2; i++) {
      const hand = this.renderer.xr.getHand(i);
      hand.name = `XRHand_${i}`;
      this.sceneManager.scene.add(hand);

      // Dedicated Glowing Hand Outline Skeleton (All 25 joints + 24 bone outline lines)
      const visualOutlineGroup = new THREE.Group();
      visualOutlineGroup.name = `HandVisualOutline_${i}`;
      visualOutlineGroup.visible = false;
      this.sceneManager.scene.add(visualOutlineGroup);

      // 1. Joint tracking positions & optional meshes (spheres omitted from scene to eliminate joint dots)
      const jointMeshes = new Map<string, THREE.Mesh>();
      const jointPosMap = new Map<string, THREE.Vector3>();
      for (const jointName of ALL_HAND_JOINTS) {
        const isTip = jointName.endsWith('-tip');
        const isWrist = jointName === 'wrist';
        const isKnuckle = jointName.endsWith('-metacarpal');

        const radius = isWrist ? 0.008 : isTip ? 0.0065 : isKnuckle ? 0.0055 : 0.0045;
        const color = isTip ? 0xffffff : isKnuckle ? 0x0284c7 : 0x38bdf8;

        const sphereGeo = new THREE.SphereGeometry(radius, 8, 8);
        const sphereMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        });
        const mesh = new THREE.Mesh(sphereGeo, sphereMat);
        mesh.visible = false;
        // NOTE: mesh is intentionally NOT added to visualOutlineGroup to honor user preference
        // for smooth continuous holographic bone outlines without round knuckle "dots"
        jointMeshes.set(jointName, mesh);
        jointPosMap.set(jointName, new THREE.Vector3());
      }

      // 2. Bone Lines (28 bone segments connecting joints into a sleek holographic skeleton)
      const bonePositions = new Float32Array(BONE_CONNECTIONS.length * 2 * 3);
      const boneGeo = new THREE.BufferGeometry();
      boneGeo.setAttribute('position', new THREE.BufferAttribute(bonePositions, 3));
      const boneMat = new THREE.LineBasicMaterial({
        color: 0x64748b, // Faint translucent slate when away from diorama
        transparent: true,
        opacity: 0.30,
        depthTest: false,
      });
      const boneLines = new THREE.LineSegments(boneGeo, boneMat);
      boneLines.renderOrder = 998;
      visualOutlineGroup.add(boneLines);

      // Tactile pinch visual reticle (radiant cyan diamond indicator at pinch contact point)
      const pinchGeo = new THREE.OctahedronGeometry(0.012, 0);
      const pinchMat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      });
      const pinchReticle = new THREE.Mesh(pinchGeo, pinchMat);
      pinchReticle.renderOrder = 1000;
      pinchReticle.name = `HandPinchReticle_${i}`;
      pinchReticle.visible = false;
      this.sceneManager.scene.add(pinchReticle);

      const state: HandState = {
        hand,
        inputSource: null,
        pinchReticle,
        visualOutline: {
          group: visualOutlineGroup,
          jointMeshes,
          boneLines,
          bonePositions: boneGeo.getAttribute('position') as THREE.BufferAttribute,
        },
        isPinching: false,
        isClickingHUD: false,
        activeInteraction: 'none',
        jointPosMap,
        pinchWorldPos: new THREE.Vector3(),
        prevPinchWorldPos: new THREE.Vector3(),
        wristWorldPos: new THREE.Vector3(),
        prevWristWorldPos: new THREE.Vector3(),
        wristWorldQuat: new THREE.Quaternion(),
        prevWristWorldQuat: new THREE.Quaternion(),
        indexTipWorldPos: new THREE.Vector3(),
      };

      hand.addEventListener('connected', (event: any) => {
        state.inputSource = event.data;
      });

      hand.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.isPinching = false;
        state.activeInteraction = 'none';
        state.pinchReticle.visible = false;
        state.visualOutline.group.visible = false;
      });

      this.hands.push(state);
    }
  }

  public update(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    // 0. Update Bare Hand Tracking joint data, bone skeleton, and pinch state
    this.updateHandTracking();

    const activeGrabs: ActiveGrab[] = [];

    // 1. Controller Inputs & Laser Pointing
    for (let i = 0; i < this.controllers.length; i++) {
      const state = this.controllers[i];
      const source = state.inputSource;
      if (!source) {
        state.controller.visible = false;
        state.grip.visible = false;
        state.rayLine.visible = false;
        state.reticle.visible = false;
        continue;
      }

      const isHand = !!source.hand;

      if (isHand) {
        // In hand mode, physical controller grip is always hidden (no black bar)
        state.grip.visible = false;

        const matchingHand = this.hands.find(
          (h) => h.inputSource && state.inputSource && h.inputSource.handedness === state.inputSource.handedness
        ) || this.hands[i];

        // Hand pinch is triggered via WebXR trigger button or joint pinch distance (<3.2cm)
        const isHandPinching = (source.gamepad?.buttons[0]?.pressed) || (matchingHand?.isPinching) || false;
        this.updatePointerRaycast(i, state, isHandPinching, true);
        state.prevButtons[0] = isHandPinching;
        continue;
      }

      // Physical Touch Plus Controller:
      state.controller.visible = true;
      state.grip.visible = true;
      state.rayLine.visible = true;

      if (!source.gamepad) continue;

      const axes = source.gamepad.axes;
      const buttons = source.gamepad.buttons;

      // Current controller world position for natural 1:1 grip movement
      const currentGripWorld = new THREE.Vector3().setFromMatrixPosition(state.grip.matrixWorld);

      // 1. Thumbstick Navigation
      if (axes.length >= 4) {
        const stickX = axes[2];
        const stickY = axes[3];

        // --- Left Controller: TRAIL HIKE & SCRUB IN 1:1 / PAN IN DIORAMA ---
        if (source.handedness === 'left') {
          if (this.currentViewMode === 'first-person') {
            if (Math.abs(stickY) > 0.1) {
              const isTurbo = buttons[0]?.pressed || false;
              const baseSpeedMps = isTurbo ? 75.0 : 18.0;
              const metersDelta = -stickY * baseSpeedMps * (1 / 60);
              this.callbacks.onScrubDistance?.(metersDelta);

              this.hapticDistanceAccumulator += Math.abs(metersDelta);
              if (this.hapticDistanceAccumulator >= 35) {
                this.hapticDistanceAccumulator = 0;
                this.triggerHaptic(i, 0.4, 15);
              }
            }
          } else {
            if (Math.abs(stickX) > 0.1 || Math.abs(stickY) > 0.1) {
              const isTurbo = buttons[0]?.pressed || false;
              const panSpeed = isTurbo ? 0.35 : 0.16;
              this.sceneManager.dioramaRoot.position.x -= stickX * panSpeed;
              this.sceneManager.dioramaRoot.position.z -= stickY * panSpeed;
            }
          }
        }

        // --- Right Controller: ROTATE & ZOOM ---
        if (source.handedness === 'right' || source.handedness === 'none') {
          if (Math.abs(stickX) > 0.12) {
            this.sceneManager.dioramaRoot.rotation.y -= stickX * 0.035;
          }
          if (this.currentViewMode === 'diorama' && Math.abs(stickY) > 0.12) {
            const currentScale = this.sceneManager.dioramaRoot.scale.x;
            const factor = 1 - stickY * 0.035;
            const newScale = Math.max(0.000005, Math.min(0.05, currentScale * factor));
            this.sceneManager.dioramaRoot.scale.set(newScale, newScale, newScale);
          }
        }
      }

      // 2. Button State Tracking & Edge Detection
      const b0_trigger = buttons[0]?.pressed || false;
      const b1_grip = (buttons[1]?.pressed || (buttons[1]?.value && buttons[1].value > 0.35)) || false;
      const b3_stickClick = buttons[3]?.pressed || false;
      const b4_primary = buttons[4]?.pressed || false;
      const b5_secondary = buttons[5]?.pressed || false;

      // Controller Grip Interaction
      if (b1_grip) {
        if (!state.isGripping) {
          state.isGripping = true;
          state.prevGripWorldPos.copy(currentGripWorld);
          this.triggerHaptic(i, 0.7, 35);
        }

        const gripQuat = new THREE.Quaternion().setFromRotationMatrix(state.grip.matrixWorld);
        activeGrabs.push({
          id: `controller_${i}`,
          source: 'controller',
          worldPos: currentGripWorld.clone(),
          prevWorldPos: state.prevGripWorldPos.clone(),
          wristQuat: gripQuat,
          prevWristQuat: gripQuat,
        });

        state.prevGripWorldPos.copy(currentGripWorld);
      } else {
        if (state.isGripping) {
          state.isGripping = false;
          this.triggerHaptic(i, 0.3, 25);
        }
      }

      // Button Shortcuts
      if (b4_primary && !state.prevButtons[4]) {
        this.triggerHaptic(i, 0.7, 50);
        this.callbacks.onToggleViewMode?.();
      }

      if (b5_secondary && !state.prevButtons[5]) {
        this.triggerHaptic(i, 0.7, 50);
        this.callbacks.onTogglePlay?.();
      }

      if (b3_stickClick && !state.prevButtons[3]) {
        this.triggerHaptic(i, 0.6, 40);
        this.callbacks.onFocusHiker?.();
      }

      // Laser Pointer Raycasting (HUD & terrain drag)
      this.updatePointerRaycast(i, state, b0_trigger, false);

      state.prevButtons[0] = b0_trigger;
      state.prevButtons[1] = b1_grip;
      state.prevButtons[3] = b3_stickClick;
      state.prevButtons[4] = b4_primary;
      state.prevButtons[5] = b5_secondary;
      state.prevGripWorldPos.copy(currentGripWorld);
    }

    // 2. WebXR Bare Hand Tracking & Pinch Detection
    const handGrabs = this.processHandGrabs();
    activeGrabs.push(...handGrabs);

    // 3. Unified 6DOF Diorama Manipulation (for bare hands and controllers)
    this.applyManipulation(activeGrabs);
  }

  private updateHandTracking(): void {
    for (let i = 0; i < this.hands.length; i++) {
      const state = this.hands[i];
      const hand = state.hand;
      const joints = (hand as any).joints;
      if (!joints) {
        state.visualOutline.group.visible = false;
        state.pinchReticle.visible = false;
        state.isPinching = false;
        state.activeInteraction = 'none';
        continue;
      }

      // Check if wrist is tracked to know if hand is in view
      const wrist = joints['wrist'];
      if (!wrist || !wrist.visible) {
        state.visualOutline.group.visible = false;
        state.pinchReticle.visible = false;
        state.isPinching = false;
        state.activeInteraction = 'none';
        continue;
      }

      state.visualOutline.group.visible = true;

      // Update 25 joint positions (using preallocated vector map for zero heap allocation)
      for (const jointName of ALL_HAND_JOINTS) {
        const jointObj = joints[jointName];
        const pos = state.jointPosMap.get(jointName);
        if (jointObj && jointObj.visible && pos) {
          pos.setFromMatrixPosition(jointObj.matrixWorld);
        }
      }

      // Update 28 bone outline lines (smooth continuous holographic skeleton, no dots)
      const posArray = state.visualOutline.bonePositions.array as Float32Array;
      let vertIdx = 0;
      const wristFallback = state.jointPosMap.get('wrist') || _scratchV1.set(0, 0, 0);
      for (const [jA, jB] of BONE_CONNECTIONS) {
        const pA = state.jointPosMap.get(jA) || wristFallback;
        const pB = state.jointPosMap.get(jB) || wristFallback;
        posArray[vertIdx++] = pA.x;
        posArray[vertIdx++] = pA.y;
        posArray[vertIdx++] = pA.z;
        posArray[vertIdx++] = pB.x;
        posArray[vertIdx++] = pB.y;
        posArray[vertIdx++] = pB.z;
      }
      state.visualOutline.bonePositions.needsUpdate = true;

      const thumbTipPos = state.jointPosMap.get('thumb-tip');
      const indexTipPos = state.jointPosMap.get('index-finger-tip');
      const wristPos = state.jointPosMap.get('wrist');

      if (thumbTipPos && indexTipPos) {
        state.indexTipWorldPos.copy(indexTipPos);

        const pinchDist = thumbTipPos.distanceTo(indexTipPos);
        // Robust pinch thresholds: 3.2cm engage, 4.5cm release (prevents zoom from dropping out during 2-hand gestures)
        const isPinchingNow = state.isPinching
          ? pinchDist <= 0.045
          : pinchDist <= 0.032;

        _scratchV1.copy(thumbTipPos).add(indexTipPos).multiplyScalar(0.5);
        state.pinchWorldPos.copy(_scratchV1);

        if (wrist && wrist.visible && wristPos) {
          state.wristWorldPos.copy(wristPos);
          state.wristWorldQuat.setFromRotationMatrix(wrist.matrixWorld);
        }

        state.isPinching = isPinchingNow;
      } else {
        state.isPinching = false;
      }
    }
  }

  private processHandGrabs(): ActiveGrab[] {
    const activeGrabs: ActiveGrab[] = [];

    for (let i = 0; i < this.hands.length; i++) {
      const state = this.hands[i];
      if (!state.visualOutline.group.visible) {
        state.activeInteraction = 'none';
        state.pinchReticle.visible = false;
        continue;
      }

      const indexTipPos = state.jointPosMap.get('index-finger-tip');
      if (!indexTipPos) continue;

      // 1. Check direct fingertip touch / poke on Spatial HUD
      const isDirectTouchHUD = this.checkHandHUDInteraction(state, indexTipPos, state.isPinching);

      // 2. Check if this hand's laser pointer is hovering or interacting with the HUD
      const matchingCtrl = this.controllers.find(
        (c) => c.inputSource && state.inputSource && c.inputSource.handedness === state.inputSource.handedness
      ) || this.controllers[i];
      const isLaserHUD = !!matchingCtrl && (matchingCtrl.isHoveringHUD || matchingCtrl.isDraggingHUD || matchingCtrl.isInteractingWithHUD);

      const isEngagedWithHUD = isDirectTouchHUD || isLaserHUD;

      // Check whether hand is virtually touching the tabletop diorama
      const isTouchingDiorama = this.isHandTouchingDiorama(state.pinchWorldPos) || this.isHandTouchingDiorama(state.indexTipWorldPos);

      if (!state.isPinching) {
        state.activeInteraction = 'none';
      } else {
        if (state.activeInteraction === 'none') {
          // Gesture initiated this frame: claim ownership
          if (isEngagedWithHUD) {
            state.activeInteraction = 'hud';
          } else if (isTouchingDiorama) {
            // ONLY grab diorama if virtually touching it!
            state.activeInteraction = 'diorama';
            state.prevPinchWorldPos.copy(state.pinchWorldPos);
            state.prevWristWorldPos.copy(state.wristWorldPos);
            state.prevWristWorldQuat.copy(state.wristWorldQuat);
          }
          // If pinching in midair away from HUD and diorama, activeInteraction remains 'none'
        }

        // EXCLUSIVITY: If hand gesture belongs to HUD, do NOT grab or drag the diorama!
        if (state.activeInteraction === 'diorama') {
          activeGrabs.push({
            id: `hand_${i}`,
            source: 'hand',
            worldPos: state.pinchWorldPos.clone(),
            prevWorldPos: state.prevPinchWorldPos.clone(),
            wristQuat: state.wristWorldQuat.clone(),
            prevWristQuat: state.prevWristWorldQuat.clone(),
          });
        }

        state.prevPinchWorldPos.copy(state.pinchWorldPos);
        state.prevWristWorldPos.copy(state.wristWorldPos);
        state.prevWristWorldQuat.copy(state.wristWorldQuat);
      }

      // Dynamic Hand Outline & Reticle Visual Feedback
      this.updateHandVisuals(state, isEngagedWithHUD, isTouchingDiorama);
    }

    return activeGrabs;
  }

  private updateHandVisuals(
    state: HandState,
    isEngagedWithHUD: boolean,
    isTouchingDiorama: boolean
  ): void {
    const boneMat = state.visualOutline.boneLines.material as THREE.LineBasicMaterial;
    const reticleMat = state.pinchReticle.material as THREE.MeshBasicMaterial;

    if (state.activeInteraction === 'diorama') {
      // 1. ACTIVE DIORAMA GRAB: Radiant Amber Gold
      boneMat.color.setHex(0xffb703);
      boneMat.opacity = 1.0;
      reticleMat.color.setHex(0xffb703);
      reticleMat.opacity = 1.0;

      state.pinchReticle.position.copy(state.pinchWorldPos);
      state.pinchReticle.visible = true;
      const pulse = 1.15 + 0.25 * Math.sin(performance.now() * 0.015);
      state.pinchReticle.scale.set(pulse, pulse, pulse);
    } else if (isEngagedWithHUD) {
      // 2. ENGAGED WITH HUD: Soft Violet / Indigo
      boneMat.color.setHex(0x818cf8);
      boneMat.opacity = 0.85;
      state.pinchReticle.visible = false;
    } else if (isTouchingDiorama) {
      // 3. TOUCHING DIORAMA (Hovering / Ready to grab): Vibrant Glowing Electric Cyan
      boneMat.color.setHex(0x00f0ff);
      boneMat.opacity = 0.95;
      reticleMat.color.setHex(0x00f0ff);
      reticleMat.opacity = 0.85;

      state.pinchReticle.position.copy(state.pinchWorldPos);
      state.pinchReticle.visible = true;
      const hoverScale = 0.8 + 0.15 * Math.sin(performance.now() * 0.008);
      state.pinchReticle.scale.set(hoverScale, hoverScale, hoverScale);
    } else {
      // 4. FAR ENOUGH AWAY NOT TO GRAB: Faint Translucent Slate
      // User clearly sees they are far enough away and will not manipulate the map
      boneMat.color.setHex(0x64748b);
      boneMat.opacity = 0.30;
      state.pinchReticle.visible = false;
    }
  }

  private checkHandHUDInteraction(state: HandState, fingerPos: THREE.Vector3, isPinching: boolean): boolean {
    if (!this.spatialHUD) return false;

    // Convert world position of fingertip to local space of Spatial HUD
    const hudGroup = this.spatialHUD.group;
    const local = _scratchV1.copy(fingerPos);
    hudGroup.worldToLocal(local);

    // 1. Check if user is grabbing the HUD top grab bar / handle
    const isNearGrabHandle = local.y >= 0.18 && local.y <= 0.38 && Math.abs(local.x) <= 0.38 && Math.abs(local.z) < 0.08;
    if (isNearGrabHandle && isPinching) {
      const camPos = this.sceneManager.camera.position;
      this.spatialHUD.group.position.copy(fingerPos).add(_scratchV2.set(0, -0.26, 0.05));
      this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);
      return true; // Exclude from diorama grab
    }

    // Spatial HUD mesh is PlaneGeometry(0.8, 0.53) centered at origin
    const halfW = 0.40;
    const halfH = 0.265;

    // Check if fingertip is within 5.5cm of HUD surface and within the card boundaries
    if (Math.abs(local.z) < 0.055 && Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfH) {
      // Normalized UV on HUD canvas: u in [0, 1] from left to right, v in [0, 1] from bottom to top
      const u = (local.x + halfW) / (2 * halfW);
      const v = (local.y + halfH) / (2 * halfH);
      const uv = _scratchV2D1.set(u, v);

      this.spatialHUD.onPointerHover(uv);

      // Click when pinching or when finger pokes deeply into surface (< 1.5cm)
      const isPoke = local.z < 0.015 && local.z > -0.025;
      if ((isPinching || isPoke) && !state.isClickingHUD) {
        state.isClickingHUD = true;
        this.spatialHUD.onPointerClick(uv);
      } else if (!isPinching && !isPoke) {
        state.isClickingHUD = false;
      }
      return true; // Hand is engaged with HUD
    }
    return false;
  }

  private applyManipulation(grabs: ActiveGrab[]): void {
    if (this.currentViewMode !== 'diorama') return;

    if (grabs.length >= 2) {
      // --- TWO-HANDED 6DOF MANIPULATION (MOVE + ROTATE YAW/PITCH + SCALE) ---
      const g0 = grabs[0];
      const g1 = grabs[1];

      const p0 = g0.worldPos;
      const p1 = g1.worldPos;
      const p0Prev = g0.prevWorldPos;
      const p1Prev = g1.prevWorldPos;

      const currentDist = p0.distanceTo(p1);
      const prevDist = p0Prev.distanceTo(p1Prev);

      const currentMid = _scratchV1.copy(p0).add(p1).multiplyScalar(0.5);
      const prevMid = _scratchV2.copy(p0Prev).add(p1Prev).multiplyScalar(0.5);

      // 1. Scale factor (stretch hands apart to expand/zoom in, squeeze hands together to shrink/zoom out)
      let scaleFactor = 1.0;
      if (prevDist > 0.03 && currentDist > 0.03) {
        const rawFactor = currentDist / prevDist;
        // Limit frame-to-frame delta to avoid sudden tracking spikes
        scaleFactor = Math.max(0.65, Math.min(1.5, rawFactor));
      }

      // 2. Horizontal (Yaw) & Vertical (Pitch) Rotation delta
      const vPrev = _scratchV3.copy(p1Prev).sub(p0Prev);
      const vCurr = p1.clone().sub(p0);
      const anglePrev = Math.atan2(vPrev.x, vPrev.z);
      const angleCurr = Math.atan2(vCurr.x, vCurr.z);
      let deltaAngle = angleCurr - anglePrev;
      while (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
      while (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;

      // 3D Pitch: vertical inclination change between hands relative to depth
      const deltaY = (p1.y - p1Prev.y) - (p0.y - p0Prev.y);
      const sepZ = p1.z - p0.z;
      let deltaPitch = 0;
      if (Math.abs(sepZ) > 0.06) {
        deltaPitch = -(deltaY / Math.abs(sepZ)) * Math.sign(sepZ) * 0.85;
      }

      // 3. Apply anchored 6DOF transform around hands' midpoint
      const diorama = this.sceneManager.dioramaRoot;
      const currentScale = diorama.scale.x;
      const targetScale = Math.max(0.000005, Math.min(0.05, currentScale * scaleFactor));
      const effectiveScale = targetScale / currentScale;

      // Offset from previous midpoint to diorama position
      const offset = diorama.position.clone().sub(prevMid);
      offset.multiplyScalar(effectiveScale);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), deltaAngle);

      // Update position, rotation, scale
      diorama.position.copy(currentMid).add(offset);
      diorama.rotation.y += deltaAngle;
      if (Math.abs(deltaPitch) > 0.003) {
        diorama.rotation.x = Math.max(-1.3, Math.min(1.3, diorama.rotation.x + deltaPitch));
      }
      diorama.scale.set(targetScale, targetScale, targetScale);

    } else if (grabs.length === 1) {
      // --- ONE-HANDED MANIPULATION (1:1 3D TRANSLATE + YAW & PITCH ROTATION) ---
      const g = grabs[0];
      const deltaMove = g.worldPos.clone().sub(g.prevWorldPos);

      // 1. 1:1 Translation in 3D
      this.sceneManager.dioramaRoot.position.add(deltaMove);

      // 2. Hand / Wrist twist yaw & pitch rotation
      if (g.wristQuat && g.prevWristQuat) {
        const fPrev = _scratchV1.set(0, 0, -1).applyQuaternion(g.prevWristQuat);
        const fCurr = _scratchV2.set(0, 0, -1).applyQuaternion(g.wristQuat);
        const yawPrev = Math.atan2(fPrev.x, fPrev.z);
        const yawCurr = Math.atan2(fCurr.x, fCurr.z);
        let deltaYaw = yawCurr - yawPrev;
        while (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
        while (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;

        if (Math.abs(deltaYaw) > 0.005 && Math.abs(deltaYaw) < 0.4) {
          this.sceneManager.dioramaRoot.rotation.y += deltaYaw * 0.95;
        }

        // Wrist pitch tilt (allows looking down into canyons)
        const pitchPrev = Math.asin(Math.max(-1, Math.min(1, fPrev.y)));
        const pitchCurr = Math.asin(Math.max(-1, Math.min(1, fCurr.y)));
        const deltaPitch = pitchCurr - pitchPrev;
        if (Math.abs(deltaPitch) > 0.005 && Math.abs(deltaPitch) < 0.4) {
          const diorama = this.sceneManager.dioramaRoot;
          diorama.rotation.x = Math.max(-1.3, Math.min(1.3, diorama.rotation.x + deltaPitch * 0.9));
        }
      }

      // 3. Orbit around center when dragging in an arc
      const center = this.sceneManager.dioramaRoot.position;
      const uPrev = _scratchV2D1.set(g.prevWorldPos.x - center.x, g.prevWorldPos.z - center.z);
      const uCurr = _scratchV2D2.set(g.worldPos.x - center.x, g.worldPos.z - center.z);
      if (uCurr.length() > 0.12 && uPrev.length() > 0.12) {
        let arcDelta = Math.atan2(uCurr.x, uCurr.y) - Math.atan2(uPrev.x, uPrev.y);
        while (arcDelta > Math.PI) arcDelta -= 2 * Math.PI;
        while (arcDelta < -Math.PI) arcDelta += 2 * Math.PI;
        if (Math.abs(arcDelta) > 0.008 && Math.abs(arcDelta) < 0.3) {
          this.sceneManager.dioramaRoot.rotation.y += arcDelta * 0.6;
        }
      }
    }
  }

  private updatePointerRaycast(
    controllerIdx: number,
    state: ControllerState,
    isTriggerDown: boolean,
    isHand: boolean = false
  ): void {
    // If hand is actively manipulating the diorama, hide HUD pointer ray to avoid HUD clicks or clutter
    if (isHand) {
      const matchingHand = this.hands.find(
        (h) => h.inputSource && state.inputSource && h.inputSource.handedness === state.inputSource.handedness
      ) || this.hands[controllerIdx];
      if (matchingHand && matchingHand.activeInteraction === 'diorama') {
        state.rayLine.visible = false;
        state.reticle.visible = false;
        state.isHoveringHUD = false;
        state.isInteractingWithHUD = false;
        return;
      }
    }

    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(state.controller.matrixWorld);

    const rayOrigin = new THREE.Vector3().setFromMatrixPosition(state.controller.matrixWorld);
    const rayDir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();

    // 1. If currently dragging the HUD in 3D room space (supports both hands and physical controllers)
    if (state.isDraggingHUD && this.spatialHUD) {
      if (isTriggerDown) {
        const targetPos = rayOrigin.clone().addScaledVector(rayDir, state.hudDragDistance);
        this.spatialHUD.group.position.copy(targetPos);
        const camPos = this.sceneManager.camera.position;
        this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);
        this.spatialHUD.group.updateMatrixWorld(true);

        state.rayLine.geometry.setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -state.hudDragDistance),
        ]);
        state.rayLine.visible = true;
        state.reticle.visible = true;
        state.reticle.position.copy(this.spatialHUD.grabMesh.position).applyMatrix4(this.spatialHUD.group.matrixWorld);
        state.isHoveringHUD = true;
        state.isInteractingWithHUD = true;
        return;
      } else {
        state.isDraggingHUD = false;
        state.isInteractingWithHUD = false;
        this.triggerHaptic(controllerIdx, 0.4, 25);
      }
    }

    // 2. If currently dragging the terrain diorama (physical controllers only)
    if (!isHand && state.isDraggingTerrain && this.currentViewMode === 'diorama') {
      if (isTriggerDown) {
        const planeY = this.sceneManager.dioramaRoot.position.y;
        let newHit: THREE.Vector3 | null = null;
        if (rayDir.y < -0.01) {
          const t = (planeY - rayOrigin.y) / rayDir.y;
          if (t > 0 && t < 15) {
            newHit = rayOrigin.clone().addScaledVector(rayDir, t);
          }
        }

        if (newHit) {
          const deltaX = newHit.x - state.terrainDragStartHit.x;
          const deltaZ = newHit.z - state.terrainDragStartHit.z;
          this.sceneManager.dioramaRoot.position.x = state.terrainDragStartDioramaPos.x + deltaX;
          this.sceneManager.dioramaRoot.position.z = state.terrainDragStartDioramaPos.z + deltaZ;

          const dist = rayOrigin.distanceTo(newHit);
          state.rayLine.geometry.setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, -dist),
          ]);
          state.rayLine.visible = true;
          state.reticle.visible = true;
          state.reticle.position.copy(newHit);
        }
        return;
      } else {
        state.isDraggingTerrain = false;
        this.triggerHaptic(controllerIdx, 0.3, 20);
      }
    }

    // 3. Normal Raycasting against HUD
    this.raycaster.set(rayOrigin, rayDir);
    let hudHit: THREE.Intersection | null = null;
    let isHitGrabMesh = false;

    if (this.spatialHUD) {
      const grabIntersects = this.raycaster.intersectObject(this.spatialHUD.grabMesh, false);
      if (grabIntersects.length > 0) {
        hudHit = grabIntersects[0];
        isHitGrabMesh = true;
      } else {
        const meshIntersects = this.raycaster.intersectObject(this.spatialHUD.mesh, false);
        if (meshIntersects.length > 0) {
          hudHit = meshIntersects[0];
        }
      }
    }

    if (hudHit) {
      state.isHoveringHUD = true;
      state.isInteractingWithHUD = isTriggerDown;

      const hitDistance = hudHit.distance;
      state.rayLine.geometry.setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -hitDistance),
      ]);
      state.rayLine.visible = true;
      state.reticle.visible = true;
      state.reticle.position.copy(hudHit.point);
      if (hudHit.face) {
        state.reticle.lookAt(hudHit.point.clone().add(hudHit.face.normal));
      }

      // Check if hitting HUD drag handle: grab cylinder or top drag handle bar on card
      const isDragTarget = isHitGrabMesh || (hudHit.uv && (this.spatialHUD!.isHoveringDragHandle() || (hudHit.uv.y > 0.92 && hudHit.uv.x >= 0.25 && hudHit.uv.x <= 0.75)));
      if (isDragTarget) {
        if (isTriggerDown && !state.prevButtons[0]) {
          state.isDraggingHUD = true;
          state.hudDragDistance = hitDistance;
          this.triggerHaptic(controllerIdx, 0.8, 40);
          return;
        }
      }

      if (hudHit.uv) {
        this.spatialHUD!.onPointerHover(hudHit.uv);

        if (isTriggerDown && !state.prevButtons[0]) {
          if (this.spatialHUD!.isHoveringDragHandle() || isDragTarget) {
            state.isDraggingHUD = true;
            state.hudDragDistance = hitDistance;
            this.triggerHaptic(controllerIdx, 0.8, 40);
            return;
          }
          const handled = this.spatialHUD!.onPointerClick(hudHit.uv);
          if (handled) {
            this.triggerHaptic(controllerIdx, 0.9, 60);
          }
        } else if (isTriggerDown) {
          this.spatialHUD!.onPointerDrag(hudHit.uv);
        } else if (state.prevButtons[0] && !isTriggerDown) {
          this.spatialHUD!.onPointerRelease();
        }
      }
      return;
    }

    // Ray missed HUD
    state.isHoveringHUD = false;
    if (!isTriggerDown) {
      state.isInteractingWithHUD = false;
    }
    if (state.prevButtons[0] && !isTriggerDown && this.spatialHUD) {
      this.spatialHUD.onPointerRelease();
    }

    // In hand mode when NOT pointing at the HUD:
    // Hide ray line and reticle so they don't clutter the mountain diorama view!
    if (isHand) {
      state.rayLine.visible = false;
      state.reticle.visible = false;
      return;
    }

    // 4. Physical Controller: Raycast against Tabletop / Terrain Plane in diorama mode
    if (this.currentViewMode === 'diorama') {
      const planeY = this.sceneManager.dioramaRoot.position.y;
      let tableHit: THREE.Vector3 | null = null;
      if (rayDir.y < -0.01) {
        const t = (planeY - rayOrigin.y) / rayDir.y;
        if (t > 0 && t < 12) {
          tableHit = rayOrigin.clone().addScaledVector(rayDir, t);
        }
      }

      if (tableHit) {
        const dist = rayOrigin.distanceTo(tableHit);
        state.rayLine.geometry.setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -dist),
        ]);
        state.rayLine.visible = true;
        state.reticle.visible = true;
        state.reticle.position.copy(tableHit);
        state.reticle.lookAt(tableHit.clone().add(new THREE.Vector3(0, 1, 0)));

        if (isTriggerDown && !state.prevButtons[0]) {
          state.isDraggingTerrain = true;
          state.terrainDragStartHit.copy(tableHit);
          state.terrainDragStartDioramaPos.copy(this.sceneManager.dioramaRoot.position);
          this.triggerHaptic(controllerIdx, 0.7, 35);
        }
        return;
      }
    }

    // 5. Physical Controller: Default empty space ray
    state.rayLine.geometry.setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -2.5),
    ]);
    state.rayLine.visible = true;
    state.reticle.visible = false;

    if (state.prevButtons[0] && !isTriggerDown && this.spatialHUD) {
      this.spatialHUD.onPointerRelease();
    }
  }

  public triggerHaptic(controllerIndex: number, intensity: number, durationMs: number): void {
    const state = this.controllers[controllerIndex];
    const source = state?.inputSource;
    if (
      source &&
      source.gamepad &&
      source.gamepad.hapticActuators &&
      source.gamepad.hapticActuators.length > 0
    ) {
      source.gamepad.hapticActuators[0].pulse(intensity, durationMs);
    }
  }
}
