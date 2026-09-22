export interface ElevationStatsOptions {
  windowMeters?: number; // Rolling distance window half-width in meters (default: 30m)
  hysteresisMeters?: number; // Minimum vertical climb/descent threshold in meters (default: 5.0m)
}

export interface ElevationStatsResult {
  smoothedEles: Float64Array;
  elevationGain: number;
  elevationLoss: number;
}

/**
 * Calculates elevation gain and loss with distance-based rolling window smoothing
 * and topographic climb hysteresis.
 *
 * Distance-based filtering ensures consistent noise rejection whether the track was recorded
 * once every second (dense) or once every 30 seconds (sparse).
 */
export function calculateElevationStats(
  points: Array<{ ele: number; distanceFromStart: number }>,
  options: ElevationStatsOptions = {}
): ElevationStatsResult {
  const n = points.length;
  if (n === 0) {
    return {
      smoothedEles: new Float64Array(0),
      elevationGain: 0,
      elevationLoss: 0,
    };
  }

  const windowM = options.windowMeters ?? 30.0;
  const hysteresisM = options.hysteresisMeters ?? 5.0;

  const smoothedEles = new Float64Array(n);

  // 1. Distance-based rolling window smoothing
  let left = 0;
  let right = 0;
  let sumEle = 0;

  for (let i = 0; i < n; i++) {
    const curDist = points[i].distanceFromStart;
    const minDist = curDist - windowM;
    const maxDist = curDist + windowM;

    // Expand right bound
    while (right < n && points[right].distanceFromStart <= maxDist) {
      sumEle += points[right].ele;
      right++;
    }

    // Advance left bound
    while (left < right && points[left].distanceFromStart < minDist) {
      sumEle -= points[left].ele;
      left++;
    }

    const count = right - left;
    smoothedEles[i] = count > 0 ? sumEle / count : points[i].ele;
  }

  // 2. Climb hysteresis accumulator
  let elevationGain = 0;
  let elevationLoss = 0;
  let lastClimbEle = smoothedEles[0];

  for (let i = 1; i < n; i++) {
    const dFromLast = smoothedEles[i] - lastClimbEle;
    if (Math.abs(dFromLast) >= hysteresisM) {
      if (dFromLast > 0) {
        elevationGain += dFromLast;
      } else {
        elevationLoss += Math.abs(dFromLast);
      }
      lastClimbEle = smoothedEles[i];
    }
  }

  return {
    smoothedEles,
    elevationGain: Math.round(elevationGain),
    elevationLoss: Math.round(elevationLoss),
  };
}
