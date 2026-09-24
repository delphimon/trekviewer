import * as THREE from 'three';

export interface TestDioramaTransform {
  position: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  rotationY: number;
  rotationX?: number;
  scale: number;
}

export type DioramaTransform =
  | THREE.Object3D
  | TestDioramaTransform
  | {
      position: THREE.Vector3;
      quaternion?: THREE.Quaternion;
      scale: THREE.Vector3 | number;
      rotationY?: number;
      rotationX?: number;
    };

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

/**
 * Strict physical fingertip contact thresholds for Quest 3 optical hand tracking (Stage V1).
 * Normal human thumb/index fingertip contact occurs around 18-22mm center-to-center.
 * A relaxed hand hanging at the user's side is typically 30-45mm separation.
 */
export const PINCH_ENGAGE_DISTANCE = 0.020; // 20 mm: requires actual fingertip contact/near-contact
export const PINCH_RELEASE_DISTANCE = 0.028; // 28 mm: modest hysteresis release, drops immediately if fingers open
export const PINCH_CONFIRMATION_FRAMES = 3; // ~40ms at 72Hz: suppresses 1-frame tracking noise

export type PinchPhase = 'open' | 'candidate' | 'pinching' | 'released';

export interface PinchTracker {
  phase: PinchPhase;
  contactFrames: number;
  isPinching: boolean;
  justPinched: boolean; // Fresh pinch-down edge in this frame
  justReleased: boolean; // Fresh release edge in this frame
}

export function createPinchTracker(): PinchTracker {
  return {
    phase: 'open',
    contactFrames: 0,
    isPinching: false,
    justPinched: false,
    justReleased: false,
  };
}

/**
 * Updates a persistent pinch tracker with current thumb-index separation.
 * Requires sustained contact for PINCH_CONFIRMATION_FRAMES before transitioning to 'pinching' (justPinched edge).
 * Releases immediately once separation exceeds PINCH_RELEASE_DISTANCE.
 */
export function updatePinchTracker(
  tracker: PinchTracker,
  currentDist: number,
  confirmationFrames: number = PINCH_CONFIRMATION_FRAMES
): PinchTracker {
  tracker.justPinched = false;
  tracker.justReleased = false;

  if (tracker.isPinching) {
    if (currentDist > PINCH_RELEASE_DISTANCE) {
      tracker.phase = 'released';
      tracker.isPinching = false;
      tracker.contactFrames = 0;
      tracker.justReleased = true;
    } else {
      tracker.phase = 'pinching';
    }
  } else {
    if (currentDist <= PINCH_ENGAGE_DISTANCE) {
      tracker.contactFrames++;
      if (tracker.contactFrames >= confirmationFrames) {
        tracker.phase = 'pinching';
        tracker.isPinching = true;
        tracker.justPinched = true;
      } else {
        tracker.phase = 'candidate';
      }
    } else {
      tracker.phase = 'open';
      tracker.contactFrames = 0;
    }
  }

  return tracker;
}

/**
 * Evaluates pinch engage/release hysteresis with strict physical contact thresholds.
 * Engage threshold: 2.0cm (0.020m).
 * Release threshold: 2.8cm (0.028m).
 */
export function evaluatePinchState(
  currentDist: number,
  wasPinching: boolean,
  engageDist: number = PINCH_ENGAGE_DISTANCE,
  releaseDist: number = PINCH_RELEASE_DISTANCE
): boolean {
  return wasPinching ? currentDist <= releaseDist : currentDist <= engageDist;
}

// Module-scoped scratch instances for hot-loop manipulation math to avoid allocations
const _scratchVPrev = new THREE.Vector3();
const _scratchVCurr = new THREE.Vector3();
const _scratchPrevMid = new THREE.Vector3();
const _scratchCurrMid = new THREE.Vector3();
const _scratchOffset = new THREE.Vector3();
const _scratchTestQuat = new THREE.Quaternion();
const _scratchUp = new THREE.Vector3();
const _scratchHorizPrev = new THREE.Vector3();
const _scratchHorizCurr = new THREE.Vector3();
const _scratchQLine = new THREE.Quaternion();
const _scratchQTwist = new THREE.Quaternion();
const _scratchRot = new THREE.Quaternion();
const _scratchEuler = new THREE.Euler();

const _scratchFPrev = new THREE.Vector3();
const _scratchFCurr = new THREE.Vector3();
const _scratchFHoriz = new THREE.Vector3();
const _scratchRightAxis = new THREE.Vector3();
const _scratchQYaw = new THREE.Quaternion();
const _scratchQPitch = new THREE.Quaternion();
const _scratchQCombined = new THREE.Quaternion();
const _scratchYAxis = new THREE.Vector3(0, 1, 0);

/**
 * Two-handed 6DOF manipulation: scale, rotate, translate & pitch along inter-hand line.
 * Contact-anchored invariance: both grab points stay glued to the diorama.
 */
export function applyBimanualTransform(
  diorama: DioramaTransform,
  p0Prev: THREE.Vector3,
  p1Prev: THREE.Vector3,
  p0Curr: THREE.Vector3,
  p1Curr: THREE.Vector3,
  wrist0Prev?: THREE.Quaternion,
  wrist0Curr?: THREE.Quaternion,
  wrist1Prev?: THREE.Quaternion,
  wrist1Curr?: THREE.Quaternion
): void {
  const target = diorama as any;
  if (!target.quaternion) {
    _scratchEuler.set(target.rotationX || 0, target.rotationY || 0, 0, 'YXZ');
    target.quaternion = new THREE.Quaternion().setFromEuler(_scratchEuler);
  }

  const prevDist = p0Prev.distanceTo(p1Prev);
  const currDist = p0Curr.distanceTo(p1Curr);

  _scratchPrevMid.copy(p0Prev).add(p1Prev).multiplyScalar(0.5);
  _scratchCurrMid.copy(p0Curr).add(p1Curr).multiplyScalar(0.5);

  // 1. Scale factor with clamping
  let scaleFactor = 1.0;
  if (prevDist > 0.03 && currDist > 0.03) {
    const rawFactor = currDist / prevDist;
    scaleFactor = Math.max(0.65, Math.min(1.5, rawFactor));
  }

  // 2. 3D Rotation of the inter-hand line
  _scratchVPrev.subVectors(p1Prev, p0Prev);
  _scratchVCurr.subVectors(p1Curr, p0Curr);

  _scratchQLine.identity();
  if (_scratchVPrev.lengthSq() > 1e-6 && _scratchVCurr.lengthSq() > 1e-6) {
    _scratchVPrev.normalize();
    _scratchVCurr.normalize();
    if (_scratchVPrev.dot(_scratchVCurr) > -0.999) {
      _scratchQLine.setFromUnitVectors(_scratchVPrev, _scratchVCurr);
    }
  }

  // 3. Wrist twist along the inter-hand line (handlebar tilt)
  _scratchQTwist.identity();
  const vCurrLenSq = p1Curr.distanceToSquared(p0Curr);
  if (vCurrLenSq > 1e-6) {
    _scratchVCurr.subVectors(p1Curr, p0Curr).normalize();
    let twistAccum = 0;
    let twistCount = 0;

    const wristPairs = [
      { prev: wrist0Prev, curr: wrist0Curr },
      { prev: wrist1Prev, curr: wrist1Curr },
    ];
    for (const pair of wristPairs) {
      if (pair.prev && pair.curr) {
        const dq = pair.curr.clone().multiply(pair.prev.clone().invert());
        if (dq.w < 0) {
          dq.x = -dq.x;
          dq.y = -dq.y;
          dq.z = -dq.z;
          dq.w = -dq.w;
        }
        const rotVec = new THREE.Vector3(dq.x * 2, dq.y * 2, dq.z * 2);
        const twistAngle = rotVec.dot(_scratchVCurr);
        if (Math.abs(twistAngle) > 0.002 && Math.abs(twistAngle) < 0.3) {
          twistAccum += twistAngle;
          twistCount++;
        }
      }
    }

    if (twistCount > 0) {
      const avgTwist = twistAccum / twistCount;
      _scratchQTwist.setFromAxisAngle(_scratchVCurr, avgTwist * 0.85);
    }
  }

  // Combined 3D rotation
  _scratchRot.copy(_scratchQTwist).multiply(_scratchQLine);

  // Guard against upside-down inversion: diorama up vector must maintain y >= 0.15
  _scratchTestQuat.copy(_scratchRot).multiply(target.quaternion);
  _scratchUp.set(0, 1, 0).applyQuaternion(_scratchTestQuat);
  if (_scratchUp.y < 0.15) {
    _scratchHorizPrev.set(p1Prev.x - p0Prev.x, 0, p1Prev.z - p0Prev.z);
    _scratchHorizCurr.set(p1Curr.x - p0Curr.x, 0, p1Curr.z - p0Curr.z);
    if (_scratchHorizPrev.lengthSq() > 1e-6 && _scratchHorizCurr.lengthSq() > 1e-6) {
      _scratchRot.setFromUnitVectors(_scratchHorizPrev.normalize(), _scratchHorizCurr.normalize());
    } else {
      _scratchRot.identity();
    }
  }

  // 4. Scale calculation
  const currentScale = typeof target.scale === 'number' ? target.scale : target.scale.x;
  const targetScale = Math.max(0.000005, Math.min(0.05, currentScale * scaleFactor));
  const effectiveScale = targetScale / currentScale;

  // 5. Physical anchored transform around hands' midpoint
  _scratchOffset.copy(target.position).sub(_scratchPrevMid);
  _scratchOffset.multiplyScalar(effectiveScale);
  _scratchOffset.applyQuaternion(_scratchRot);

  target.position.copy(_scratchCurrMid).add(_scratchOffset);
  target.quaternion.premultiply(_scratchRot);
  if (typeof target.scale === 'number') {
    target.scale = targetScale;
  } else {
    target.scale.set(targetScale, targetScale, targetScale);
  }

  // Sync Euler angles if diorama has them for inspection
  if (target.rotationY !== undefined || target.rotationX !== undefined) {
    _scratchEuler.setFromQuaternion(target.quaternion, 'YXZ');
    if (target.rotationY !== undefined) target.rotationY = _scratchEuler.y;
    if (target.rotationX !== undefined) target.rotationX = _scratchEuler.x;
  }
}

/**
 * One-handed contact-anchored 6DOF manipulation: translate + pivot yaw & pitch around contact point.
 */
export function applyOneHandedManipulation(
  diorama: DioramaTransform,
  prevHandPos: THREE.Vector3,
  currHandPos: THREE.Vector3,
  prevWristQuat?: THREE.Quaternion,
  currWristQuat?: THREE.Quaternion
): void {
  const target = diorama as any;
  if (!target.quaternion) {
    _scratchEuler.set(target.rotationX || 0, target.rotationY || 0, 0, 'YXZ');
    target.quaternion = new THREE.Quaternion().setFromEuler(_scratchEuler);
  }

  _scratchRot.identity();

  if (prevWristQuat && currWristQuat) {
    _scratchFPrev.set(0, 0, -1).applyQuaternion(prevWristQuat);
    _scratchFCurr.set(0, 0, -1).applyQuaternion(currWristQuat);

    const yawPrev = Math.atan2(_scratchFPrev.x, _scratchFPrev.z);
    const yawCurr = Math.atan2(_scratchFCurr.x, _scratchFCurr.z);
    let deltaYaw = yawCurr - yawPrev;
    while (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
    while (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;

    const pitchPrev = Math.asin(Math.max(-1, Math.min(1, _scratchFPrev.y)));
    const pitchCurr = Math.asin(Math.max(-1, Math.min(1, _scratchFCurr.y)));
    const deltaPitch = pitchCurr - pitchPrev;

    _scratchQYaw.identity();
    if (Math.abs(deltaYaw) > 0.0005 && Math.abs(deltaYaw) < 0.5) {
      _scratchQYaw.setFromAxisAngle(_scratchYAxis, deltaYaw);
    }

    _scratchQPitch.identity();
    if (Math.abs(deltaPitch) > 0.0005 && Math.abs(deltaPitch) < 0.5) {
      _scratchFHoriz.set(_scratchFCurr.x, 0, _scratchFCurr.z);
      if (_scratchFHoriz.lengthSq() > 1e-4) {
        _scratchFHoriz.normalize();
      } else {
        _scratchFHoriz.set(0, 0, -1);
      }
      _scratchRightAxis.crossVectors(_scratchFHoriz, _scratchYAxis).normalize();
      _scratchQPitch.setFromAxisAngle(_scratchRightAxis, deltaPitch);
    }

    _scratchQCombined.copy(_scratchQYaw).multiply(_scratchQPitch);

    _scratchTestQuat.copy(_scratchQCombined).multiply(target.quaternion);
    _scratchUp.set(0, 1, 0).applyQuaternion(_scratchTestQuat);
    if (_scratchUp.y >= 0.15) {
      _scratchRot.copy(_scratchQCombined);
    } else {
      _scratchRot.copy(_scratchQYaw);
    }
  }

  // Physical pivot transformation around contact point:
  // Invariant: The virtual point on the diorama being held under prevHandPos lands exactly at currHandPos
  _scratchOffset.copy(target.position).sub(prevHandPos);
  _scratchOffset.applyQuaternion(_scratchRot);

  target.position.copy(currHandPos).add(_scratchOffset);
  target.quaternion.premultiply(_scratchRot);

  if (target.rotationY !== undefined || target.rotationX !== undefined) {
    _scratchEuler.setFromQuaternion(target.quaternion, 'YXZ');
    if (target.rotationY !== undefined) target.rotationY = _scratchEuler.y;
    if (target.rotationX !== undefined) target.rotationX = _scratchEuler.x;
  }
}

/**
 * Clamps pathological frame deltas to [0.001, 0.1] seconds.
 */
export function clampDeltaSeconds(deltaSeconds: number): number {
  if (isNaN(deltaSeconds) || deltaSeconds <= 0) return 0.001;
  return Math.min(Math.max(deltaSeconds, 0.001), 0.1);
}

/**
 * Computes first-person thumbstick walking distance delta in meters.
 * Speed: 18.0 m/s normal, 75.0 m/s turbo.
 */
export function computeThumbstickWalkDelta(stickY: number, isTurbo: boolean, dt: number): number {
  if (Math.abs(stickY) <= 0.1) return 0;
  const baseSpeedMps = isTurbo ? 75.0 : 18.0;
  return -stickY * baseSpeedMps * dt;
}

/**
 * Computes tabletop thumbstick panning displacement in meters.
 * Speed: 0.7 m/s normal, 1.5 m/s turbo.
 */
export function computeThumbstickPan(
  stickX: number,
  stickY: number,
  isTurbo: boolean,
  dt: number
): { dx: number; dz: number } {
  const hasX = Math.abs(stickX) > 0.1;
  const hasY = Math.abs(stickY) > 0.1;
  if (!hasX && !hasY) return { dx: 0, dz: 0 };
  const panSpeed = isTurbo ? 1.5 : 0.7; // m/s
  return {
    dx: (hasX ? stickX : 0) * panSpeed * dt,
    dz: (hasY ? stickY : 0) * panSpeed * dt,
  };
}

/**
 * Computes tabletop thumbstick yaw rotation in radians.
 * Speed: 2.1 rad/s (~120 deg/s).
 */
export function computeThumbstickRotation(stickX: number, dt: number): number {
  if (Math.abs(stickX) <= 0.12) return 0;
  const rotSpeedRadPerSec = 2.1;
  return stickX * rotSpeedRadPerSec * dt;
}

/**
 * Computes tabletop time-based exponential zoom multiplier.
 * Uses scale * exp(-stickY * zoomRate * dt) so the zoom feel is strictly frame-rate independent.
 */
export function computeThumbstickZoomFactor(stickY: number, dt: number): number {
  if (Math.abs(stickY) <= 0.12) return 1.0;
  const zoomRate = 2.1;
  return Math.exp(-stickY * zoomRate * dt);
}
