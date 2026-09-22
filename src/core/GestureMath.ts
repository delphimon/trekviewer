import * as THREE from 'three';

export interface DioramaTransform {
  position: THREE.Vector3;
  rotationY: number;
  rotationX?: number;
  scale: number;
}

export interface DioramaVolume {
  halfWidthM: number;
  halfDepthM: number;
  minY: number;
  maxY: number;
}

export const PINCH_ENGAGE_THRESHOLD_METERS = 0.032; // 3.2 cm
export const PINCH_RELEASE_THRESHOLD_METERS = 0.045; // 4.5 cm

export const MIN_DIORAMA_SCALE = 0.000005;
export const MAX_DIORAMA_SCALE = 0.05;
export const MIN_DIORAMA_PITCH = -1.3;
export const MAX_DIORAMA_PITCH = 1.3;

/**
 * Evaluates pinch state using hysteresis to prevent jitter and accidental drops.
 */
export function evaluatePinchState(
  currentDist: number,
  wasPinching: boolean,
  engageThreshold: number = PINCH_ENGAGE_THRESHOLD_METERS,
  releaseThreshold: number = PINCH_RELEASE_THRESHOLD_METERS
): boolean {
  return wasPinching ? currentDist <= releaseThreshold : currentDist <= engageThreshold;
}

/**
 * Normalizes an angle in radians into the range [-PI, PI].
 */
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Determines whether a world-space point (such as a hand pinch contact) is on or within
 * contact proximity of the diorama volume in room meters.
 */
export function isPointOnDiorama(
  pointWorldPos: THREE.Vector3,
  dioramaRoot: THREE.Object3D,
  volume: DioramaVolume,
  contactThresholdMeters: number = 0.08
): boolean {
  const scale = dioramaRoot.scale.x;
  if (scale <= 0) return false;

  // Ensure matrices are synchronized
  dioramaRoot.updateMatrixWorld(true);

  // Transform world point into diorama's local coordinate system
  const localPos = pointWorldPos.clone();
  dioramaRoot.worldToLocal(localPos);

  // Compute room-meter distance from the diorama volume
  const dx = Math.max(0, Math.abs(localPos.x) - volume.halfWidthM) * scale;
  const dz = Math.max(0, Math.abs(localPos.z) - volume.halfDepthM) * scale;
  const dy = (localPos.y < volume.minY ? volume.minY - localPos.y : (localPos.y > volume.maxY ? localPos.y - volume.maxY : 0)) * scale;

  const distM = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return distM <= contactThresholdMeters;
}

/**
 * Computes bimanual (two-handed) scale, translation, horizontal yaw, and 3D pitch tilt.
 * Anchors transform around the midpoint of both hands.
 */
export function applyBimanualTransform(
  diorama: DioramaTransform,
  p0Prev: THREE.Vector3,
  p1Prev: THREE.Vector3,
  p0Curr: THREE.Vector3,
  p1Curr: THREE.Vector3,
  minScale: number = MIN_DIORAMA_SCALE,
  maxScale: number = MAX_DIORAMA_SCALE
): void {
  const prevDist = p0Prev.distanceTo(p1Prev);
  const currDist = p0Curr.distanceTo(p1Curr);

  const prevMid = p0Prev.clone().add(p1Prev).multiplyScalar(0.5);
  const currMid = p0Curr.clone().add(p1Curr).multiplyScalar(0.5);

  // 1. Scale factor with clamping
  let scaleFactor = 1.0;
  if (prevDist > 0.03 && currDist > 0.03) {
    const rawFactor = currDist / prevDist;
    scaleFactor = Math.max(0.65, Math.min(1.5, rawFactor));
  }

  // 2. Yaw rotation delta with boundary wrapping (-PI to PI)
  const vPrev = p1Prev.clone().sub(p0Prev);
  const vCurr = p1Curr.clone().sub(p0Curr);
  const anglePrev = Math.atan2(vPrev.x, vPrev.z);
  const angleCurr = Math.atan2(vCurr.x, vCurr.z);
  const deltaAngle = normalizeAngle(angleCurr - anglePrev);

  // 3D Pitch: vertical inclination change between hands relative to depth
  const deltaY = (p1Curr.y - p1Prev.y) - (p0Curr.y - p0Prev.y);
  const sepZ = p1Curr.z - p0Curr.z;
  let deltaPitch = 0;
  if (Math.abs(sepZ) > 0.06) {
    deltaPitch = -(deltaY / Math.abs(sepZ)) * Math.sign(sepZ) * 0.85;
  }

  // 3. Anchored transform around hands' midpoint
  const currentScale = diorama.scale;
  const targetScale = Math.max(minScale, Math.min(maxScale, currentScale * scaleFactor));
  const effectiveScale = targetScale / currentScale;

  const offset = diorama.position.clone().sub(prevMid);
  offset.multiplyScalar(effectiveScale);
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), deltaAngle);

  diorama.position.copy(currMid).add(offset);
  diorama.rotationY += deltaAngle;
  if (diorama.rotationX === undefined) diorama.rotationX = 0;
  if (Math.abs(deltaPitch) > 0.003) {
    diorama.rotationX = Math.max(MIN_DIORAMA_PITCH, Math.min(MAX_DIORAMA_PITCH, diorama.rotationX + deltaPitch));
  }
  diorama.scale = targetScale;
}

/**
 * Computes one-handed 1:1 translation, wrist twist yaw, and wrist pitch tilt.
 * Anchors rotation and pitch around the hand's grip point so the grabbed virtual feature
 * remains locked under the user's fingers.
 */
export function applyOneHandedManipulation(
  diorama: DioramaTransform,
  prevHandPos: THREE.Vector3,
  currHandPos: THREE.Vector3,
  prevWristQuat: THREE.Quaternion,
  currWristQuat: THREE.Quaternion
): void {
  // 1. 1:1 Translation
  const deltaMove = currHandPos.clone().sub(prevHandPos);
  diorama.position.add(deltaMove);

  // 2. Wrist twist yaw delta
  const fPrev = new THREE.Vector3(0, 0, -1).applyQuaternion(prevWristQuat);
  const fCurr = new THREE.Vector3(0, 0, -1).applyQuaternion(currWristQuat);
  const yawPrev = Math.atan2(fPrev.x, fPrev.z);
  const yawCurr = Math.atan2(fCurr.x, fCurr.z);
  const deltaYaw = normalizeAngle(yawCurr - yawPrev);

  if (Math.abs(deltaYaw) > 0.005 && Math.abs(deltaYaw) < 0.4) {
    const rotYDelta = deltaYaw * 0.95;
    // Pivot diorama position around currHandPos so the grabbed point stays fixed under the hand
    const pivotOffset = diorama.position.clone().sub(currHandPos);
    pivotOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotYDelta);
    diorama.position.copy(currHandPos).add(pivotOffset);
    diorama.rotationY += rotYDelta;
  }

  // 3. Wrist pitch tilt: tilt wrist down pitches map down; tilt wrist up pitches map up
  const pitchPrev = Math.asin(Math.max(-1, Math.min(1, fPrev.y)));
  const pitchCurr = Math.asin(Math.max(-1, Math.min(1, fCurr.y)));
  const deltaPitch = pitchCurr - pitchPrev;
  if (diorama.rotationX === undefined) diorama.rotationX = 0;
  if (Math.abs(deltaPitch) > 0.005 && Math.abs(deltaPitch) < 0.4) {
    const rotXDelta = deltaPitch * 0.9;
    const pivotOffset = diorama.position.clone().sub(currHandPos);
    pivotOffset.applyAxisAngle(new THREE.Vector3(1, 0, 0), rotXDelta);
    diorama.position.copy(currHandPos).add(pivotOffset);
    diorama.rotationX = Math.max(MIN_DIORAMA_PITCH, Math.min(MAX_DIORAMA_PITCH, diorama.rotationX + rotXDelta));
  }
}
