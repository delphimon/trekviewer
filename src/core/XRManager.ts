import * as THREE from 'three';
import { SceneManager } from './SceneManager.ts';
import { SpatialHUD } from '../ui/SpatialHUD.ts';
import type { GeoBounds, ViewMode } from '../gpx/TrackTypes.ts';
import {
  ALL_HAND_JOINTS,
  BONE_CONNECTIONS,
  evaluatePinchState,
  applyBimanualTransform,
  applyOneHandedManipulation,
  clampDeltaSeconds,
  computeThumbstickWalkDelta,
  computeThumbstickPan,
  computeThumbstickRotation,
  computeThumbstickZoomFactor,
} from '../xr/GestureMath.ts';

export { ALL_HAND_JOINTS, BONE_CONNECTIONS };

export interface XRInteractionCallbacks {
  onToggleViewMode?: () => void;
  onTogglePlay?: () => void;
  onReset?: () => void;
  onExitMR?: () => void;
  onFocusHiker?: () => void;
  onScrub?: (fraction: number) => void;
  onScrubDistance?: (metersDelta: number) => void;
  onSelectWaypoint?: (name: string, lat?: number, lon?: number) => void;
}

export interface ActiveGrab {
  id: string;
  source: 'hand' | 'controller';
  worldPos: THREE.Vector3;
  prevWorldPos: THREE.Vector3;
  wristQuat?: THREE.Quaternion;
  prevWristQuat?: THREE.Quaternion;
}

export interface HandVisualOutline {
  group: THREE.Group;
  jointMeshes: Map<string, THREE.Mesh>;
  boneLines: THREE.LineSegments;
  bonePositions: THREE.BufferAttribute;
  boneMesh: THREE.InstancedMesh;
  jointMesh: THREE.InstancedMesh;
}

const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();
const _scratchV3 = new THREE.Vector3();
const _scratchM1 = new THREE.Matrix4();
const _scratchV2D1 = new THREE.Vector2();
const _scratchV2D2 = new THREE.Vector2();
const _scratchQuat = new THREE.Quaternion();
const _scratchQuatIdentity = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3();

// Hot-path scratch objects to eliminate per-frame allocations at 72/90/120 Hz
const _scratchRayMatrix = new THREE.Matrix4();
const _scratchRayOrigin = new THREE.Vector3();
const _scratchRayDir = new THREE.Vector3();
const _scratchGripPos = new THREE.Vector3();
const _scratchGripQuat = new THREE.Quaternion();
const _scratchPlaneNormal = new THREE.Vector3();

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
  prevGripWorldQuat: THREE.Quaternion;
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
  private currentViewMode: ViewMode = 'diorama';
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

  public setViewMode(mode: ViewMode): void {
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
  private dioramaMaxPeakLocal: number = 800;
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
    this.dioramaMaxPeakLocal = Math.max((bounds.maxEle ?? bounds.minEle + 500) - baseElevation, 500);
  }

  public setVerticalExaggeration(factor: number): void {
    this.dioramaVerticalExaggeration = factor;
  }

  public resetInteractionState(): void {
    for (const hand of this.hands) {
      hand.activeInteraction = 'none';
      hand.isPinching = false;
      hand.isClickingHUD = false;
      hand.pinchReticle.visible = false;
      hand.visualOutline.group.visible = false;
    }
    for (const ctrl of this.controllers) {
      ctrl.isGripping = false;
      ctrl.isDraggingHUD = false;
      ctrl.isDraggingTerrain = false;
      ctrl.isHoveringHUD = false;
      ctrl.isInteractingWithHUD = false;
      ctrl.rayLine.visible = false;
      ctrl.reticle.visible = false;
    }
  }


  public getDioramaProximity(handWorldPos: THREE.Vector3): { isTouching: boolean; proximityFactor: number } {
    if (this.currentViewMode !== 'diorama') return { isTouching: false, proximityFactor: 0 };
    const dioramaRoot = this.sceneManager.dioramaRoot;
    if (!dioramaRoot.visible) return { isTouching: false, proximityFactor: 0 };

    const dioramaScale = dioramaRoot.scale.x;
    if (dioramaScale <= 0) return { isTouching: false, proximityFactor: 0 };

    // Transform hand world position to local diorama coordinates
    const local = _scratchV1.copy(handWorldPos);
    dioramaRoot.worldToLocal(local);

    const halfW = this.dioramaWidthMeters * 0.5;
    const halfD = this.dioramaDepthMeters * 0.5;

    // 1. Horizontal distance outside diorama perimeter in world meters
    const dxLocal = Math.max(0, Math.abs(local.x) - halfW);
    const dzLocal = Math.max(0, Math.abs(local.z) - halfD);
    const distHorizWorld = Math.hypot(dxLocal, dzLocal) * dioramaScale;

    // 2. Vertical elevation limits of the diorama volume
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

    // Top limit of the mountain diorama volume (considers both local terrain surface and summit ridge height)
    const topLimitLocal = Math.max(localSurfaceY, this.dioramaMaxPeakLocal * this.dioramaVerticalExaggeration);

    let dyOutsideWorld = 0;
    if (local.y > topLimitLocal) {
      dyOutsideWorld = (local.y - topLimitLocal) * dioramaScale;
    } else if (local.y < this.dioramaPlinthBottomY) {
      dyOutsideWorld = (this.dioramaPlinthBottomY - local.y) * dioramaScale;
    }

    // Combined 3D distance outside the diorama reach envelope
    const distWorld = Math.hypot(distHorizWorld, dyOutsideWorld);

    // Generous and intuitive touch range: 18cm (approx 7 inches) around diorama model and pedestal
    const isTouching = distWorld <= 0.18;

    // Proximity factor: 0 when > 35cm away, ramping up to 1.0 at touching range
    const proximityFactor = Math.max(0, Math.min(1.0, 1.0 - (distWorld - 0.18) / 0.17));

    return { isTouching, proximityFactor };
  }

  public isHandTouchingDiorama(handWorldPos: THREE.Vector3): boolean {
    return this.getDioramaProximity(handWorldPos).isTouching;
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
        prevGripWorldQuat: new THREE.Quaternion(),
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

      // Dedicated Glowing Hand Outline Skeleton (All 25 joints + 28 3D volumetric bone tubes)
      const visualOutlineGroup = new THREE.Group();
      visualOutlineGroup.name = `HandVisualOutline_${i}`;
      visualOutlineGroup.visible = false;
      this.sceneManager.scene.add(visualOutlineGroup);

      // 1. Joint Tracking Map
      const jointMeshes = new Map<string, THREE.Mesh>();
      const jointPosMap = new Map<string, THREE.Vector3>();
      for (const jointName of ALL_HAND_JOINTS) {
        jointPosMap.set(jointName, new THREE.Vector3());
      }

      // 2. 3D Volumetric Bone Tubes (28 instanced cylinders with physical 5.6mm thickness)
      const cylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
      const boneMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      });
      const boneMesh = new THREE.InstancedMesh(cylinderGeo, boneMat, BONE_CONNECTIONS.length);
      boneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      boneMesh.frustumCulled = false;
      boneMesh.renderOrder = 998;
      visualOutlineGroup.add(boneMesh);

      // 3. 3D Joint Spheres (25 instanced spheres: wrist, knuckles, fingertips)
      const sphereGeo = new THREE.SphereGeometry(1, 10, 10);
      const jointMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.90,
        depthTest: false,
      });
      const jointMesh = new THREE.InstancedMesh(sphereGeo, jointMat, ALL_HAND_JOINTS.length);
      jointMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      jointMesh.frustumCulled = false;
      jointMesh.renderOrder = 999;
      visualOutlineGroup.add(jointMesh);

      // 4. Crisp Laser Edge Lines (28 segments)
      const bonePositions = new Float32Array(BONE_CONNECTIONS.length * 2 * 3);
      const boneGeo = new THREE.BufferGeometry();
      boneGeo.setAttribute('position', new THREE.BufferAttribute(bonePositions, 3));
      const boneLineMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.90,
        depthTest: false,
      });
      const boneLines = new THREE.LineSegments(boneGeo, boneLineMat);
      boneLines.renderOrder = 998;
      visualOutlineGroup.add(boneLines);

      // Tactile pinch visual reticle (radiant 3D diamond indicator at pinch/fingertip contact point)
      const pinchGeo = new THREE.OctahedronGeometry(0.016, 0);
      const pinchMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.80,
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
          boneMesh,
          jointMesh,
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

  public update(deltaSeconds: number = 1 / 72): void {
    if (this.isDisposed) return;
    const session = this.renderer.xr.getSession();
    if (!session) return;

    const dt = clampDeltaSeconds(deltaSeconds);

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
      _scratchGripPos.setFromMatrixPosition(state.grip.matrixWorld);

      // 1. Thumbstick Navigation (Frame-rate independent rates per second)
      if (axes.length >= 4) {
        const stickX = axes[2];
        const stickY = axes[3];

        // --- Left Controller: TRAIL HIKE & SCRUB IN 1:1 / PAN IN DIORAMA ---
        if (source.handedness === 'left') {
          if (this.currentViewMode === 'first-person') {
            const isTurbo = buttons[0]?.pressed || false;
            const metersDelta = computeThumbstickWalkDelta(stickY, isTurbo, dt);
            if (metersDelta !== 0) {
              this.callbacks.onScrubDistance?.(metersDelta);

              this.hapticDistanceAccumulator += Math.abs(metersDelta);
              if (this.hapticDistanceAccumulator >= 35) {
                this.hapticDistanceAccumulator = 0;
                this.triggerHaptic(i, 0.4, 15);
              }
            }
          } else {
            const isTurbo = buttons[0]?.pressed || false;
            const pan = computeThumbstickPan(stickX, stickY, isTurbo, dt);
            if (pan.dx !== 0 || pan.dz !== 0) {
              this.sceneManager.dioramaRoot.position.x -= pan.dx;
              this.sceneManager.dioramaRoot.position.z -= pan.dz;
            }
          }
        }

        // --- Right Controller: ROTATE & ZOOM ---
        if (source.handedness === 'right' || source.handedness === 'none') {
          const rotY = computeThumbstickRotation(stickX, dt);
          if (rotY !== 0) {
            this.sceneManager.dioramaRoot.rotation.y -= rotY;
          }
          if (this.currentViewMode === 'diorama') {
            const zoomFactor = computeThumbstickZoomFactor(stickY, dt);
            if (zoomFactor !== 1.0) {
              const currentScale = this.sceneManager.dioramaRoot.scale.x;
              const newScale = Math.max(0.000005, Math.min(0.05, currentScale * zoomFactor));
              this.sceneManager.dioramaRoot.scale.set(newScale, newScale, newScale);
            }
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
        _scratchGripQuat.setFromRotationMatrix(state.grip.matrixWorld);
        if (!state.isGripping) {
          state.isGripping = true;
          state.prevGripWorldPos.copy(_scratchGripPos);
          state.prevGripWorldQuat.copy(_scratchGripQuat);
          this.triggerHaptic(i, 0.7, 35);
        }

        activeGrabs.push({
          id: `controller_${i}`,
          source: 'controller',
          worldPos: _scratchGripPos.clone(),
          prevWorldPos: state.prevGripWorldPos.clone(),
          wristQuat: _scratchGripQuat.clone(),
          prevWristQuat: state.prevGripWorldQuat.clone(),
        });

        state.prevGripWorldPos.copy(_scratchGripPos);
        state.prevGripWorldQuat.copy(_scratchGripQuat);
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
      state.prevGripWorldPos.copy(_scratchGripPos);
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

      // Check if at least one joint is visible/tracked
      let hasTrackedJoint = false;
      for (const jointName of ALL_HAND_JOINTS) {
        const jointObj = joints[jointName];
        if (jointObj && jointObj.visible) {
          hasTrackedJoint = true;
          break;
        }
      }

      if (!hasTrackedJoint) {
        state.visualOutline.group.visible = false;
        state.pinchReticle.visible = false;
        state.isPinching = false;
        state.activeInteraction = 'none';
        continue;
      }

      hand.visible = true;
      state.visualOutline.group.visible = true;

      // Update 25 joint positions (copying position directly decomposed from XRJointPose)
      for (const jointName of ALL_HAND_JOINTS) {
        const jointObj = joints[jointName];
        const pos = state.jointPosMap.get(jointName);
        if (jointObj && jointObj.visible && pos) {
          pos.copy(jointObj.position);
        }
      }

      // Update 25 joint sphere instances
      for (let jIdx = 0; jIdx < ALL_HAND_JOINTS.length; jIdx++) {
        const jName = ALL_HAND_JOINTS[jIdx];
        const pos = state.jointPosMap.get(jName);
        const jointObj = joints[jName];

        if (pos && jointObj?.visible) {
          const isTip = jName.endsWith('-tip');
          const isWrist = jName === 'wrist';
          const isKnuckle = jName.endsWith('-metacarpal');
          const r = isWrist ? 0.007 : isTip ? 0.006 : isKnuckle ? 0.005 : 0.004;
          _scratchV1.set(r, r, r);
          _scratchM1.compose(pos, _scratchQuatIdentity, _scratchV1);
          state.visualOutline.jointMesh.setMatrixAt(jIdx, _scratchM1);
        } else {
          _scratchM1.makeScale(0, 0, 0);
          state.visualOutline.jointMesh.setMatrixAt(jIdx, _scratchM1);
        }
      }
      state.visualOutline.jointMesh.instanceMatrix.needsUpdate = true;

      // Update 28 volumetric bone cylinder tubes
      const _yAxis = _scratchV2.set(0, 1, 0);
      for (let bIdx = 0; bIdx < BONE_CONNECTIONS.length; bIdx++) {
        const [jA, jB] = BONE_CONNECTIONS[bIdx];
        const pA = state.jointPosMap.get(jA);
        const pB = state.jointPosMap.get(jB);
        const jObjA = joints[jA];
        const jObjB = joints[jB];

        if (pA && pB && jObjA?.visible && jObjB?.visible) {
          const dist = pA.distanceTo(pB);
          if (dist > 0.002) {
            _scratchV1.addVectors(pA, pB).multiplyScalar(0.5);
            _scratchV3.subVectors(pB, pA).normalize();
            _scratchQuat.setFromUnitVectors(_yAxis, _scratchV3);
            const radius = 0.0028; // 2.8mm radius = 5.6mm thick glowing volumetric cylinder
            _scratchScale.set(radius, dist, radius);
            _scratchM1.compose(_scratchV1, _scratchQuat, _scratchScale);
            state.visualOutline.boneMesh.setMatrixAt(bIdx, _scratchM1);
          } else {
            _scratchM1.makeScale(0, 0, 0);
            state.visualOutline.boneMesh.setMatrixAt(bIdx, _scratchM1);
          }
        } else {
          _scratchM1.makeScale(0, 0, 0);
          state.visualOutline.boneMesh.setMatrixAt(bIdx, _scratchM1);
        }
      }
      state.visualOutline.boneMesh.instanceMatrix.needsUpdate = true;

      // Update 28 bone outline lines
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
      const wrist = joints['wrist'];
      const wristPos = state.jointPosMap.get('wrist');

      if (thumbTipPos && indexTipPos) {
        state.indexTipWorldPos.copy(indexTipPos);

        const pinchDist = thumbTipPos.distanceTo(indexTipPos);
        const isPinchingNow = evaluatePinchState(pinchDist, state.isPinching);

        _scratchV1.copy(thumbTipPos).add(indexTipPos).multiplyScalar(0.5);
        state.pinchWorldPos.copy(_scratchV1);

        if (wrist && wrist.visible && wristPos) {
          state.wristWorldPos.copy(wristPos);
          state.wristWorldQuat.copy(wrist.quaternion);
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
      const proximity = this.getDioramaProximity(state.pinchWorldPos);
      const indexProximity = this.getDioramaProximity(state.indexTipWorldPos);
      const isTouchingDiorama = proximity.isTouching || indexProximity.isTouching;
      const proximityFactor = Math.max(proximity.proximityFactor, indexProximity.proximityFactor);

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
      this.updateHandVisuals(state, isEngagedWithHUD, { isTouching: isTouchingDiorama, proximityFactor });
    }

    return activeGrabs;
  }

  private updateHandVisuals(
    state: HandState,
    isEngagedWithHUD: boolean,
    touchingInfo: { isTouching: boolean; proximityFactor: number }
  ): void {
    const boneMat = state.visualOutline.boneMesh.material as THREE.MeshBasicMaterial;
    const jointMat = state.visualOutline.jointMesh.material as THREE.MeshBasicMaterial;
    const lineMat = state.visualOutline.boneLines.material as THREE.LineBasicMaterial;
    const reticleMat = state.pinchReticle.material as THREE.MeshBasicMaterial;

    const { isTouching, proximityFactor } = touchingInfo;

    const applyColors = (hex: number, opacity: number, reticleHex: number, reticleOpacity: number) => {
      boneMat.color.setHex(hex);
      boneMat.opacity = opacity;
      jointMat.color.setHex(hex);
      jointMat.opacity = Math.min(1.0, opacity + 0.1);
      lineMat.color.setHex(hex);
      lineMat.opacity = opacity;
      reticleMat.color.setHex(reticleHex);
      reticleMat.opacity = reticleOpacity;
    };

    if (state.activeInteraction === 'diorama') {
      // 1. ACTIVE DIORAMA GRAB: Radiant Amber Gold
      applyColors(0xffb703, 1.0, 0xffb703, 1.0);
      state.pinchReticle.position.copy(state.pinchWorldPos);
      state.pinchReticle.visible = true;
      const pulse = 1.35 + 0.25 * Math.sin(performance.now() * 0.015);
      state.pinchReticle.scale.set(pulse, pulse, pulse);

    } else if (isEngagedWithHUD) {
      // 2. ENGAGED WITH HUD: Soft Violet / Indigo
      applyColors(0x818cf8, 0.90, 0x818cf8, 0.80);
      state.pinchReticle.visible = false;

    } else if (isTouching) {
      // 3. IN RANGE / TOUCHING DIORAMA: Vibrant Glowing Electric Cyan
      applyColors(0x00f0ff, 1.0, 0x00f0ff, 0.95);
      state.pinchReticle.position.copy(state.pinchWorldPos);
      state.pinchReticle.visible = true;
      const hoverPulse = 1.10 + 0.20 * Math.sin(performance.now() * 0.010);
      state.pinchReticle.scale.set(hoverPulse, hoverPulse, hoverPulse);

    } else if (proximityFactor > 0.05) {
      // 4. APPROACHING DIORAMA (Within 35cm reach zone): Dynamic proximity transition
      const r = Math.round(0x38 + (0x00 - 0x38) * proximityFactor);
      const g = Math.round(0xbd + (0xf0 - 0xbd) * proximityFactor);
      const b = Math.round(0xf8 + (0xff - 0xf8) * proximityFactor);
      const blendedColor = (r << 16) | (g << 8) | b;

      applyColors(blendedColor, 0.85 + 0.15 * proximityFactor, blendedColor, 0.70 + 0.25 * proximityFactor);
      state.pinchReticle.position.copy(state.pinchWorldPos);
      state.pinchReticle.visible = true;
      const approachScale = 0.6 + 0.4 * proximityFactor;
      state.pinchReticle.scale.set(approachScale, approachScale, approachScale);

    } else {
      // 5. AWAY FROM DIORAMA: Clean luminous sky-blue skeleton outline (clearly visible against room in passthrough)
      applyColors(0x38bdf8, 0.85, 0x38bdf8, 0.70);
      state.pinchReticle.position.copy(state.pinchWorldPos);
      state.pinchReticle.visible = true;
      state.pinchReticle.scale.set(0.6, 0.6, 0.6);
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
      const g0 = grabs[0];
      const g1 = grabs[1];
      applyBimanualTransform(
        this.sceneManager.dioramaRoot,
        g0.prevWorldPos,
        g1.prevWorldPos,
        g0.worldPos,
        g1.worldPos,
        g0.prevWristQuat,
        g0.wristQuat,
        g1.prevWristQuat,
        g1.wristQuat
      );
    } else if (grabs.length === 1) {
      const g = grabs[0];
      applyOneHandedManipulation(
        this.sceneManager.dioramaRoot,
        g.prevWorldPos,
        g.worldPos,
        g.prevWristQuat,
        g.wristQuat
      );
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

    _scratchRayMatrix.identity().extractRotation(state.controller.matrixWorld);

    _scratchRayOrigin.setFromMatrixPosition(state.controller.matrixWorld);
    _scratchRayDir.set(0, 0, -1).applyMatrix4(_scratchRayMatrix).normalize();

    // 1. If currently dragging the HUD in 3D room space (supports both hands and physical controllers)
    if (state.isDraggingHUD && this.spatialHUD) {
      if (isTriggerDown) {
        _scratchV1.copy(_scratchRayOrigin).addScaledVector(_scratchRayDir, state.hudDragDistance);
        this.spatialHUD.group.position.copy(_scratchV1);
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
        if (_scratchRayDir.y < -0.01) {
          const t = (planeY - _scratchRayOrigin.y) / _scratchRayDir.y;
          if (t > 0 && t < 15) {
            newHit = _scratchV1.copy(_scratchRayOrigin).addScaledVector(_scratchRayDir, t);
          }
        }

        if (newHit) {
          const deltaX = newHit.x - state.terrainDragStartHit.x;
          const deltaZ = newHit.z - state.terrainDragStartHit.z;
          this.sceneManager.dioramaRoot.position.x = state.terrainDragStartDioramaPos.x + deltaX;
          this.sceneManager.dioramaRoot.position.z = state.terrainDragStartDioramaPos.z + deltaZ;

          const dist = _scratchRayOrigin.distanceTo(newHit);
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
    this.raycaster.set(_scratchRayOrigin, _scratchRayDir);
    this.raycaster.camera = this.sceneManager.renderer.xr.isPresenting
      ? this.sceneManager.renderer.xr.getCamera()
      : this.sceneManager.camera;
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
        _scratchV1.copy(hudHit.point).add(hudHit.face.normal);
        state.reticle.lookAt(_scratchV1);
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

    // 4. Raycast against Waypoint Pins in diorama mode (Controllers & Hands pointing)
    if (this.currentViewMode === 'diorama') {
      try {
        const wpGroup = this.sceneManager.dioramaRoot.getObjectByName('Waypoints');
        if (wpGroup && wpGroup.children.length > 0) {
          // Raycast only meshes within wpGroup, strictly excluding sprites
          const pinMeshes: THREE.Mesh[] = [];
          wpGroup.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh && !(obj as any).isSprite) {
              pinMeshes.push(obj as THREE.Mesh);
            }
          });
          const wpHits = this.raycaster.intersectObjects(pinMeshes, false);
          if (wpHits.length > 0) {
            const hitWp = wpHits[0];
            let curr: THREE.Object3D | null = hitWp.object;
            while (curr && (!curr.userData || !curr.userData.waypoint)) {
              curr = curr.parent;
            }
            if (curr && curr.userData && curr.userData.waypoint) {
              const wp = curr.userData.waypoint;
              const dist = hitWp.distance;
              state.rayLine.geometry.setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -dist),
              ]);
              state.rayLine.visible = true;
              state.reticle.visible = true;
              state.reticle.position.copy(hitWp.point);

              if (isTriggerDown && !state.prevButtons[0]) {
                this.triggerHaptic(controllerIdx, 0.8, 50);
                this.callbacks.onSelectWaypoint?.(wp.name, wp.lat, wp.lon);
              }
              return;
            }
          }
        }
      } catch (err) {
        console.warn('[XRManager] Waypoint raycasting error:', err);
      }
    }

    // In hand mode when NOT pointing at the HUD or Waypoints:
    // Hide ray line and reticle so they don't clutter the mountain diorama view!
    if (isHand) {
      state.rayLine.visible = false;
      state.reticle.visible = false;
      return;
    }

    // 5. Physical Controller: Raycast against Tabletop / Terrain Plane in diorama mode
    if (this.currentViewMode === 'diorama') {
      const planeY = this.sceneManager.dioramaRoot.position.y;
      let tableHit: THREE.Vector3 | null = null;
      if (_scratchRayDir.y < -0.01) {
        const t = (planeY - _scratchRayOrigin.y) / _scratchRayDir.y;
        if (t > 0 && t < 12) {
          tableHit = _scratchV1.copy(_scratchRayOrigin).addScaledVector(_scratchRayDir, t);
        }
      }

      if (tableHit) {
        const dist = _scratchRayOrigin.distanceTo(tableHit);
        state.rayLine.geometry.setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -dist),
        ]);
        state.rayLine.visible = true;
        state.reticle.visible = true;
        state.reticle.position.copy(tableHit);
        _scratchV2.set(0, 1, 0).add(tableHit);
        state.reticle.lookAt(_scratchV2);

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

  private isDisposed: boolean = false;

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.resetInteractionState();

    // 1. Dispose physical/laser controllers
    for (const ctrl of this.controllers) {
      if (ctrl.controller.parent) {
        ctrl.controller.parent.remove(ctrl.controller);
      }
      if (ctrl.grip.parent) {
        ctrl.grip.parent.remove(ctrl.grip);
      }
      if (ctrl.rayLine.geometry) {
        ctrl.rayLine.geometry.dispose();
      }
      if (ctrl.rayLine.material instanceof THREE.Material) {
        ctrl.rayLine.material.dispose();
      }
      if (ctrl.reticle.parent) {
        ctrl.reticle.parent.remove(ctrl.reticle);
      }
      if (ctrl.reticle.geometry) {
        ctrl.reticle.geometry.dispose();
      }
      if (ctrl.reticle.material instanceof THREE.Material) {
        ctrl.reticle.material.dispose();
      }
    }
    this.controllers = [];

    // 2. Dispose bare hand tracking meshes and materials
    for (const hand of this.hands) {
      if (hand.hand.parent) {
        hand.hand.parent.remove(hand.hand);
      }
      if (hand.pinchReticle.parent) {
        hand.pinchReticle.parent.remove(hand.pinchReticle);
      }
      if (hand.pinchReticle.geometry) {
        hand.pinchReticle.geometry.dispose();
      }
      if (hand.pinchReticle.material instanceof THREE.Material) {
        hand.pinchReticle.material.dispose();
      }

      const vo = hand.visualOutline;
      if (vo.group.parent) {
        vo.group.parent.remove(vo.group);
      }
      if (vo.boneMesh.geometry) {
        vo.boneMesh.geometry.dispose();
      }
      if (vo.boneMesh.material instanceof THREE.Material) {
        vo.boneMesh.material.dispose();
      }
      if (vo.jointMesh.geometry) {
        vo.jointMesh.geometry.dispose();
      }
      if (vo.jointMesh.material instanceof THREE.Material) {
        vo.jointMesh.material.dispose();
      }
      if (vo.boneLines.geometry) {
        vo.boneLines.geometry.dispose();
      }
      if (vo.boneLines.material instanceof THREE.Material) {
        vo.boneLines.material.dispose();
      }
    }
    this.hands = [];

    this.callbacks = {};
    this.spatialHUD = null;
    this.dioramaElevationSampler = null;
  }
}
