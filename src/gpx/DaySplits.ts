import type { TrackStats } from './TrackTypes.ts';
import type { RouteLandmark } from './RouteLandmarks.ts';

export interface DaySplit {
  day: number;
  startProgress: number; endProgress: number;
  distanceMeters: number; gainMeters: number; lossMeters: number; seconds: number;
}

/** Per-day totals between day_boundary landmarks; empty for single-day routes. */
export function daySplits(track: TrackStats, landmarks: readonly RouteLandmark[]): DaySplit[] {
  const total = track.totalDistance;
  const cuts = landmarks.filter(lm => lm.type === 'day_boundary').map(lm => lm.progress)
    .filter(p => p > 0 && p < 1).sort((a, b) => a - b);
  if (!cuts.length || !(total > 0)) return [];
  const bounds = [0, ...cuts, 1];
  const points = track.points;
  const splits: DaySplit[] = [];
  for (let d = 0; d < bounds.length - 1; d++) {
    const from = bounds[d] * total, to = bounds[d + 1] * total;
    let gain = 0, loss = 0, startSeconds: number | null = null, endSeconds = 0, previous: number | null = null;
    for (const point of points) {
      if (point.distanceFromStart < from || point.distanceFromStart > to) continue;
      if (previous !== null) { const delta = point.ele - previous; if (delta > 0) gain += delta; else loss -= delta; }
      previous = point.ele;
      startSeconds ??= point.elapsedSeconds; endSeconds = point.elapsedSeconds;
    }
    splits.push({ day: d + 1, startProgress: bounds[d], endProgress: bounds[d + 1], distanceMeters: to - from,
      gainMeters: gain, lossMeters: loss, seconds: Math.max(0, endSeconds - (startSeconds ?? endSeconds)) });
  }
  return splits;
}
