import { localMetersToGeo } from '../gpx/Coordinates.ts';
import type { TrackStats } from '../gpx/TrackTypes.ts';
import type { RouteGeometry } from './RouteGeometry.ts';

export interface TrailPointInfo {
  progress: number;
  distanceMeters: number;
  elevationMeters: number;
  gradePercent: number;
  elapsedSeconds: number;
}

/** Route readout at a picked point given in model (trail-local) metres. */
export function trailPointInfo(route: RouteGeometry, track: TrackStats, localX: number, localZ: number): TrailPointInfo {
  const geo = localMetersToGeo(localX, localZ, track.bounds.centerLat, track.bounds.centerLon);
  const projection = route.projectGeoPointToVisualRoute(geo.lat, geo.lon);
  const distance = projection.routeDistanceMeters;
  return {
    progress: projection.progress,
    distanceMeters: distance,
    elevationMeters: route.getElevationAtDistance(distance),
    gradePercent: route.getSmoothedGradeAtDistance(distance),
    elapsedSeconds: route.getElapsedSecondsAtDistance(distance),
  };
}

/** "2h 05m" / "14m". */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(total / 60), minutes = total % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}
