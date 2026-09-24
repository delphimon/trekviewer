import * as THREE from 'three';

export interface VisualRouteOptions {
  resampleStepMeters?: number;
  spikeThresholdMeters?: number;
  smoothingWindowMeters?: number;
  maxLateralDeviationMeters?: number;
}

export interface VisualRouteStation {
  routeDistance: number;
  x: number;
  z: number;
  groundY: number;
  forwardX: number;
  forwardZ: number;
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
 * Preserves the exact start and end points with y = 0 (Section 22).
 */
export function resamplePathXZ(
  points: THREE.Vector3[],
  stepMeters: number = 7.0
): THREE.Vector3[] {
  if (points.length <= 2) return points.map((p) => new THREE.Vector3(p.x, 0, p.z));

  const result: THREE.Vector3[] = [new THREE.Vector3(points[0].x, 0, points[0].z)];
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
          0,
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
    result.push(new THREE.Vector3(lastPoint.x, 0, lastPoint.z));
  } else {
    result[result.length - 1].x = lastPoint.x;
    result[result.length - 1].y = 0;
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
  if (points.length < 4) return points.map((p) => new THREE.Vector3(p.x, 0, p.z));

  const result: THREE.Vector3[] = points.map((p) => new THREE.Vector3(p.x, 0, p.z));

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
        cur.y = 0;
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
  if (points.length <= 2) return points.map((p) => new THREE.Vector3(p.x, 0, p.z));

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
      result.push(new THREE.Vector3(points[i].x, 0, points[i].z));
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
      result.push(new THREE.Vector3(orig.x, 0, orig.z));
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

    result.push(new THREE.Vector3(smoothX, 0, smoothZ));
  }

  return result;
}

/**
 * Builds the complete visual route representation for a segment:
 * 1. Resample segment at 7m spacing in X/Z with y = 0.
 * 2. Reject isolated lateral GPS spikes while preserving real switchbacks.
 * 3. Smooth horizontally within 20m window, clamped to max 5m lateral deviation.
 * 4. Generate centripetal Catmull-Rom curve in purely horizontal X/Z (Section 22).
 */
export function generateVisualRouteCurve(
  groundPoints: THREE.Vector3[],
  options?: VisualRouteOptions
): {
  visualPoints: THREE.Vector3[];
  curve: THREE.CatmullRomCurve3;
} {
  const horizontalPoints = groundPoints.map((p) => new THREE.Vector3(p.x, 0, p.z));

  if (horizontalPoints.length < 2) {
    const fallback = horizontalPoints.length === 1
      ? [horizontalPoints[0], horizontalPoints[0]]
      : [new THREE.Vector3(), new THREE.Vector3(0, 0, -1)];
    return {
      visualPoints: fallback,
      curve: new THREE.CatmullRomCurve3(fallback, false, 'centripetal'),
    };
  }

  const resampleStep = options?.resampleStepMeters ?? 7.0;
  const spikeThreshold = options?.spikeThresholdMeters ?? 14.0;
  const smoothWindow = options?.smoothingWindowMeters ?? 20.0;
  const maxLateralDev = options?.maxLateralDeviationMeters ?? 5.0;

  // Step 1: Resample path in X/Z (y=0)
  const resampled = resamplePathXZ(horizontalPoints, resampleStep);

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

/**
 * Generates distance-indexed visual route stations in route-distance order (Section 23).
 * Route forward vector uses distance-oriented lookahead / lookbehind within segment boundaries (Section 3).
 */
export function generateVisualRouteStations(
  segment: { points: { distanceFromStart: number }[]; distance: number },
  curve: THREE.CatmullRomCurve3,
  elevationSampler?: (x: number, z: number) => number,
  stepMeters: number = 8.0,
  lookaheadMeters: number = 10.0
): VisualRouteStation[] {
  const stations: VisualRouteStation[] = [];
  const segPoints = segment.points;
  if (!segPoints || segPoints.length === 0) return stations;

  const segStartDist = segPoints[0].distanceFromStart;
  const segEndDist = segPoints[segPoints.length - 1].distanceFromStart;
  const segDistSpan = Math.max(0, segment.distance);

  if (segDistSpan < 1e-3 || segPoints.length < 2) {
    const p = curve.getPointAt(0);
    const groundY = elevationSampler ? elevationSampler(p.x, p.z) : 0;
    stations.push({
      routeDistance: segStartDist,
      x: p.x,
      z: p.z,
      groundY: isNaN(groundY) ? 0 : groundY,
      forwardX: 0,
      forwardZ: -1,
    });
    return stations;
  }

  const numSteps = Math.max(2, Math.ceil(segDistSpan / stepMeters));
  for (let i = 0; i <= numSteps; i++) {
    const d = segStartDist + (i / numSteps) * segDistSpan;
    const t = Math.max(0, Math.min(1, (d - segStartDist) / segDistSpan));
    const p = curve.getPointAt(t);

    // Compute route forward vector using distance lookahead / lookbehind (Section 3)
    const dPrev = Math.max(segStartDist, d - lookaheadMeters);
    const dNext = Math.min(segEndDist, d + lookaheadMeters);
    let fx = 0;
    let fz = -1;

    if (dNext - dPrev > 1e-3) {
      const tPrev = (dPrev - segStartDist) / segDistSpan;
      const tNext = (dNext - segStartDist) / segDistSpan;
      const pPrev = curve.getPointAt(tPrev);
      const pNext = curve.getPointAt(tNext);
      const dx = pNext.x - pPrev.x;
      const dz = pNext.z - pPrev.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-5) {
        fx = dx / len;
        fz = dz / len;
      }
    } else {
      const tangent = curve.getTangentAt(t);
      const len = Math.hypot(tangent.x, tangent.z);
      if (len > 1e-5) {
        fx = tangent.x / len;
        fz = tangent.z / len;
      }
    }

    const groundY = elevationSampler ? elevationSampler(p.x, p.z) : 0;
    stations.push({
      routeDistance: d,
      x: p.x,
      z: p.z,
      groundY: isNaN(groundY) ? 0 : groundY,
      forwardX: fx,
      forwardZ: fz,
    });
  }

  return stations;
}
