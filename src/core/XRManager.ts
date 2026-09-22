import * as THREE from 'three';
import { SceneManager } from './SceneManager.ts';
import { SpatialHUD } from '../ui/SpatialHUD.ts';
import {
  evaluatePinchState,
  applyBimanualTransform,
  applyOneHandedManipulation,
  type DioramaTransform,
  MIN_DIORAMA_SCALE,
  MAX_DIORAMA_SCALE,
} from './GestureMath.ts';
import { disposeObject3D } from './ResourceLifecycle.ts';

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

  // Transverse palm arch
  ['thumb-metacarpal', 'index-finger-metacarpal'],
  ['index-finger-metacarpal', 'middle-finger-metacarpal'],
  ['middle-finger-metacarpal', 'ring-finger-metacarpal'],
  ['ring-finger-metacarpal', 'pinky-finger-metacarpal'],
];

export interface HandVisualOutline {
  group: THREE.Group;
  boneLines: THREE.LineSegments;
  bonePositions: THREE.BufferAttribute;
}

const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();
const _scratchV3 = new THREE.Vector3();
const _scratchV4 = new THREE.Vector3();
const _scratchV5 = new THREE.Vector3();
const _scratchV2D1 = new THREE.Vector2();
const _scratchQuat1 = new THREE.Quaternion();
const _scratchQuat2 = new THREE.Quaternion();
const _scratchMat1 = new THREE.Matrix4();

function updateRayLineLength(line: THREE.Line, length: number): void {
  const posAttr = line.geometry.attributes.position as THREE.BufferAttribute;
  if (!posAttr) return;
  posAttr.setXYZ(0, 0, 0, 0);
  posAttr.setXYZ(1, 0, 0, -length);
  posAttr.needsUpdate = true;
}

export interface HandState {
  hand: THREE.XRHandSpace;
  inputSource: any;
  pinchReticle: THREE.Mesh;
  visualOutline: HandVisualOutline;
  isPinching: boolean;
  isGrabbingDiorama: boolean;
  isClickingHUD: boolean;
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
  currentGripWorldPos: THREE.Vector3;
  prevGripWorldPos: THREE.Vector3;
  gripWorldQuat: THREE.Quaternion;
  isGripping: boolean;
  isDraggingHUD: boolean;
  hudDragDistance: number;
  isDraggingTerrain: boolean;
  terrainDragStartHit: THREE.Vector3;
  terrainDragStartDioramaPos: THREE.Vector3;
}

export class XRManager {
  private sceneManager: SceneManager;
  private renderer: THREE.WebGLRenderer;
  private controllers: ControllerState[] = [];
  private hands: HandState[] = [];
  private activeGrabs: ActiveGrab[] = [];
  private raycaster: THREE.Raycaster;
  private spatialHUD: SpatialHUD | null = null;
  private currentViewMode: 'diorama' | 'first-person' | 'flyover' = 'diorama';
  private hapticDistanceAccumulator: number = 0;
  private handIsPointingAtHUD: boolean[] = [false, false];

  private callbacks: XRInteractionCallbacks = {};

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.renderer = sceneManager.renderer;
    this.raycaster = new THREE.Raycaster();
    this.setupControllers();
    this.setupHands();

    this.renderer.xr.addEventListener('sessionend', () => {
      this.resetInteractionState();
    });
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

  private setupControllers(): void {
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      controller.name = `ControllerRay_${i}`;
      this.sceneManager.scene.add(controller);

      const rayGeo = new THREE.BufferGeometry();
      rayGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, -2.5]), 3)
      );
      const rayMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.65,
      });
      const rayLine = new THREE.Line(rayGeo, rayMat);
      rayLine.name = 'LaserRay';
      controller.add(rayLine);

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

      const grip = this.renderer.xr.getControllerGrip(i);
      grip.name = `ControllerGrip_${i}`;
      this.sceneManager.scene.add(grip);

      const state: ControllerState = {
        controller,
        grip,
        rayLine,
        reticle,
        inputSource: null,
        prevButtons: [false, false, false, false, false, false, false, false],
        currentGripWorldPos: new THREE.Vector3(),
        prevGripWorldPos: new THREE.Vector3(),
        gripWorldQuat: new THREE.Quaternion(),
        isGripping: false,
        isDraggingHUD: false,
        hudDragDistance: 1.0,
        isDraggingTerrain: false,
        terrainDragStartHit: new THREE.Vector3(),
        terrainDragStartDioramaPos: new THREE.Vector3(),
      };

      controller.addEventListener('connected', (event: any) => {
        state.inputSource = event.data;
      });

      controller.addEventListener('disconnected', () => {
        state.inputSource = null;
        state.isGripping = false;
        state.isDraggingHUD = false;
        state.isDraggingTerrain = false;
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

      const visualOutlineGroup = new THREE.Group();
      visualOutlineGroup.name = `HandVisualOutline_${i}`;
      visualOutlineGroup.visible = false;
      this.sceneManager.scene.add(visualOutlineGroup);

      const jointPosMap = new Map<string, THREE.Vector3>();
      for (const jointName of ALL_HAND_JOINTS) {
        jointPosMap.set(jointName, new THREE.Vector3());
      }

      const bonePositions = new Float32Array(BONE_CONNECTIONS.length * 2 * 3);
      const boneGeo = new THREE.BufferGeometry();
      boneGeo.setAttribute('position', new THREE.BufferAttribute(bonePositions, 3));
      const boneMat = new THREE.LineBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.90,
        depthTest: false,
      });
      const boneLines = new THREE.LineSegments(boneGeo, boneMat);
      boneLines.renderOrder = 998;
      visualOutlineGroup.add(boneLines);

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
          boneLines,
          bonePositions: boneGeo.getAttribute('position') as THREE.BufferAttribute,
        },
        isPinching: false,
        isGrabbingDiorama: false,
        isClickingHUD: false,
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
        state.pinchReticle.visible = false;
        state.visualOutline.group.visible = false;
      });

      this.hands.push(state);
    }
  }

  /**
   * Updates inputs with frame-rate independent time step.
   */
  public update(deltaSeconds: number = 0.016): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    // Clamp deltaSeconds to prevent tunneling or huge leaps on lag spikes
    const dt = Math.max(0.001, Math.min(0.1, deltaSeconds));
    this.activeGrabs.length = 0;

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
        state.grip.visible = false;
        const b0_pinchTrigger = source.gamepad?.buttons[0]?.pressed || false;
        this.updatePointerRaycast(i, state, b0_pinchTrigger, true);
        state.prevButtons[0] = b0_pinchTrigger;
        continue;
      }

      state.controller.visible = true;
      state.grip.visible = true;
      state.rayLine.visible = true;

      if (!source.gamepad) continue;

      const axes = source.gamepad.axes;
      const buttons = source.gamepad.buttons;

      state.currentGripWorldPos.setFromMatrixPosition(state.grip.matrixWorld);
      const currentGripWorld = state.currentGripWorldPos;

      // Frame-rate independent thumbstick navigation
      if (axes.length >= 4) {
        const stickX = axes[2];
        const stickY = axes[3];

        // --- Left Controller: Walk in 1:1 / Pan in diorama ---
        if (source.handedness === 'left') {
          if (this.currentViewMode === 'first-person') {
            if (Math.abs(stickY) > 0.1) {
              const isTurbo = buttons[0]?.pressed || false;
              const baseSpeedMps = isTurbo ? 75.0 : 18.0;
              // Time-based: meters = stick * speed * dt
              const metersDelta = -stickY * baseSpeedMps * dt;
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
              const panSpeed = isTurbo ? 21.0 : 10.0;
              this.sceneManager.dioramaRoot.position.x -= stickX * panSpeed * dt;
              this.sceneManager.dioramaRoot.position.z -= stickY * panSpeed * dt;
            }
          }
        }

        // --- Right Controller: Rotate & Zoom ---
        if (source.handedness === 'right' || source.handedness === 'none') {
          if (Math.abs(stickX) > 0.12) {
            const rotSpeed = 2.1; // rad/s
            this.sceneManager.dioramaRoot.rotation.y -= stickX * rotSpeed * dt;
          }
          if (this.currentViewMode === 'diorama' && Math.abs(stickY) > 0.12) {
            const currentScale = this.sceneManager.dioramaRoot.scale.x;
            // Exponential time-based zoom
            const zoomRate = Math.pow(0.25, stickY * dt);
            const newScale = Math.max(MIN_DIORAMA_SCALE, Math.min(MAX_DIORAMA_SCALE, currentScale * zoomRate));
            this.sceneManager.dioramaRoot.scale.set(newScale, newScale, newScale);
          }
        }
      }

      const b0_trigger = buttons[0]?.pressed || false;
      const b1_grip = (buttons[1]?.pressed || (buttons[1]?.value && buttons[1].value > 0.35)) || false;
      const b3_stickClick = buttons[3]?.pressed || false;
      const b4_primary = buttons[4]?.pressed || false;
      const b5_secondary = buttons[5]?.pressed || false;

      if (b1_grip) {
        if (!state.isGripping) {
          state.isGripping = true;
          state.prevGripWorldPos.copy(currentGripWorld);
          this.triggerHaptic(i, 0.7, 35);
        }

        state.gripWorldQuat.setFromRotationMatrix(state.grip.matrixWorld);
        this.activeGrabs.push({
          id: `controller_${i}`,
          source: 'controller',
          worldPos: currentGripWorld,
          prevWorldPos: state.prevGripWorldPos,
          wristQuat: state.gripWorldQuat,
          prevWristQuat: state.gripWorldQuat,
        });

        state.prevGripWorldPos.copy(currentGripWorld);
      } else {
        if (state.isGripping) {
          state.isGripping = false;
          this.triggerHaptic(i, 0.3, 25);
        }
      }

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

      this.updatePointerRaycast(i, state, b0_trigger, false);

      state.prevButtons[0] = b0_trigger;
      state.prevButtons[1] = b1_grip;
      state.prevButtons[3] = b3_stickClick;
      state.prevButtons[4] = b4_primary;
      state.prevButtons[5] = b5_secondary;
      state.prevGripWorldPos.copy(currentGripWorld);
    }

    // 2. WebXR Hands
    this.updateHands();

    // 3. Unified 6DOF Manipulation
    this.applyManipulation(this.activeGrabs);
  }

  private updateHands(): void {
    for (let i = 0; i < this.hands.length; i++) {
      const state = this.hands[i];
      const hand = state.hand;
      const joints = (hand as any).joints;
      if (!joints) {
        state.visualOutline.group.visible = false;
        continue;
      }

      const wrist = joints['wrist'];
      if (!wrist || !wrist.visible) {
        state.visualOutline.group.visible = false;
        state.pinchReticle.visible = false;
        state.isPinching = false;
        continue;
      }

      state.visualOutline.group.visible = true;

      for (const jointName of ALL_HAND_JOINTS) {
        const jointObj = joints[jointName];
        const pos = state.jointPosMap.get(jointName);
        if (jointObj && jointObj.visible && pos) {
          pos.setFromMatrixPosition(jointObj.matrixWorld);
        }
      }

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
        // Pure gesture math hysteresis evaluation
        const isPinchingNow = evaluatePinchState(pinchDist, state.isPinching);

        _scratchV1.copy(thumbTipPos).add(indexTipPos).multiplyScalar(0.5);
        state.pinchWorldPos.copy(_scratchV1);

        if (wrist && wrist.visible && wristPos) {
          state.wristWorldPos.copy(wristPos);
          state.wristWorldQuat.setFromRotationMatrix(wrist.matrixWorld);
        }

        const isInteractingWithHUD = this.checkHandHUDInteraction(state, indexTipPos, isPinchingNow);
        const isPointingAtHUD = this.handIsPointingAtHUD[i] || false;
        const isPinchStarting = isPinchingNow && !state.isPinching;

        if (isPinchStarting) {
          // A pinch only grabs the diorama if it starts ON the diorama volume, NOT in mid-air, on lap, or while aiming at HUD / waypoints
          if (!isInteractingWithHUD && !isPointingAtHUD && this.currentViewMode === 'diorama') {
            state.isGrabbingDiorama = this.sceneManager.isPointOnDiorama(state.pinchWorldPos, 0.08);
          } else {
            state.isGrabbingDiorama = false;
          }
        } else if (!isPinchingNow) {
          state.isGrabbingDiorama = false;
        }

        if (isPinchingNow && state.isGrabbingDiorama) {
          state.pinchReticle.position.copy(state.pinchWorldPos);
          state.pinchReticle.visible = true;

          const s = 1.0 + 0.2 * Math.sin(performance.now() * 0.012);
          state.pinchReticle.scale.set(s, s, s);

          if (isPinchStarting) {
            state.prevPinchWorldPos.copy(state.pinchWorldPos);
            state.prevWristWorldPos.copy(state.wristWorldPos);
            state.prevWristWorldQuat.copy(state.wristWorldQuat);
          }

          this.activeGrabs.push({
            id: `hand_${i}`,
            source: 'hand',
            worldPos: state.pinchWorldPos,
            prevWorldPos: state.prevPinchWorldPos,
            wristQuat: state.wristWorldQuat,
            prevWristQuat: state.prevWristWorldQuat,
          });
        } else {
          state.pinchReticle.visible = false;
        }

        state.isPinching = isPinchingNow;
        state.prevPinchWorldPos.copy(state.pinchWorldPos);
        state.prevWristWorldPos.copy(state.wristWorldPos);
        state.prevWristWorldQuat.copy(state.wristWorldQuat);
      } else {
        state.isPinching = false;
        state.isGrabbingDiorama = false;
        state.pinchReticle.visible = false;
      }
    }
  }

  private checkHandHUDInteraction(state: HandState, fingerPos: THREE.Vector3, isPinching: boolean): boolean {
    if (!this.spatialHUD) return false;

    const hudGroup = this.spatialHUD.group;
    const local = _scratchV1.copy(fingerPos);
    hudGroup.worldToLocal(local);

    const isNearGrabHandle = local.y >= 0.18 && local.y <= 0.38 && Math.abs(local.x) <= 0.38 && Math.abs(local.z) < 0.08;
    if (isNearGrabHandle && isPinching) {
      const camPos = this.sceneManager.camera.position;
      this.spatialHUD.group.position.copy(fingerPos).add(_scratchV2.set(0, -0.26, 0.05));
      this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);
      return true;
    }

    const halfW = 0.40;
    const halfH = 0.265;

    if (Math.abs(local.z) < 0.055 && Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfH) {
      const u = (local.x + halfW) / (2 * halfW);
      const v = (local.y + halfH) / (2 * halfH);
      const uv = _scratchV2D1.set(u, v);

      this.spatialHUD.onPointerHover(uv);

      const isPoke = local.z < 0.015 && local.z > -0.025;
      if ((isPinching || isPoke) && !state.isClickingHUD) {
        state.isClickingHUD = true;
        this.spatialHUD.onPointerClick(uv);
      } else if (isPinching || isPoke) {
        this.spatialHUD.onPointerDrag(uv);
      } else if (!isPinching && !isPoke) {
        if (state.isClickingHUD) {
          state.isClickingHUD = false;
          this.spatialHUD.onPointerRelease();
        }
      }
      return true;
    }

    if (state.isClickingHUD) {
      state.isClickingHUD = false;
      this.spatialHUD.onPointerRelease();
    }
    return false;
  }

  private applyManipulation(grabs: ActiveGrab[]): void {
    if (this.currentViewMode !== 'diorama') return;

    const diorama = this.sceneManager.dioramaRoot;
    const dioramaState: DioramaTransform = {
      position: diorama.position,
      rotationY: diorama.rotation.y,
      rotationX: diorama.rotation.x,
      scale: diorama.scale.x,
    };

    if (grabs.length >= 2) {
      // Delegate to pure gesture math function
      applyBimanualTransform(
        dioramaState,
        grabs[0].prevWorldPos,
        grabs[1].prevWorldPos,
        grabs[0].worldPos,
        grabs[1].worldPos
      );

      diorama.rotation.y = dioramaState.rotationY;
      if (dioramaState.rotationX !== undefined) {
        diorama.rotation.x = dioramaState.rotationX;
      }
      diorama.scale.set(dioramaState.scale, dioramaState.scale, dioramaState.scale);
    } else if (grabs.length === 1) {
      const g = grabs[0];
      if (g.wristQuat && g.prevWristQuat) {
        applyOneHandedManipulation(
          dioramaState,
          g.prevWorldPos,
          g.worldPos,
          g.prevWristQuat,
          g.wristQuat
        );
        diorama.position.copy(dioramaState.position);
        diorama.rotation.y = dioramaState.rotationY;
        if (dioramaState.rotationX !== undefined) {
          diorama.rotation.x = dioramaState.rotationX;
        }
      } else {
        const delta = _scratchV1.copy(g.worldPos).sub(g.prevWorldPos);
        diorama.position.add(delta);
      }
    }
  }

  private updatePointerRaycast(
    controllerIdx: number,
    state: ControllerState,
    isTriggerDown: boolean,
    isHand: boolean = false
  ): void {
    const tempMatrix = _scratchMat1;
    tempMatrix.identity().extractRotation(state.controller.matrixWorld);

    const rayOrigin = _scratchV1.setFromMatrixPosition(state.controller.matrixWorld);
    const rayDir = _scratchV2.set(0, 0, -1).applyMatrix4(tempMatrix).normalize();

    if (!isHand && state.isDraggingHUD && this.spatialHUD) {
      if (isTriggerDown) {
        const targetPos = _scratchV3.copy(rayOrigin).addScaledVector(rayDir, state.hudDragDistance);
        this.spatialHUD.group.position.copy(targetPos);
        const camPos = this.sceneManager.camera.position;
        this.spatialHUD.group.lookAt(camPos.x, this.spatialHUD.group.position.y, camPos.z);

        updateRayLineLength(state.rayLine, state.hudDragDistance);
        state.rayLine.visible = true;
        state.reticle.visible = true;
        state.reticle.position.copy(this.spatialHUD.grabMesh.position).applyMatrix4(this.spatialHUD.group.matrixWorld);
        return;
      } else {
        state.isDraggingHUD = false;
        this.triggerHaptic(controllerIdx, 0.4, 25);
      }
    }

    if (!isHand && state.isDraggingTerrain && this.currentViewMode === 'diorama') {
      if (isTriggerDown) {
        const planeY = this.sceneManager.dioramaRoot.position.y;
        let newHit: THREE.Vector3 | null = null;
        if (rayDir.y < -0.01) {
          const t = (planeY - rayOrigin.y) / rayDir.y;
          if (t > 0 && t < 15) {
            newHit = _scratchV3.copy(rayOrigin).addScaledVector(rayDir, t);
          }
        }

        if (newHit) {
          const deltaX = newHit.x - state.terrainDragStartHit.x;
          const deltaZ = newHit.z - state.terrainDragStartHit.z;
          this.sceneManager.dioramaRoot.position.x = state.terrainDragStartDioramaPos.x + deltaX;
          this.sceneManager.dioramaRoot.position.z = state.terrainDragStartDioramaPos.z + deltaZ;

          const dist = rayOrigin.distanceTo(newHit);
          updateRayLineLength(state.rayLine, dist);
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
      if (isHand) {
        this.handIsPointingAtHUD[controllerIdx] = true;
      }
      const hitDistance = hudHit.distance;
      updateRayLineLength(state.rayLine, hitDistance);
      state.rayLine.visible = true;
      state.reticle.visible = true;
      state.reticle.position.copy(hudHit.point);
      if (hudHit.face) {
        _scratchV3.copy(hudHit.point).add(hudHit.face.normal);
        state.reticle.lookAt(_scratchV3);
      }

      if (!isHand && (isHitGrabMesh || (hudHit.uv && this.spatialHUD!.isHoveringDragHandle()))) {
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
          if (!isHand && this.spatialHUD!.isHoveringDragHandle()) {
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
        }
      }
      return;
    }

    if (this.currentViewMode === 'diorama') {
      // 1. Raycast check for Waypoint Pins on Diorama (supported for both hands and controllers)
      const wpGroup = this.sceneManager.dioramaRoot.getObjectByName('Waypoints');
      if (wpGroup && wpGroup.children.length > 0) {
        this.raycaster.set(rayOrigin, rayDir);
        const wpHits = this.raycaster.intersectObjects(wpGroup.children, true);
        if (wpHits.length > 0) {
          let topObj: THREE.Object3D | null = wpHits[0].object;
          while (topObj && !topObj.userData?.waypoint && topObj.parent && topObj !== wpGroup) {
            topObj = topObj.parent;
          }
          const wp = topObj?.userData?.waypoint as { name: string } | undefined;
          if (wp) {
            if (isHand) {
              this.handIsPointingAtHUD[controllerIdx] = true;
            }
            const dist = wpHits[0].distance;
            updateRayLineLength(state.rayLine, dist);
            state.rayLine.visible = true;
            state.reticle.visible = true;
            state.reticle.position.copy(wpHits[0].point);
            if (wpHits[0].face) {
              _scratchV3.copy(wpHits[0].point).add(wpHits[0].face.normal);
              state.reticle.lookAt(_scratchV3);
            }
            if (isTriggerDown && !state.prevButtons[0]) {
              this.callbacks.onSelectWaypoint?.(wp.name);
              this.triggerHaptic(controllerIdx, 1.0, 50);
            }
            return;
          }
        }
      }
    }

    if (isHand) {
      this.handIsPointingAtHUD[controllerIdx] = false;
      state.rayLine.visible = false;
      state.reticle.visible = false;
      if (state.prevButtons[0] && !isTriggerDown && this.spatialHUD) {
        this.spatialHUD.onPointerRelease();
      }
      return;
    }

    if (this.currentViewMode === 'diorama') {
      const planeY = this.sceneManager.dioramaRoot.position.y;
      let tableHit: THREE.Vector3 | null = null;
      if (rayDir.y < -0.01) {
        const t = (planeY - rayOrigin.y) / rayDir.y;
        if (t > 0 && t < 12) {
          tableHit = _scratchV3.copy(rayOrigin).addScaledVector(rayDir, t);
        }
      }

      if (tableHit) {
        const dist = rayOrigin.distanceTo(tableHit);
        updateRayLineLength(state.rayLine, dist);
        state.rayLine.visible = true;
        state.reticle.visible = true;
        state.reticle.position.copy(tableHit);
        _scratchV4.copy(tableHit).add(_scratchV5.set(0, 1, 0));
        state.reticle.lookAt(_scratchV4);

        if (isTriggerDown && !state.prevButtons[0]) {
          state.isDraggingTerrain = true;
          state.terrainDragStartHit.copy(tableHit);
          state.terrainDragStartDioramaPos.copy(this.sceneManager.dioramaRoot.position);
          this.triggerHaptic(controllerIdx, 0.7, 35);
        }
        return;
      }
    }

    updateRayLineLength(state.rayLine, 2.5);
    state.rayLine.visible = true;
    state.reticle.visible = false;

    if (state.prevButtons[0] && !isTriggerDown && this.spatialHUD) {
      this.spatialHUD.onPointerRelease();
    }
  }

  public resetInteractionState(): void {
    for (let i = 0; i < this.controllers.length; i++) {
      const c = this.controllers[i];
      c.isGripping = false;
      c.isDraggingHUD = false;
      c.isDraggingTerrain = false;
      c.prevButtons.fill(false);
      c.rayLine.visible = false;
      c.reticle.visible = false;
    }
    for (let i = 0; i < this.hands.length; i++) {
      const h = this.hands[i];
      h.isPinching = false;
      h.isGrabbingDiorama = false;
      h.isClickingHUD = false;
      h.pinchReticle.visible = false;
      h.visualOutline.group.visible = false;
    }
    this.handIsPointingAtHUD[0] = false;
    this.handIsPointingAtHUD[1] = false;
    if (this.spatialHUD) {
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

  public dispose(): void {
    this.resetInteractionState();
    for (const ctrl of this.controllers) {
      disposeObject3D(ctrl.controller);
      disposeObject3D(ctrl.grip);
      disposeObject3D(ctrl.reticle);
    }
    this.controllers = [];

    for (const h of this.hands) {
      disposeObject3D(h.hand);
      disposeObject3D(h.visualOutline.group);
      disposeObject3D(h.pinchReticle);
    }
    this.hands = [];
  }
}
