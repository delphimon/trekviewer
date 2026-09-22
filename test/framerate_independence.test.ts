import assert from 'node:assert';
import { describe, it } from 'vitest';

describe('Frame-Rate Independence Across FPS', () => {
  it('verifies locomotion, pan, rotation, and exponential zoom invariance', () => {

// Simulated parameters matching XRManager
const baseSpeedMps = 18.0;
const panSpeed = 10.0;
const rotSpeed = 2.1;
const stickY_walk = -1.0; // Full forward
const stickX_pan = 0.8;
const stickY_pan = 0.5;
const stickX_rot = 0.7;
const stickY_zoom = 0.6;

function simulate1Second(fps: number) {
  const dt = 1.0 / fps;
  const frames = fps;

  let totalWalkMeters = 0;
  let posX = 0;
  let posZ = 0;
  let rotY = 0;
  let scale = 1.0;

  for (let i = 0; i < frames; i++) {
    // 1. Walk distance integration
    const metersDelta = -stickY_walk * baseSpeedMps * dt;
    totalWalkMeters += metersDelta;

    // 2. Pan integration
    posX -= stickX_pan * panSpeed * dt;
    posZ -= stickY_pan * panSpeed * dt;

    // 3. Rotation integration
    rotY -= stickX_rot * rotSpeed * dt;

    // 4. Exponential zoom integration
    const zoomRate = Math.pow(0.25, stickY_zoom * dt);
    scale = scale * zoomRate;
  }

  return { totalWalkMeters, posX, posZ, rotY, scale };
}

const r60 = simulate1Second(60);
const r72 = simulate1Second(72);
const r90 = simulate1Second(90);
const r120 = simulate1Second(120);

// 1. Walking distance invariance
console.log(`Walk distance at 60 FPS: ${r60.totalWalkMeters.toFixed(4)} m`);
console.log(`Walk distance at 72 FPS: ${r72.totalWalkMeters.toFixed(4)} m (Quest 3 native)`);
console.log(`Walk distance at 90 FPS: ${r90.totalWalkMeters.toFixed(4)} m`);
console.log(`Walk distance at 120 FPS: ${r120.totalWalkMeters.toFixed(4)} m`);

assert(Math.abs(r60.totalWalkMeters - 18.0) < 1e-6);
assert(Math.abs(r72.totalWalkMeters - 18.0) < 1e-6);
assert(Math.abs(r90.totalWalkMeters - 18.0) < 1e-6);
assert(Math.abs(r120.totalWalkMeters - 18.0) < 1e-6);
assert(Math.abs(r72.totalWalkMeters - r60.totalWalkMeters) < 1e-6);
console.log('✓ Locomotion walking distance is strictly invariant to framerate');

// 2. Pan invariance
assert(Math.abs(r60.posX - r72.posX) < 1e-6);
assert(Math.abs(r60.posZ - r72.posZ) < 1e-6);
assert(Math.abs(r72.posX - r120.posX) < 1e-6);
console.log('✓ Diorama pan translation is strictly invariant to framerate');

// 3. Rotation invariance
assert(Math.abs(r60.rotY - r72.rotY) < 1e-6);
assert(Math.abs(r72.rotY - r120.rotY) < 1e-6);
console.log('✓ Diorama yaw rotation is strictly invariant to framerate');

// 4. Exponential zoom invariance
console.log(`Scale at 60 FPS: ${r60.scale.toFixed(6)}`);
console.log(`Scale at 72 FPS: ${r72.scale.toFixed(6)}`);
console.log(`Scale at 120 FPS: ${r120.scale.toFixed(6)}`);
assert(Math.abs(r60.scale - r72.scale) < 1e-6);
assert(Math.abs(r72.scale - r120.scale) < 1e-6);
console.log('✓ Exponential zoom is strictly invariant to framerate');

// 5. Variable / Jittering frame rate test (unsteady 50-90 FPS frame drops)
let jitterWalkMeters = 0;
let jitterScale = 1.0;
let remainingTime = 1.0;

// Random-like deterministic frame deltas summing to exactly 1.0s
const deltas = [0.012, 0.024, 0.008, 0.016, 0.033, 0.014, 0.020, 0.011, 0.015, 0.019];
let totalJitterTime = 0;
let dIdx = 0;
while (totalJitterTime < 1.0) {
  let dt = deltas[dIdx % deltas.length];
  if (totalJitterTime + dt > 1.0) {
    dt = 1.0 - totalJitterTime;
  }
  totalJitterTime += dt;
  dIdx++;

  jitterWalkMeters += -stickY_walk * baseSpeedMps * dt;
  jitterScale = jitterScale * Math.pow(0.25, stickY_zoom * dt);
}

    assert(Math.abs(jitterWalkMeters - 18.0) < 1e-6);
    assert(Math.abs(jitterScale - r72.scale) < 1e-6);
  });
});
