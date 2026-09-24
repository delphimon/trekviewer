import * as THREE from 'three';

export interface VisualRouteOptions {
  resampleStepMeters?: number;
  spikeThresholdMeters?: number;
  smoothingWindowMeters?: number;
  maxLateralDeviationMeters?: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/**
 * 2D distance in X/Z plane.
 */
export function distanceXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/**
 * Resamples a path evenly in the horizontal X/Z plane at approximately stepMeters spacing.
 * Preserves the exact start and end points.
 */
export function resamplePathXZ(
  points: THREE.Vector3[],
  stepMeters: number = 7.0
): THREE.Vector3[] {
  if (points.length <= 2) return points.map((p) => p.clone());

  const result: THREE.Vector3[] = [points[0].clone()];
  let accumulatedDist = 0;
  let targetDist = stepMeters;

  // Compute segment lengths
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const segDist = distanceXZ(p0, p1);
    if (segDist < 1e-4) continue;

    while (accumulatedDist + segDist >= targetDist) {
      const t = (targetDist - accumulatedDist) / segDist;
      result.push(
        new THREE.Vector3(
          p0.x + t * (p1.x - p0.x),
          p0.y + t * (p1.y - p0.y),
          p0.z + t * (p1.z - p0.z)
        )
      );
      targetDist += stepMeters;
    }

    accumulatedDist += segDist;
  }

  // Always append exact last point if not coincident
  const lastPoint = points[points.length - 1];
  if (distanceXZ(result[result.length - 1], lastPoint) > 0.5) {
    result.push(new THREE.Vector3(lastPoint.x, lastPoint.y, lastPoint.z));
  } else {
    result[result.length - 1].x = lastPoint.x;
    result[result.length - 1].y = lastPoint.y;
    result[result.length - 1].z = lastPoint.z;
  }

  return result;
}

/**
 * Detects and suppresses isolated lateral GPS spikes without altering legitimate switchbacks.
 * An isolated spike is a single point that darts sideways by > spikeThresholdMeters and immediately
 * returns to the previous heading, whereas a real switchback continues along the new heading.
 */
export function filterGPSSpikesXZ(
  points: THREE.Vector3[],
  spikeThresholdMeters: number = 14.0
): THREE.Vector3[] {
  if (points.length < 4) return points.map((p) => p.clone());

  const result: THREE.Vector3[] = points.map((p) => p.clone());

  for (let i = 1; i < result.length - 2; i++) {
    const prev = result[i - 1];
    const cur = result[i];
    const next = result[i + 1];
    const nextNext = result[i + 2];

    const chordLen = distanceXZ(prev, next);
    if (chordLen < 1e-4) continue;

    // Perpendicular distance of cur from chord prev->next
    const chordX = next.x - prev.x;
    const chordZ = next.z - prev.z;
    const cross = (cur.x - prev.x) * chordZ - (cur.z - prev.z) * chordX;
    const perpDist = Math.abs(cross) / chordLen;

    // Angle of incoming vector vs outgoing vector
    const inX = cur.x - prev.x;
    const inZ = cur.z - prev.z;
    const outX = next.x - cur.x;
    const outZ = next.z - cur.z;
    const inLen = Math.hypot(inX, inZ);
    const outLen = Math.hypot(outX, outZ);

    if (inLen < 1e-4 || outLen < 1e-4) continue;

    const dotInOut = (inX * outX + inZ * outZ) / (inLen * outLen);

    // If cur jumps sideways significantly and reverses sharply (dotInOut < -0.3)
    if (perpDist > spikeThresholdMeters && dotInOut < -0.3) {
      // Check if subsequent segment continues in the direction of the chord
      const nextNextX = nextNext.x - next.x;
      const nextNextZ = nextNext.z - next.z;
      const nextNextLen = Math.hypot(nextNextX, nextNextZ);

      let isSwitchback = false;
      if (nextNextLen > 1e-4) {
        // Dot product of out vector and nextNext vector
        const dotNext = (outX * nextNextX + outZ * nextNextZ) / (outLen * nextNextLen);
        if (dotNext > 0.4) {
          // Path continues in the new direction; this is a genuine switchback!
          isSwitchback = true;
        }
      }

      if (!isSwitchback) {
        // Isolated spike: clamp to midpoint of adjacent samples
        cur.x = (prev.x + next.x) * 0.5;
        cur.y = (prev.y + next.y) * 0.5;
        cur.z = (prev.z + next.z) * 0.5;
      }
    }
  }

  return result;
}

/**
 * Applies gentle distance-windowed horizontal smoothing in X/Z while strictly enforcing
 * maximum lateral deviation corridor and preserving switchback apexes and endpoints.
 */
export function smoothPathXZ(
  points: THREE.Vector3[],
  windowMeters: number = 20.0,
  maxLateralDeviationMeters: number = 5.0
): THREE.Vector3[] {
  if (points.length <= 2) return points.map((p) => p.clone());

  const result: THREE.Vector3[] = [];
  const n = points.length;

  // Compute cumulative distance along input points
  const cumDist = new Float64Array(n);
  cumDist[0] = 0;
  for (let i = 1; i < n; i++) {
    cumDist[i] = cumDist[i - 1] + distanceXZ(points[i - 1], points[i]);
  }

  const halfWin = windowMeters * 0.5;

  for (let i = 0; i < n; i++) {
    // Preserve exact start and end anchors
    if (i === 0 || i === n - 1) {
      result.push(points[i].clone());
      continue;
    }

    const orig = points[i];

    // Detect sharp heading changes (switchback apexes)
    const prev = points[i - 1];
    const next = points[i + 1];
    const inX = orig.x - prev.x;
    const inZ = orig.z - prev.z;
    const outX = next.x - orig.x;
    const outZ = next.z - orig.z;
    const inLen = Math.hypot(inX, inZ);
    const outLen = Math.hypot(outX, outZ);

    let isSharpApex = false;
    if (inLen > 1e-4 && outLen > 1e-4) {
      const cosAngle = (inX * outX + inZ * outZ) / (inLen * outLen);
      // Angle > 85 degrees (cosAngle < 0.08) represents a sharp switchback
      if (cosAngle < 0.08) {
        isSharpApex = true;
      }
    }

    // Preserve switchback apexes without smoothing them away
    if (isSharpApex) {
      result.push(orig.clone());
      continue;
    }

    // Distance-weighted moving average
    const curD = cumDist[i];
    let sumW = 0;
    let sumX = 0;
    let sumZ = 0;

    // Search backward
    for (let j = i; j >= 0; j--) {
      const d = Math.abs(curD - cumDist[j]);
      if (d > halfWin) break;
      const w = 1.0 - d / halfWin;
      sumW += w;
      sumX += points[j].x * w;
      sumZ += points[j].z * w;
    }

    // Search forward
    for (let j = i + 1; j < n; j++) {
      const d = Math.abs(cumDist[j] - curD);
      if (d > halfWin) break;
      const w = 1.0 - d / halfWin;
      sumW += w;
      sumX += points[j].x * w;
      sumZ += points[j].z * w;
    }

    let smoothX = sumW > 1e-5 ? sumX / sumW : orig.x;
    let smoothZ = sumW > 1e-5 ? sumZ / sumW : orig.z;

    // Enforce maximum lateral corridor: clamp deviation from recorded point
    const dev = Math.hypot(smoothX - orig.x, smoothZ - orig.z);
    if (dev > maxLateralDeviationMeters) {
      const ratio = maxLateralDeviationMeters / dev;
      smoothX = orig.x + (smoothX - orig.x) * ratio;
      smoothZ = orig.z + (smoothZ - orig.z) * ratio;
    }

    result.push(new THREE.Vector3(smoothX, orig.y, smoothZ));
  }

  return result;
}

/**
 * Builds the complete visual route representation for a segment:
 * 1. Resample segment at 7m spacing in X/Z.
 * 2. Reject isolated lateral GPS spikes while preserving real switchbacks.
 * 3. Smooth horizontally within 20m window, clamped to max 5m lateral deviation.
 * 4. Generate centripetal Catmull-Rom curve in X/Z.
 */
export function generateVisualRouteCurve(
  groundPoints: THREE.Vector3[],
  options?: VisualRouteOptions
): {
  visualPoints: THREE.Vector3[];
  curve: THREE.CatmullRomCurve3;
} {
  if (groundPoints.length < 2) {
    const fallback = groundPoints.length === 1 ? [groundPoints[0], groundPoints[0]] : [new THREE.Vector3(), new THREE.Vector3(0, 0, 1)];
    return {
      visualPoints: fallback,
      curve: new THREE.CatmullRomCurve3(fallback, false, 'centripetal'),
    };
  }

  const resampleStep = options?.resampleStepMeters ?? 7.0;
  const spikeThreshold = options?.spikeThresholdMeters ?? 14.0;
  const smoothWindow = options?.smoothingWindowMeters ?? 20.0;
  const maxLateralDev = options?.maxLateralDeviationMeters ?? 5.0;

  // Step 1: Resample path in X/Z
  const resampled = resamplePathXZ(groundPoints, resampleStep);

  // Step 2: Filter isolated GPS spikes
  const debiased = filterGPSSpikesXZ(resampled, spikeThreshold);

  // Step 3: Gentle horizontal smoothing with anchor preservation and corridor clamping
  const smoothed = smoothPathXZ(debiased, smoothWindow, maxLateralDev);

  // Step 4: Centripetal Catmull-Rom curve in X/Z (prevents overshoot on switchbacks)
  const curve = new THREE.CatmullRomCurve3(smoothed, false, 'centripetal');

  return {
    visualPoints: smoothed,
    curve,
  };
}
