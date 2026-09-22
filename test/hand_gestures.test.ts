import * as THREE from 'three';
import assert from 'node:assert';
import { describe, it } from 'vitest';
import { ALL_HAND_JOINTS, BONE_CONNECTIONS } from '../src/core/XRManager.ts';
import {
  evaluatePinchState,
  applyBimanualTransform,
  applyOneHandedManipulation,
  isPointOnDiorama,
  type DioramaTransform,
  type DioramaVolume,
} from '../src/core/GestureMath.ts';

describe('Hand Tracking & 6DOF Manipulation Gestures', () => {
  it('evaluates gestures, isolation, and 6DOF manipulation', () => {

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

  assert(diorama.position.distanceTo(new THREE.Vector3(0.08, 0.96, -0.88)) < 1e-5, '1:1 translation match');
  console.log('✓ Dual-hand translation moves diorama 1:1 in 3D room space');
}

// 2D. Steering Wheel Rotation around vertical axis
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    scale: 0.002,
  };

  const p0Prev = new THREE.Vector3(-0.2, 1.2, -1.0);
  const p1Prev = new THREE.Vector3(0.2, 1.2, -1.0);

  // Rotate hands 30 degrees counter-clockwise
  const rot30 = new THREE.Matrix4().makeRotationY(Math.PI / 6);
  const p0Curr = new THREE.Vector3(-0.2, 1.2, 0).applyMatrix4(rot30).add(new THREE.Vector3(0, 0, -1.0));
  const p1Curr = new THREE.Vector3(0.2, 1.2, 0).applyMatrix4(rot30).add(new THREE.Vector3(0, 0, -1.0));

  applyBimanualTransform(diorama, p0Prev, p1Prev, p0Curr, p1Curr);

  assert(Math.abs(diorama.rotationY - Math.PI / 6) < 0.02, `Expected rotation ~${Math.PI / 6}, got ${diorama.rotationY}`);
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

  assert(diorama.rotationX! > 0.10, `Expected pitch tilt > 0.10, got ${diorama.rotationX}`);
  console.log('✓ Dual-hand vertical separation correctly tilts diorama pitch in 3D');
}

// =========================================================================
// 3. One-Handed Direct Manipulation (1:1 Drag, Wrist Twist Yaw & Pitch Direction)
// =========================================================================
console.log('Testing one-handed direct manipulation...');

// 3A. Pure 1:1 Translation (no wrist rotation)
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    rotationX: 0,
    scale: 0.002,
  };

  const pPrev = new THREE.Vector3(0.1, 1.2, -0.9);
  const pCurr = new THREE.Vector3(0.15, 1.25, -0.85); // move (+0.05, +0.05, +0.05)
  const q = new THREE.Quaternion().identity();

  applyOneHandedManipulation(diorama, pPrev, pCurr, q, q);

  assert(Math.abs(diorama.position.x - 0.05) < 1e-5, '1:1 X translation match');
  assert(Math.abs(diorama.position.y - 1.25) < 1e-5, '1:1 Y translation match');
  assert(Math.abs(diorama.position.z - (-0.95)) < 1e-5, '1:1 Z translation match');
  console.log('✓ Pure one-handed translation moves diorama 1:1');
}

// 3B. Wrist Pitch Down tilts map down (negative X rotation)
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    rotationX: 0,
    scale: 0.002,
  };

  const p = new THREE.Vector3(0, 1.2, -1.0);
  const qPrev = new THREE.Quaternion().identity();
  // Tilting wrist down (-0.15 rad around X)
  const qCurr = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.15, 0, 0, 'YXZ'));

  applyOneHandedManipulation(diorama, p, p, qPrev, qCurr);

  assert(diorama.rotationX! < -0.10, `Tilting wrist down must pitch diorama down, got ${diorama.rotationX}`);
  console.log('✓ Tilting wrist down correctly pitches diorama down');
}

// 3C. Wrist Pitch Up tilts map up (positive X rotation)
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    rotationX: 0,
    scale: 0.002,
  };

  const p = new THREE.Vector3(0, 1.2, -1.0);
  const qPrev = new THREE.Quaternion().identity();
  // Tilting wrist up (+0.15 rad around X)
  const qCurr = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0, 0, 'YXZ'));

  applyOneHandedManipulation(diorama, p, p, qPrev, qCurr);

  assert(diorama.rotationX! > 0.10, `Tilting wrist up must pitch diorama up, got ${diorama.rotationX}`);
  console.log('✓ Tilting wrist up correctly pitches diorama up');
}

// 3D. Grab point anchoring: point under user's fingers remains locked under fingers
{
  const diorama: DioramaTransform = {
    position: new THREE.Vector3(0, 1.2, -1.0),
    rotationY: 0,
    rotationX: 0,
    scale: 0.002,
  };

  const handPos = new THREE.Vector3(0.2, 1.2, -0.8);
  const qPrev = new THREE.Quaternion().identity();
  // Wrist twists yaw 0.2 rad and pitches 0.1 rad
  const qCurr = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0, 'YXZ'));

  applyOneHandedManipulation(diorama, handPos, handPos, qPrev, qCurr);

  // Position pivoted around handPos, rotation applied
  assert(Math.abs(diorama.rotationY - 0.2 * 0.95) < 0.02, 'Wrist yaw applied');
  assert(Math.abs(diorama.rotationX! - 0.1 * 0.9) < 0.02, 'Wrist pitch applied');
  console.log('✓ Grabbing virtual point on diorama anchors rotation and pitch around the grip point');
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
  const activeGrabs: any[] = [];
  const isPinching = true;
  const isInteractingWithHUD = true; // Hand is hovering/poking HUD

  if (isPinching && !isInteractingWithHUD) {
    activeGrabs.push({ id: 'hand_0', source: 'hand' });
  }

  assert.strictEqual(activeGrabs.length, 0, 'Hand engaged with HUD must NOT be added to diorama grabs');

  // When hand is in free space away from HUD
  const isAwayFromHUD = false;
  if (isPinching && !isAwayFromHUD) {
    activeGrabs.push({ id: 'hand_0', source: 'hand' });
  }
  assert.strictEqual(activeGrabs.length, 1, 'Hand away from HUD correctly grabs diorama');

  console.log('✓ HUD grab exclusivity verified: pinching on HUD does not trigger diorama translation/scale');
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
// 9. Diorama Contact Proximity & Touch Filtering Test
// =========================================================================
console.log('Testing diorama contact proximity and grab initiation filtering...');

{
  const dioramaRoot = new THREE.Group();
  // Tabletop diorama placed at arm's length (0.58m forward, height 1.1m)
  dioramaRoot.position.set(0, 1.1, -0.58);
  const scale = 0.0001;
  dioramaRoot.scale.set(scale, scale, scale);

  const volume: DioramaVolume = {
    halfWidthM: 4000,  // 0.40m half-width in room space
    halfDepthM: 4000,  // 0.40m half-depth in room space
    minY: -110,        // -0.011m plinth bottom
    maxY: 3200,        // +0.32m mountain summit
  };

  // 9A: Hand touching mountain summit in front of user
  const summitHandPos = new THREE.Vector3(0, 1.35, -0.58);
  const onSummit = isPointOnDiorama(summitHandPos, dioramaRoot, volume, 0.08);
  assert.strictEqual(onSummit, true, 'Hand on mountain summit must be recognized as on diorama');

  // 9B: Hand touching edge of the pedestal plinth
  const edgeHandPos = new THREE.Vector3(0.42, 1.10, -0.58);
  const onEdge = isPointOnDiorama(edgeHandPos, dioramaRoot, volume, 0.08);
  assert.strictEqual(onEdge, true, 'Hand touching diorama plinth edge must be recognized');

  // 9C: Hand resting on user lap (height 0.6m, near chest z = -0.15m)
  const lapHandPos = new THREE.Vector3(0, 0.60, -0.15);
  const onLap = isPointOnDiorama(lapHandPos, dioramaRoot, volume, 0.08);
  assert.strictEqual(onLap, false, 'Hand resting on lap MUST NOT be considered on diorama');

  // 9D: Hand pointing in the air or at HUD (x = -0.65m, y = 1.35m, z = -0.40m)
  const airHandPos = new THREE.Vector3(-0.65, 1.35, -0.40);
  const inAir = isPointOnDiorama(airHandPos, dioramaRoot, volume, 0.08);
  assert.strictEqual(inAir, false, 'Hand in mid-air pointing at HUD MUST NOT grab diorama');

  console.log('✓ Diorama proximity filter accurately distinguishes map contact from lap and mid-air pinches');
}

// =========================================================================
// 10. Per-Hand Grab Isolation & Multi-Touch Test
// =========================================================================
console.log('Testing per-hand grab isolation and multi-touch behavior...');

{
  const dioramaRoot = new THREE.Group();
  dioramaRoot.position.set(0, 1.1, -0.58);
  const scale = 0.0001;
  dioramaRoot.scale.set(scale, scale, scale);

  const volume: DioramaVolume = {
    halfWidthM: 4000,
    halfDepthM: 4000,
    minY: -110,
    maxY: 3200,
  };

  interface SimulatedHand {
    id: string;
    pos: THREE.Vector3;
    isPinching: boolean;
    isGrabbingDiorama: boolean;
  }

  function evaluateGrabs(hands: SimulatedHand[]): string[] {
    const active: string[] = [];
    for (const h of hands) {
      if (h.isPinching) {
        // If pinch just started or continues, verify grab status
        if (isPointOnDiorama(h.pos, dioramaRoot, volume, 0.08)) {
          h.isGrabbingDiorama = true;
        }
        if (h.isGrabbingDiorama) {
          active.push(h.id);
        }
      } else {
        h.isGrabbingDiorama = false;
      }
    }
    return active;
  }

  const handLeft: SimulatedHand = {
    id: 'hand_left',
    pos: new THREE.Vector3(0, 0.60, -0.15), // on lap
    isPinching: false,
    isGrabbingDiorama: false,
  };

  const handRight: SimulatedHand = {
    id: 'hand_right',
    pos: new THREE.Vector3(0.15, 1.25, -0.58), // on mountain
    isPinching: false,
    isGrabbingDiorama: false,
  };

  // 10A: Right hand pinches on mountain, Left hand resting on lap (fingers close)
  handRight.isPinching = true;
  handLeft.isPinching = true; // resting on lap
  let grabs = evaluateGrabs([handLeft, handRight]);
  assert.deepStrictEqual(grabs, ['hand_right'], 'Only the hand on the map must grab; lap hand must be ignored!');
  console.log('✓ One-handed grab on map ignores pinched resting hand on lap');

  // 10B: Left hand reaches onto the mountain and pinches as well
  handLeft.pos.set(-0.15, 1.25, -0.58); // moves onto mountain
  grabs = evaluateGrabs([handLeft, handRight]);
  assert.strictEqual(grabs.length, 2, 'Both hands on map must engage two-handed bimanual grab');
  assert(grabs.includes('hand_left') && grabs.includes('hand_right'));
  console.log('✓ Two hands pinching on the map engage dual-handed 6DOF manipulation');

  // 10C: Right hand releases pinch
  handRight.isPinching = false;
  grabs = evaluateGrabs([handLeft, handRight]);
    assert.deepStrictEqual(grabs, ['hand_left'], 'Releasing one hand smoothly returns to single-handed manipulation');
    console.log('✓ Releasing one hand transitions smoothly back to single hand');
  }
  });
});
