import type { GPXWaypoint, TrackStats } from './TrackTypes.ts';

export interface RouteLandmark extends GPXWaypoint {
  ele: number;
  progress: number;
}

const chartTypes = new Set(['start', 'finish', 'summit', 'high_point', 'day_boundary']);
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Resolve once after route preparation; share the result across both UI renderers. */
export function resolveRouteLandmarks(track: TrackStats): RouteLandmark[] {
  const result: RouteLandmark[] = [];
  const distance = Math.max(0, track.totalDistance || 0);
  const candidates = [...(track.waypoints ?? []), ...(track.landmarks ?? []).filter(item => chartTypes.has(item.type ?? ''))];
  for (const item of candidates) {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    let progress: number | undefined;
    let elevation = item.ele ?? track.minElevation ?? 0;
    // Coordinate projection alone cannot distinguish the ends of a loop.
    if (item.type === 'start') progress = 0;
    else if (item.type === 'finish') progress = 1;
    else if (item.isDerivedLandmark && Number.isFinite(item.distanceMeters) && distance > 0) progress = item.distanceMeters! / distance;
    else if (Number.isFinite(item.projection?.progress)) progress = item.projection!.progress;
    else if (Number.isFinite(item.distanceMeters) && distance > 0) progress = item.distanceMeters! / distance;

    if (progress === undefined) {
      let best = Infinity;
      const cos = Math.cos(item.lat * Math.PI / 180);
      progress = 0;
      for (const point of track.points ?? []) {
        const squared = (point.lat - item.lat) ** 2 + ((point.lon - item.lon) * cos) ** 2;
        if (squared < best) {
          best = squared;
          progress = distance > 0 ? point.distanceFromStart / distance : 0;
          elevation = item.ele ?? point.ele;
        }
      }
    }
    progress = clamp(progress);
    // Dedupe only the same route station. Nearby named stops and return visits survive.
    const duplicate = result.some(existing => {
      if (Math.abs(existing.progress - progress!) * Math.max(distance, 1) >= 1) return false;
      // A day boundary, camp or summit at an endpoint is a distinct landmark.
      const endpoint = (type?: string) => type === 'start' || type === 'finish';
      if ((endpoint(existing.type) || endpoint(item.type)) && existing.type !== item.type) return false;
      return existing.name.trim().toLowerCase() === item.name.trim().toLowerCase() ||
        (existing.type === item.type && Math.hypot(existing.lat - item.lat, existing.lon - item.lon) < 0.000001 &&
          (existing.isDerivedLandmark || item.isDerivedLandmark));
    });
    if (!duplicate) result.push({ ...item, ele: elevation, progress, distanceMeters: progress * distance });
  }
  return result.sort((a, b) => a.progress - b.progress);
}
