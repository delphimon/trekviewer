import type { TrackStats } from './TrackTypes.ts';

/** Distance and recorded/estimated time still ahead at a route progress (0-1). */
export function remainingAt(track: TrackStats, progress: number): { meters: number; seconds: number } {
  const total = Math.max(0, track.totalDistance);
  const distance = Math.min(Math.max(progress, 0), 1) * total;
  const points = track.points;
  if (points.length < 2) return { meters: total - distance, seconds: 0 };
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].distanceFromStart < distance) lo = mid + 1; else hi = mid; }
  const b = points[lo], a = points[Math.max(0, lo - 1)];
  const span = b.distanceFromStart - a.distanceFromStart;
  const t = span > 0 ? (distance - a.distanceFromStart) / span : 0;
  const elapsed = a.elapsedSeconds + (b.elapsedSeconds - a.elapsedSeconds) * Math.min(Math.max(t, 0), 1);
  return { meters: total - distance, seconds: Math.max(0, points[points.length - 1].elapsedSeconds - elapsed) };
}
