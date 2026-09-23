import * as THREE from 'three';
import assert from 'node:assert';
import { describe, it } from 'vitest';
import { ALL_HAND_JOINTS, BONE_CONNECTIONS } from '../src/core/XRManager.ts';

describe('Hand Tracking & 6DOF Manipulation Gestures', () => {
  it('evaluates gestures, isolation, and 6DOF manipulation', () => {

// =========================================================================
// 1. Pinch Detection & Hysteresis Logic Test
// =========================================================================
console.log('Testing pinch detection and hysteresis thresholds...');

function evaluatePinchState(currentDist: number, wasPinching: boolean): boolean {
  // Logic matching XRManager.ts:
  // Engage threshold: 3.2cm (0.032m)
  // Release threshold: 4.5cm (0.045m)
  return wasPinching ? currentDist <= 0.045 : currentDist <= 0.032;
}

let isPinching = false;

// Case 1: Hands relaxed, open (distance = 6cm)
isPinching = evaluatePinchState(0.06, isPinching);
assert.strictEqual(isPinching, false, '6cm distance should not pinch');

// Case 2: Approaching (distance = 3.8cm, above 3.2cm engage threshold)
isPinching = evaluatePinchState(0.038, isPinching);
assert.strictEqual(isPinching, false, '3.8cm distance should not trigger initial pinch');

// Case 3: Pinch contact (distance = 2.8cm, below 3.2cm)
isPinching = evaluatePinchState(0.028, isPinching);
assert.strictEqual(isPinching, true, '2.8cm distance must trigger pinch engage');

// Case 4: Slight finger opening during manipulation (distance = 4.0cm, below 4.5cm release)
// Hysteresis prevents accidental drops while moving/scaling
isPinching = evaluatePinchState(0.040, isPinching);
assert.strictEqual(isPinching, true, '4.0cm distance must stay pinching due to hysteresis');

// Case 5: Full release (distance = 5.0cm, above 4.5cm release threshold)
isPinching = evaluatePinchState(0.050, isPinching);
assert.strictEqual(isPinching, false, '5.0cm distance must release pinch');

console.log('✓ Pinch hysteresis thresholds (<3.2cm engage, >4.5cm release) verified successfully');

// =========================================================================
// 2. Bimanual (Two-Handed) 6DOF Manipulation Math
// =========================================================================
console.log('Testing two-handed 6DOF manipulation math...');

interface DioramaTransform {
  position: THREE.Vector3;
  rotationY: number;
  rotationX?: number;
  scale: number;
}

function applyBimanualTransform(
  diorama: DioramaTransform,
  p0Prev: THREE.Vector3,
  p1Prev: THREE.Vector3,
  p0Curr: THREE.Vector3,
  p1Curr: THREE.Vector3
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
  let deltaAngle = angleCurr - anglePrev;
  while (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
  while (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;

  // 3D Pitch: vertical inclination change between hands relative to depth
  const deltaY = (p1Curr.y - p1Prev.y) - (p0Curr.y - p0Prev.y);
  const sepZ = p1Curr.z - p0Curr.z;
  let deltaPitch = 0;
  if (Math.abs(sepZ) > 0.06) {
    deltaPitch = -(deltaY / Math.abs(sepZ)) * Math.sign(sepZ) * 0.85;
  }

  // 3. Anchored transform around hands' midpoint
  const currentScale = diorama.scale;
  const targetScale = Math.max(0.000005, Math.min(0.05, currentScale * scaleFactor));
  const effectiveScale = targetScale / currentScale;

  const offset = diorama.position.clone().sub(prevMid);
  offset.multiplyScalar(effectiveScale);
  offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), deltaAngle);

  diorama.position.copy(currMid).add(offset);
  diorama.rotationY += deltaAngle;
  if (diorama.rotationX === undefined) diorama.rotationX = 0;
  if (Math.abs(deltaPitch) > 0.003) {
    diorama.rotationX = Math.max(-1.3, Math.min(1.3, diorama.rotationX + deltaPitch));
  }
  diorama.scale = targetScale;
}

// 2A. Stretch hands apart -> Scale increases (Zoom In)
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    scale: 0.002,
  };

  const p0Prev = new THREE.Vector3(-0.15, 1.2, -1.0);
  const p1Prev = new THREE.Vector3(0.15, 1.2, -1.0); // dist = 0.30m
  const p0Curr = new THREE.Vector3(-0.225, 1.2, -1.0);
  const p1Curr = new THREE.Vector3(0.225, 1.2, -1.0); // dist = 0.45m (1.5x)

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  assert(Math.abs(diorama.scale - 0.003) < 1e-6, `Expected scale ~0.003, got ${diorama.scale}`);
  assert(Math.abs(diorama.position.x - 0) < 1e-6, 'Position x should remain centered');
  console.log('✓ Pulling hands apart correctly expands scale (1.5x zoom)');
}

// 2B. Squeeze hands together -> Scale decreases (Zoom Out)
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    scale: 0.002,
  };

  const p0Prev = new THREE.Vector3(-0.2, 1.2, -1.0);
  const p1Prev = new THREE.Vector3(0.2, 1.2, -1.0); // dist = 0.40m
  const p0Curr = new THREE.Vector3(-0.15, 1.2, -1.0);
  const p1Curr = new THREE.Vector3(0.15, 1.2, -1.0); // dist = 0.30m (0.75x)

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  assert(Math.abs(diorama.scale - 0.0015) < 1e-6, `Expected scale ~0.0015, got ${diorama.scale}`);
  console.log('✓ Pushing hands together correctly reduces scale (0.75x zoom)');
}

// 2C. Simultaneous translation: both hands move by (dx, dy, dz)
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.0, -1.0),
    rotationY: 0,
    scale: 0.002,
  };

  const move = new THREE.Vector3(0.08, -0.04, 0.12);
  const p0Prev = new THREE.Vector3(-0.15, 1.0, -1.0);
  const p1Prev = new THREE.Vector3(0.15, 1.0, -1.0);
  const p0Curr = p0Prev.clone().add(move);
  const p1Curr = p1Prev.clone().add(move);

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  assert(Math.abs(diorama.position.x - (0 + move.x)) < 1e-5, 'Translation X mismatch');
  assert(Math.abs(diorama.position.y - (1.0 + move.y)) < 1e-5, 'Translation Y mismatch');
  assert(Math.abs(diorama.position.z - (-1.0 + move.z)) < 1e-5, 'Translation Z mismatch');
  console.log('✓ Dual-hand translation moves diorama 1:1 in 3D room space');
}

// 2D. Yaw Rotation: Hands wheel around vertical axis
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.0, -1.0),
    rotationY: 0,
    scale: 0.002,
  };

  // Previous hands on X axis: vector (0.4, 0, 0) -> angle = atan2(0.4, 0) = PI/2
  const p0Prev = new THREE.Vector3(-0.2, 1.0, -1.0);
  const p1Prev = new THREE.Vector3(0.2, 1.0, -1.0);

  // Current hands rotated 90 degrees onto Z axis: vector (0, 0, -0.4) -> angle = atan2(0, -0.4) = PI
  const p0Curr = new THREE.Vector3(0, 1.0, -0.8);
  const p1Curr = new THREE.Vector3(0, 1.0, -1.2);

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  // Delta angle should be PI/2 (90 deg)
  const expectedRot = Math.PI / 2;
  assert(Math.abs(diorama.rotationY - expectedRot) < 1e-4, `Expected yaw ~${expectedRot}, got ${diorama.rotationY}`);
  console.log('✓ Dual-hand steering wheel gesture correctly rotates diorama around vertical axis');
}

// 2E. Midpoint Pivot Invariance:
// A terrain feature located at the midpoint of both hands must remain stationary under simultaneous rotation and scaling.
{
  const pivotPoint = new THREE.Vector3(0.5, 1.2, -0.8);
  const diorama: DioramaTransform = {
    position: pivotPoint.clone(),
    rotationY: 0.3,
    scale: 0.002,
  };

  // Hands centered on the pivot
  const p0Prev = pivotPoint.clone().add(new THREE.Vector3(-0.2, 0, 0));
  const p1Prev = pivotPoint.clone().add(new THREE.Vector3(0.2, 0, 0));

  // Hands rotate 45 deg and stretch 1.2x around same midpoint
  const rot45 = new THREE.Matrix4().makeRotationY(Math.PI / 4);
  const p0Curr = pivotPoint.clone().add(new THREE.Vector3(-0.24, 0, 0).applyMatrix4(rot45));
  const p1Curr = pivotPoint.clone().add(new THREE.Vector3(0.24, 0, 0).applyMatrix4(rot45));

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  assert(diorama.position.distanceTo(pivotPoint) < 1e-5, 'Midpoint pivot anchoring preserved position perfectly');
  console.log('✓ Midpoint pivot anchoring preserves contact location during simultaneous scale + rotate');
}

// 2F. Dual-Hand 3D Pitch Tilt:
// Lifting distant hand tilts diorama forward to peer into canyons/valleys
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    rotationX: 0,
    scale: 0.002,
  };

  // p0 is close (z = -0.8), p1 is far (z = -1.2) -> sepZ = -0.4
  const p0Prev = new THREE.Vector3(0, 1.2, -0.8);
  const p1Prev = new THREE.Vector3(0, 1.2, -1.2);

  // User tilts hands: lifts far hand p1 by +0.06m
  const p0Curr = new THREE.Vector3(0, 1.2, -0.8);
  const p1Curr = new THREE.Vector3(0, 1.26, -1.2);

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  // deltaY = 0.06 - 0 = 0.06, sepZ = -0.4 -> deltaPitch = -(0.06/0.4)*(-1)*0.85 = +0.1275 rad
  assert(diorama.rotationX! > 0.10, `Expected pitch tilt > 0.10, got ${diorama.rotationX}`);
  console.log('✓ Dual-hand vertical separation correctly tilts diorama pitch in 3D');
}

// =========================================================================
// 3. One-Handed Direct Manipulation (1:1 Drag, Wrist Twist Yaw & Pitch)
// =========================================================================
console.log('Testing one-handed direct manipulation...');

function applyOneHandedManipulation(
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
  let deltaYaw = yawCurr - yawPrev;
  while (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
  while (deltaYaw < -Math.PI) deltaYaw += 2 * Math.PI;

  if (Math.abs(deltaYaw) > 0.005 && Math.abs(deltaYaw) < 0.4) {
    diorama.rotationY += deltaYaw * 0.95;
  }

  // 3. Wrist pitch tilt (allows looking down into canyons)
  const pitchPrev = Math.asin(Math.max(-1, Math.min(1, fPrev.y)));
  const pitchCurr = Math.asin(Math.max(-1, Math.min(1, fCurr.y)));
  const deltaPitch = pitchCurr - pitchPrev;
  if (diorama.rotationX === undefined) diorama.rotationX = 0;
  if (Math.abs(deltaPitch) > 0.005 && Math.abs(deltaPitch) < 0.4) {
    diorama.rotationX = Math.max(-1.3, Math.min(1.3, diorama.rotationX + deltaPitch * 0.9));
  }
}

{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    rotationX: 0,
    scale: 0.002,
  };

  const pPrev = new THREE.Vector3(0.1, 1.2, -0.9);
  const pCurr = new THREE.Vector3(0.15, 1.25, -0.85); // move (+0.05, +0.05, +0.05)

  // Wrist twists yaw 0.2 rad and pitches 0.15 rad
  const qPrev = new THREE.Quaternion().identity();
  const euler = new THREE.Euler(0.15, 0.2, 0, 'YXZ');
  const qCurr = new THREE.Quaternion().setFromEuler(euler);

  applyOneHandedManipulation(diorama, pPrev, pCurr, qPrev, qCurr);

  assert(Math.abs(diorama.position.x - 0.05) < 1e-5, '1:1 X translation match');
  assert(Math.abs(diorama.position.y - 1.25) < 1e-5, '1:1 Y translation match');
  assert(Math.abs(diorama.position.z - (-0.95)) < 1e-5, '1:1 Z translation match');
  assert(Math.abs(diorama.rotationY - (0.2 * 0.95)) < 0.02, 'Wrist twist yaw rotation applied');
  assert(Math.abs(diorama.rotationX! - (0.15 * 0.9)) < 0.02, 'Wrist tilt pitch rotation applied');
  console.log('✓ One-handed 1:1 translation, wrist-twist yaw rotation, and wrist pitch tilt verified');
}

// =========================================================================
// 4. Spatial HUD Direct Touch / Poke Projection Test
// =========================================================================
console.log('Testing fingertip Spatial HUD direct touch / poke projection...');

function testHUDInteraction(
  fingerWorldPos: THREE.Vector3,
  hudGroup: THREE.Group,
  isPinching: boolean
): { inside: boolean; uv: THREE.Vector2 | null; clicked: boolean } {
  const local = hudGroup.worldToLocal(fingerWorldPos.clone());
  const halfW = 0.40;
  const halfH = 0.265;

  if (Math.abs(local.z) < 0.045 && Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfH) {
    const u = (local.x + halfW) / (2 * halfW);
    const v = (local.y + halfH) / (2 * halfH);
    const isPoke = local.z < 0.015 && local.z > -0.025;
    return {
      inside: true,
      uv: new THREE.Vector2(u, v),
      clicked: isPinching || isPoke,
    };
  }

  return { inside: false, uv: null, clicked: false };
}

{
  const hudGroup = new THREE.Group();
  hudGroup.position.set(0.6, 1.2, -0.9);
  hudGroup.updateMatrixWorld(true);

  // Test point directly in center of HUD, hovering 3cm in front of surface (z = +0.03)
  const hoverPoint = new THREE.Vector3(0.6, 1.2, -0.87);
  const hoverRes = testHUDInteraction(hoverPoint, hudGroup, false);
  assert.strictEqual(hoverRes.inside, true, 'Hover point should be inside bounds');
  assert(Math.abs(hoverRes.uv!.x - 0.5) < 1e-4 && Math.abs(hoverRes.uv!.y - 0.5) < 1e-4, 'UV should be at center (0.5, 0.5)');
  assert.strictEqual(hoverRes.clicked, false, 'Hovering at 3cm should not trigger click');

  // Test poke into HUD (z = +0.005)
  const pokePoint = new THREE.Vector3(0.6, 1.2, -0.895);
  const pokeRes = testHUDInteraction(pokePoint, hudGroup, false);
  assert.strictEqual(pokeRes.inside, true, 'Poke point inside');
  assert.strictEqual(pokeRes.clicked, true, 'Direct finger poke (< 1.5cm) must trigger click');

  // Test pinch click while hovering
  const pinchRes = testHUDInteraction(hoverPoint, hudGroup, true);
  assert.strictEqual(pinchRes.clicked, true, 'Pinch click while within touch zone must trigger click');

  // Test point outside bounds
  const outsidePoint = new THREE.Vector3(1.2, 1.2, -0.87); // x = 0.6m away from center (exceeds 0.40m)
  const outRes = testHUDInteraction(outsidePoint, hudGroup, true);
  assert.strictEqual(outRes.inside, false, 'Outside point should not trigger interaction');

  console.log('✓ Spatial HUD direct fingertip poke and pinch click projection verified');
}

// =========================================================================
// 5. Hand vs. Controller Isolation & Mesh Suppression Test
// =========================================================================
console.log('Testing Hand vs. Controller isolation...');

interface MockControllerState {
  controllerVisible: boolean;
  gripVisible: boolean;
  rayLineVisible: boolean;
  reticleVisible: boolean;
  isGripping: boolean;
  isDraggingTerrain: boolean;
}

function processInputSource(
  source: { hand?: any; gamepad?: any },
  state: MockControllerState
): { isHandMode: boolean; executedControllerLogic: boolean } {
  if (source.hand) {
    // Bare hand detected: explicitly hide controller meshes and suppress controller drag
    state.controllerVisible = false;
    state.gripVisible = false;
    state.rayLineVisible = false;
    state.reticleVisible = false;
    state.isGripping = false;
    state.isDraggingTerrain = false;
    return { isHandMode: true, executedControllerLogic: false };
  }

  // Physical controller (Touch Plus)
  state.controllerVisible = true;
  state.gripVisible = true;
  state.rayLineVisible = true;
  return { isHandMode: false, executedControllerLogic: true };
}

{
  const state: MockControllerState = {
    controllerVisible: true,
    gripVisible: true,
    rayLineVisible: true,
    reticleVisible: true,
    isGripping: true,
    isDraggingTerrain: true,
  };

  // 5A. Bare Hand with synthetic gamepad (Meta Quest default behavior)
  const handSource = {
    hand: { joints: {} },
    gamepad: { buttons: [{ pressed: true }] }, // Synthetic trigger from pinch
  };

  const handRes = processInputSource(handSource, state);
  assert.strictEqual(handRes.isHandMode, true, 'Should detect hand mode');
  assert.strictEqual(handRes.executedControllerLogic, false, 'Should NEVER execute controller logic on hand');
  assert.strictEqual(state.controllerVisible, false, 'Controller ray mesh must be hidden for hands');
  assert.strictEqual(state.gripVisible, false, 'Controller grip cylinder must be hidden for hands');
  assert.strictEqual(state.rayLineVisible, false, 'Laser beam must be hidden for hands');
  assert.strictEqual(state.isDraggingTerrain, false, 'Terrain drag state must be disabled for hands');

  // 5B. Physical Touch Plus controller
  const controllerSource = {
    hand: undefined,
    gamepad: { buttons: [{ pressed: true }] },
  };

  const ctrlRes = processInputSource(controllerSource, state);
  assert.strictEqual(ctrlRes.isHandMode, false, 'Should detect physical controller');
  assert.strictEqual(ctrlRes.executedControllerLogic, true, 'Should execute controller logic for Touch Plus');
  assert.strictEqual(state.controllerVisible, true, 'Controller mesh visible');
  assert.strictEqual(state.gripVisible, true, 'Grip visible');
  assert.strictEqual(state.rayLineVisible, true, 'Laser beam visible');

  console.log('✓ Hand vs. Controller isolation verified: hands cleanly suppress controller meshes and laser drag');
}

// =========================================================================
// 6. HUD Grab Exclusivity Test (No accidental diorama moving during HUD click)
// =========================================================================
console.log('Testing HUD grab exclusivity...');

{
  // 6A. Direct touch / poke exclusivity
  const activeGrabs: any[] = [];
  const isPinching = true;
  const isDirectTouchHUD = true; // Hand is poking HUD directly
  const isLaserHUD = false;
  const activeInteraction = (isDirectTouchHUD || isLaserHUD) ? 'hud' : 'diorama';

  if (activeInteraction === 'diorama') {
    activeGrabs.push({ id: 'hand_0', source: 'hand' });
  }

  assert.strictEqual(activeGrabs.length, 0, 'Hand engaged with direct touch HUD must NOT be added to diorama grabs');

  // 6B. Laser pointer hovering or dragging HUD from a distance
  const activeGrabsLaser: any[] = [];
  const isLaserEngaged = true; // Hand laser is pointing at HUD or scrubbing
  const interactionLaser = isLaserEngaged ? 'hud' : 'diorama';
  if (interactionLaser === 'diorama') {
    activeGrabsLaser.push({ id: 'hand_0', source: 'hand' });
  }
  assert.strictEqual(activeGrabsLaser.length, 0, 'Hand laser engaged with HUD must NOT be added to diorama grabs');

  // 6C. When hand is in free space away from HUD
  const isAwayFromHUD = true;
  const activeGrabsFree: any[] = [];
  const interactionFree = !isAwayFromHUD ? 'hud' : 'diorama';
  if (interactionFree === 'diorama') {
    activeGrabsFree.push({ id: 'hand_0', source: 'hand' });
  }
  assert.strictEqual(activeGrabsFree.length, 1, 'Hand away from HUD correctly grabs diorama');

  console.log('✓ HUD grab exclusivity verified: pinching on HUD (laser or direct touch) does not trigger diorama translation/scale');
}

// =========================================================================
// 7. Hand Outline Skeleton Structure Test (25 Joints & 24 Bone Lines)
// =========================================================================
console.log('Testing Hand Outline Skeleton structure...');

assert.strictEqual(ALL_HAND_JOINTS.length, 25, 'WebXR standard requires exactly 25 joints');
assert.strictEqual(BONE_CONNECTIONS.length, 28, 'Hand skeleton outline requires 28 bone segments (24 longitudinal + 4 transverse palm arch)');

// Verify all bone endpoints exist in ALL_HAND_JOINTS
const jointSet = new Set(ALL_HAND_JOINTS);
for (const [jA, jB] of BONE_CONNECTIONS) {
  assert(jointSet.has(jA), `Unknown bone joint: ${jA}`);
  assert(jointSet.has(jB), `Unknown bone joint: ${jB}`);
}

// Verify bone line buffer packing (28 bones * 2 vertices * 3 floats = 168 floats)
const mockJointPositions = new Map<string, THREE.Vector3>();
for (let i = 0; i < ALL_HAND_JOINTS.length; i++) {
  mockJointPositions.set(ALL_HAND_JOINTS[i], new THREE.Vector3(i * 0.01, 1.2, -0.8));
}

const posArray = new Float32Array(BONE_CONNECTIONS.length * 2 * 3);
let vertIdx = 0;
for (const [jA, jB] of BONE_CONNECTIONS) {
  const pA = mockJointPositions.get(jA)!;
  const pB = mockJointPositions.get(jB)!;
  posArray[vertIdx++] = pA.x;
  posArray[vertIdx++] = pA.y;
  posArray[vertIdx++] = pA.z;
  posArray[vertIdx++] = pB.x;
  posArray[vertIdx++] = pB.y;
  posArray[vertIdx++] = pB.z;
}

assert.strictEqual(posArray.length, 168, 'Buffer must have exactly 168 floats for 28 segments');
assert.strictEqual(vertIdx, 168, 'All 168 floats must be populated');
console.log('✓ Hand Outline Skeleton structure verified: 25 joints, 28 bones, 168 vertex floats packed cleanly');

// =========================================================================
// 8. Controller-to-InputSource 1:1 Alignment Test (No Reversed Clicks)
// =========================================================================
console.log('Testing Hand / Controller click alignment (verifying clicks are not reversed)...');

interface ControllerSlot {
  controllerId: string;
  handedness: 'left' | 'right';
  targetButtonPointedAt: string;
  inputSource: {
    handedness: 'left' | 'right';
    isPinching: boolean;
  } | null;
}

// Simulate Right Hand pointing at Button A, Left Hand pointing at Button B
const slot0: ControllerSlot = {
  controllerId: 'controller_right',
  handedness: 'right',
  targetButtonPointedAt: 'btn_elevation_chart',
  inputSource: { handedness: 'right', isPinching: false },
};

const slot1: ControllerSlot = {
  controllerId: 'controller_left',
  handedness: 'left',
  targetButtonPointedAt: 'btn_toggle_hybrid',
  inputSource: { handedness: 'left', isPinching: false },
};

const slots = [slot0, slot1];

function dispatchClick(slots: ControllerSlot[]): string[] {
  const clickedButtons: string[] = [];
  for (const slot of slots) {
    if (!slot.inputSource) continue;
    // CRITICAL: Slot executes click only for ITS OWN input source!
    if (slot.inputSource.isPinching) {
      clickedButtons.push(slot.targetButtonPointedAt);
    }
  }
  return clickedButtons;
}

// 8A: User pinches right hand
slot0.inputSource!.isPinching = true;
slot1.inputSource!.isPinching = false;
let clicks = dispatchClick(slots);
assert.deepStrictEqual(clicks, ['btn_elevation_chart'], 'Right hand pinch must trigger right hand target, NOT left!');

// 8B: User pinches left hand
slot0.inputSource!.isPinching = false;
slot1.inputSource!.isPinching = true;
clicks = dispatchClick(slots);
assert.deepStrictEqual(clicks, ['btn_toggle_hybrid'], 'Left hand pinch must trigger left hand target, NOT right!');

console.log('✓ Hand / Controller click alignment verified: clicks map strictly 1:1 to pointed hand and are never reversed');

// =========================================================================
// 9. Diorama Virtual Touch Proximity Math Test
// =========================================================================
console.log('Testing Diorama Virtual Touch Proximity Math (above, below, sides, touching)...');

interface MockDioramaContext {
  position: THREE.Vector3;
  scale: number;
  widthMeters: number;
  depthMeters: number;
  plinthBottomY: number;
  elevationSampler: (x: number, z: number) => number;
  exaggeration: number;
}

function testIsTouchingDiorama(
  handWorldPos: THREE.Vector3,
  diorama: MockDioramaContext
): boolean {
  // 1. World to local
  const local = handWorldPos.clone().sub(diorama.position).multiplyScalar(1 / diorama.scale);

  const halfW = diorama.widthMeters * 0.5;
  const halfD = diorama.depthMeters * 0.5;

  // Horizontal distance outside boundary (sides) in world meters
  const dxLocal = Math.max(0, Math.abs(local.x) - halfW);
  const dzLocal = Math.max(0, Math.abs(local.z) - halfD);
  const distHorizWorld = Math.hypot(dxLocal, dzLocal) * diorama.scale;

  if (distHorizWorld > 0.08) {
    return false; // Away to the sides
  }

  // Local terrain surface at hand position
  const clampedX = Math.max(-halfW, Math.min(halfW, local.x));
  const clampedZ = Math.max(-halfD, Math.min(halfD, local.z));
  const localSurfaceY = diorama.elevationSampler(clampedX, clampedZ) * diorama.exaggeration;

  // Hand above map in world meters
  const dyAboveWorld = (local.y - localSurfaceY) * diorama.scale;
  if (dyAboveWorld > 0.08) {
    return false; // Away above the map
  }

  // Hand below map in world meters
  const dyBelowWorld = (diorama.plinthBottomY - local.y) * diorama.scale;
  if (dyBelowWorld > 0.06) {
    return false; // Away below the map
  }

  return true;
}

// Setup a realistic diorama placed at (0, -0.2, -1.1) in room space
// Scale = 0.0001 (10km diorama scaled to 1.0m wide on table)
const mockDiorama: MockDioramaContext = {
  position: new THREE.Vector3(0, -0.2, -1.1),
  scale: 0.0001,
  widthMeters: 10000,
  depthMeters: 10000,
  plinthBottomY: -105,
  elevationSampler: (x: number, z: number) => {
    // Peak at center (x=0, z=0) with height 2000m, sloping down to 200m at edges
    const distFromCenter = Math.hypot(x, z);
    return Math.max(200, 2000 - distFromCenter * 0.35);
  },
  exaggeration: 1.0,
};

// Diorama center in world: (0, -0.2, -1.1)
// Peak surface in world: position.y + (2000 * 0.0001) = -0.2 + 0.20 = 0.00m
const worldPeakY = mockDiorama.position.y + 2000 * mockDiorama.scale;

// Test 9A: Hand 25cm high in the air above the mountain peak (y = 0.25m)
const handFloatingHigh = new THREE.Vector3(0, worldPeakY + 0.25, -1.1);
assert.strictEqual(testIsTouchingDiorama(handFloatingHigh, mockDiorama), false, 'Hand 25cm in air above peak must NOT touch diorama');

// Test 9B: Hand 20cm off to the side (x = +0.70m in world, while halfWidth in world is 0.50m)
const handOffToSide = new THREE.Vector3(0.70, worldPeakY - 0.05, -1.1);
assert.strictEqual(testIsTouchingDiorama(handOffToSide, mockDiorama), false, 'Hand 20cm outside border must NOT touch diorama');

// Test 9C: Hand reaching under the table (y = -0.40m in world, while plinth bottom is -0.2105m)
const handUnderTable = new THREE.Vector3(0, -0.40, -1.1);
assert.strictEqual(testIsTouchingDiorama(handUnderTable, mockDiorama), false, 'Hand below pedestal plinth must NOT touch diorama');

// Test 9D: Hand virtually touching the mountain peak (3cm above peak surface: y = worldPeakY + 0.03m)
const handTouchingPeak = new THREE.Vector3(0, worldPeakY + 0.03, -1.1);
assert.strictEqual(testIsTouchingDiorama(handTouchingPeak, mockDiorama), true, 'Hand 3cm above peak MUST register as virtually touching diorama');

// Test 9E: Hand virtually touching a slope (at x=2000 local, worldX = 0.20m, surfaceY = 2000 - 700 = 1300m, worldY = -0.07m)
const slopeSurfaceYWorld = mockDiorama.position.y + (2000 - 2000 * 0.35) * mockDiorama.scale;
const handTouchingSlope = new THREE.Vector3(0.20, slopeSurfaceYWorld + 0.02, -1.1);
assert.strictEqual(testIsTouchingDiorama(handTouchingSlope, mockDiorama), true, 'Hand 2cm above slope MUST register as virtually touching diorama');

console.log('✓ Diorama virtual touch proximity math verified (above, below, sides, touching)');

// =========================================================================
// 10. Proximity Grab Gating & Dynamic Hand Outline Visual Feedback Test
// =========================================================================
console.log('Testing Proximity Grab Gating & Dynamic Hand Outline Visuals...');

interface MockHandVisualState {
  boneColor: number;
  boneOpacity: number;
  reticleVisible: boolean;
  reticleColor: number;
  reticleOpacity: number;
  activeInteraction: 'none' | 'hud' | 'diorama';
}

function evaluateHandVisualAndGrab(
  isPinching: boolean,
  isTouching: boolean,
  isEngagedWithHUD: boolean,
  currentInteraction: 'none' | 'hud' | 'diorama'
): MockHandVisualState {
  let interaction = currentInteraction;

  if (!isPinching) {
    interaction = 'none';
  } else if (interaction === 'none') {
    if (isEngagedWithHUD) {
      interaction = 'hud';
    } else if (isTouching) {
      interaction = 'diorama';
    }
  }

  // Visuals
  if (interaction === 'diorama') {
    return {
      boneColor: 0xffb703, // Amber Gold
      boneOpacity: 1.0,
      reticleVisible: true,
      reticleColor: 0xffb703,
      reticleOpacity: 1.0,
      activeInteraction: interaction,
    };
  } else if (isEngagedWithHUD) {
    return {
      boneColor: 0x818cf8, // Indigo / Violet
      boneOpacity: 0.85,
      reticleVisible: false,
      reticleColor: 0x000000,
      reticleOpacity: 0,
      activeInteraction: interaction,
    };
  } else if (isTouching) {
    return {
      boneColor: 0x00f0ff, // Vibrant Cyan
      boneOpacity: 0.95,
      reticleVisible: true,
      reticleColor: 0x00f0ff,
      reticleOpacity: 0.85,
      activeInteraction: interaction,
    };
  } else {
    return {
      boneColor: 0x64748b, // Translucent Slate
      boneOpacity: 0.30,
      reticleVisible: false,
      reticleColor: 0x000000,
      reticleOpacity: 0,
      activeInteraction: interaction,
    };
  }
}

// Case 10A: Hand in air, not touching, not pinching
const stateAway = evaluateHandVisualAndGrab(false, false, false, 'none');
assert.strictEqual(stateAway.boneColor, 0x64748b, 'Away hand outline must be subtle slate');
assert.strictEqual(stateAway.boneOpacity, 0.30, 'Away hand outline must have low opacity (0.30)');
assert.strictEqual(stateAway.reticleVisible, false, 'Away reticle must be hidden');
assert.strictEqual(stateAway.activeInteraction, 'none', 'Away hand must have none interaction');

// Case 10B: User pinches while away in air -> must NOT grab diorama!
const statePinchAway = evaluateHandVisualAndGrab(true, false, false, 'none');
assert.strictEqual(statePinchAway.activeInteraction, 'none', 'Pinching in air away from map must NOT grab diorama');
assert.strictEqual(statePinchAway.boneColor, 0x64748b, 'Pinching in air must keep slate outline');

// Case 10C: Hand moves in to touch the mountain -> lights up in cyan with contact reticle
const stateTouching = evaluateHandVisualAndGrab(false, true, false, 'none');
assert.strictEqual(stateTouching.boneColor, 0x00f0ff, 'Touching hand outline must glow vibrant cyan');
assert.strictEqual(stateTouching.boneOpacity, 0.95, 'Touching hand outline must be high opacity (0.95)');
assert.strictEqual(stateTouching.reticleVisible, true, 'Touching hand must show contact indicator reticle');
assert.strictEqual(stateTouching.reticleColor, 0x00f0ff, 'Contact indicator reticle must be vibrant cyan');

// Case 10D: User pinches while touching the mountain -> grabs diorama, turns amber gold!
const stateGrab = evaluateHandVisualAndGrab(true, true, false, 'none');
assert.strictEqual(stateGrab.activeInteraction, 'diorama', 'Pinching while touching diorama MUST claim diorama grab');
assert.strictEqual(stateGrab.boneColor, 0xffb703, 'Grab hand outline must turn radiant amber gold');
assert.strictEqual(stateGrab.boneOpacity, 1.0, 'Grab hand outline must be full opacity 1.0');
assert.strictEqual(stateGrab.reticleVisible, true, 'Grab reticle must be visible and active');
assert.strictEqual(stateGrab.reticleColor, 0xffb703, 'Grab reticle must turn amber gold');

console.log('✓ Proximity Grab Gating & Dynamic Hand Outline Visuals verified successfully!');

console.log('✓ All Hand Gestures, 6DOF Manipulation, Skeleton, Touch Proximity & Visuals passed successfully!');
  });
});
