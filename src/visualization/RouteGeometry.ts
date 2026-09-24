import * as THREE from 'three';
import type { GPXPoint, TrackStats, TrackSegment } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters, localMetersToGeo } from '../gpx/Coordinates.ts';
import {
  generateVisualRouteCurve,
  generateVisualRouteStations,
  type VisualRouteStation,
} from './VisualRoute.ts';

/**
 * Canonical navigational heading (radians):
 * 0 = -Z (North)
 * +PI/2 = +X (East)
 * PI = +Z (South)
 * -PI/2 = -X (West)
 */
export function headingForForwardVector(forward: { x: number; z: number }): number {
  return Math.atan2(forward.x, -forward.z);
}

/**
 * Three.js Y-rotation Euler angle (yaw) to orient an object with local forward -Z
 * to point toward the given forward vector.
 * In Three.js: yaw = -heading = Math.atan2(-forward.x, -forward.z).
 */
export function yawForForwardVector(forward: { x: number; z: number }): number {
  return Math.atan2(-forward.x, -forward.z);
}

export interface RouteTelemetry {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  forward: THREE.Vector3;
  currentPoint: GPXPoint;
  segmentIndex: number;
  smoothedGrade?: number;
  smoothedSpeed?: number;
}

export interface RouteProjectionResult {
  progress: number;
  routeDistanceMeters: number;
  visualPosition: THREE.Vector3;
  projectedLat: number;
  projectedLon: number;
  offRouteDistanceMeters: number;
  segmentIndex: number;
}

export interface SegmentGeometry {
  segment: TrackSegment;
  groundVectors: THREE.Vector3[];
  localVectors: THREE.Vector3[];
  visualVectors: THREE.Vector3[];
  curve: THREE.CatmullRomCurve3;
  stations: VisualRouteStation[];
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/**
 * Perpendicular distance from a 3D point to a 3D line segment.
 */
function perpendicularDistance3D(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = _v1.subVectors(b, a);
  const ap = _v2.subVectors(p, a);
  const abLenSq = ab.lengthSq();
  if (abLenSq < 1e-8) return ap.length();

  const t = Math.max(0, Math.min(1, ap.dot(ab) / abLenSq));
  const projection = _v3.copy(a).addScaledVector(ab, t);
  return p.distanceTo(projection);
}

/**
 * Ramer-Douglas-Peucker (RDP) 3D path simplification preserving sharp switchbacks and key summits.
 */
export function simplifyPointsRDP(points: THREE.Vector3[], toleranceMeters: number): THREE.Vector3[] {
  if (points.length <= 2) return [...points];

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance3D(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > toleranceMeters) {
    const left = simplifyPointsRDP(points.slice(0, maxIdx + 1), toleranceMeters);
    const right = simplifyPointsRDP(points.slice(maxIdx), toleranceMeters);
    return left.slice(0, left.length - 1).concat(right);
  }

  return [first, last];
}

export class RouteGeometry {
  public segments: SegmentGeometry[] = [];
  public track: TrackStats;
  public totalDistance: number;
  public baseElevation: number;
  public stations: VisualRouteStation[] = [];

  constructor(
    track: TrackStats,
    baseElevation: number,
    elevationSampler?: (x: number, z: number) => number,
    _deprecatedOffset?: number
  ) {
    this.track = track;
    this.baseElevation = baseElevation;
    this.totalDistance = Math.max(track.totalDistance, 1);
    const centerLat = track.bounds.centerLat;
    const centerLon = track.bounds.centerLon;

    // Process each track segment independently to prevent connecting lines across gaps
    for (let segIdx = 0; segIdx < track.segments.length; segIdx++) {
      const seg = track.segments[segIdx];
      const groundVectors: THREE.Vector3[] = [];

      for (const p of seg.points) {
        const loc = geoToLocalMeters(p.lat, p.lon, p.ele, centerLat, centerLon, baseElevation);
        let groundY = loc.y;
        if (elevationSampler) {
          const terrainY = elevationSampler(loc.x, loc.z);
          if (!isNaN(terrainY)) {
            groundY = terrainY;
          }
        }
        groundVectors.push(new THREE.Vector3(loc.x, groundY, loc.z));
      }

      if (groundVectors.length < 2) continue;

      // Visual route: X/Z resampling, GPS spike filtering, gentle smoothing, and centripetal curve (Sections 6-9)
      const { visualPoints, curve } = generateVisualRouteCurve(groundVectors);
      const stations = generateVisualRouteStations(seg, curve, elevationSampler, 8.0, 10.0, segIdx);
      this.stations.push(...stations);

      this.segments.push({
        segment: seg,
        groundVectors,
        localVectors: groundVectors,
        visualVectors: visualPoints,
        curve,
        stations,
      });
    }

    // Fallback if no segments were constructed
    if (this.segments.length === 0 && track.points.length >= 2) {
      const fallbackGround = track.points.map((p) => {
        const loc = geoToLocalMeters(p.lat, p.lon, p.ele, centerLat, centerLon, baseElevation);
        let groundY = loc.y;
        if (elevationSampler) {
          const terrainY = elevationSampler(loc.x, loc.z);
          if (!isNaN(terrainY)) {
            groundY = terrainY;
          }
        }
        return new THREE.Vector3(loc.x, groundY, loc.z);
      });
      const fallbackSeg = {
        points: track.points,
        distance: track.totalDistance,
        elevationGain: track.elevationGain,
        elevationLoss: track.elevationLoss,
        startIndex: 0,
        endIndex: track.points.length - 1,
      };
      const { visualPoints, curve } = generateVisualRouteCurve(fallbackGround);
      const stations = generateVisualRouteStations(fallbackSeg, curve, elevationSampler, 8.0, 10.0);
      this.stations.push(...stations);

      this.segments.push({
        segment: fallbackSeg,
        groundVectors: fallbackGround,
        localVectors: fallbackGround,
        visualVectors: visualPoints,
        curve,
        stations,
      });
    }

    if (this.stations.length === 0) {
      this.stations.push({
        routeDistance: 0,
        x: 0,
        z: 0,
        groundY: 0,
        forwardX: 0,
        forwardZ: -1,
      });
    }

    // Ensure stations are strictly sorted by route distance
    this.stations.sort((a, b) => a.routeDistance - b.routeDistance);
  }

  /**
   * Retrieves horizontal position and ground elevation on the visual route by route distance (Section 23).
   * Binary-searches the distance-indexed stations.
   */
  public getVisualPositionAtDistance(
    distanceMeters: number,
    target: THREE.Vector3 = new THREE.Vector3()
  ): THREE.Vector3 {
    const stations = this.stations;
    if (stations.length === 0) return target.set(0, 0, 0);
    if (stations.length === 1) return target.set(stations[0].x, stations[0].groundY, stations[0].z);

    const dClamped = Math.max(0, Math.min(this.totalDistance, distanceMeters));
    let low = 0;
    let high = stations.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (stations[mid].routeDistance < dClamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const idx0 = Math.max(0, Math.min(stations.length - 2, low - 1));
    const s0 = stations[idx0];
    const s1 = stations[idx0 + 1];
    const span = s1.routeDistance - s0.routeDistance;
    const alpha = span > 1e-4 ? (dClamped - s0.routeDistance) / span : 0;

    const x = s0.x + alpha * (s1.x - s0.x);
    const z = s0.z + alpha * (s1.z - s0.z);
    const y = s0.groundY + alpha * (s1.groundY - s0.groundY);
    return target.set(x, y, z);
  }

  /**
   * Computes normalized route forward vector (in horizontal X/Z plane) pointing toward increasing route distance (Sections 2, 3).
   */
  public getRouteForwardAtDistance(
    distanceMeters: number,
    target: THREE.Vector3 = new THREE.Vector3()
  ): THREE.Vector3 {
    const stations = this.stations;
    if (stations.length === 0) return target.set(0, 0, -1);
    if (stations.length === 1) return target.set(stations[0].forwardX, 0, stations[0].forwardZ);

    const dClamped = Math.max(0, Math.min(this.totalDistance, distanceMeters));
    let low = 0;
    let high = stations.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (stations[mid].routeDistance < dClamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const idx0 = Math.max(0, Math.min(stations.length - 2, low - 1));
    const s0 = stations[idx0];
    const s1 = stations[idx0 + 1];
    const span = s1.routeDistance - s0.routeDistance;
    const alpha = span > 1e-4 ? (dClamped - s0.routeDistance) / span : 0;

    const fx = s0.forwardX + alpha * (s1.forwardX - s0.forwardX);
    const fz = s0.forwardZ + alpha * (s1.forwardZ - s0.forwardZ);
    const len = Math.hypot(fx, fz);
    if (len > 1e-5) {
      return target.set(fx / len, 0, fz / len);
    }
    return target.set(s0.forwardX, 0, s0.forwardZ);
  }

  public getRouteForwardAtProgress(
    progress: number,
    target: THREE.Vector3 = new THREE.Vector3()
  ): THREE.Vector3 {
    return this.getRouteForwardAtDistance(progress * this.totalDistance, target);
  }

  /**
   * Projects an arbitrary geographic coordinate (lat/lon) onto the continuous visual route (Sections 24, 25, 26).
   * Uses exact closest-point-on-segment mathematics across all distance-indexed visual route stations.
   */
  public projectGeoPointToVisualRoute(
    lat: number,
    lon: number
  ): RouteProjectionResult {
    const centerLat = this.track.bounds.centerLat;
    const centerLon = this.track.bounds.centerLon;
    const wpLocal = geoToLocalMeters(lat, lon, 0, centerLat, centerLon, this.baseElevation ?? 0);

    const stations = this.stations;
    if (stations.length === 0) {
      return {
        progress: 0,
        routeDistanceMeters: 0,
        visualPosition: new THREE.Vector3(wpLocal.x, 0, wpLocal.z),
        projectedLat: lat,
        projectedLon: lon,
        offRouteDistanceMeters: 0,
        segmentIndex: 0,
      };
    }

    if (stations.length === 1) {
      const s0 = stations[0];
      const offDist = Math.hypot(wpLocal.x - s0.x, wpLocal.z - s0.z);
      const projGeo = localMetersToGeo(s0.x, s0.z, centerLat, centerLon);
      return {
        progress: 0,
        routeDistanceMeters: s0.routeDistance,
        visualPosition: new THREE.Vector3(s0.x, s0.groundY, s0.z),
        projectedLat: projGeo.lat,
        projectedLon: projGeo.lon,
        offRouteDistanceMeters: offDist,
        segmentIndex: s0.segmentIndex ?? 0,
      };
    }

    let bestDistSq = Infinity;
    let bestProjX = stations[0].x;
    let bestProjZ = stations[0].z;
    let bestT = 0;
    let bestIdx = 0;

    const px = wpLocal.x;
    const pz = wpLocal.z;

    for (let i = 0; i < stations.length - 1; i++) {
      const s0 = stations[i];
      const s1 = stations[i + 1];

      // Avoid projecting across disjoint segment boundaries
      if (s0.segmentIndex !== undefined && s1.segmentIndex !== undefined && s0.segmentIndex !== s1.segmentIndex) {
        continue;
      }

      const ax = s0.x;
      const az = s0.z;
      const bx = s1.x;
      const bz = s1.z;

      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;

      let t = 0;
      if (lenSq > 1e-6) {
        t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
      }

      const qx = ax + t * dx;
      const qz = az + t * dz;
      const distSq = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestProjX = qx;
        bestProjZ = qz;
        bestT = t;
        bestIdx = i;
      }
    }

    const s0 = stations[bestIdx];
    const s1 = stations[Math.min(stations.length - 1, bestIdx + 1)];
    const t = bestT;

    const routeDistanceMeters = s0.routeDistance + t * (s1.routeDistance - s0.routeDistance);
    const groundY = s0.groundY + t * (s1.groundY - s0.groundY);
    const visualPosition = new THREE.Vector3(bestProjX, groundY, bestProjZ);
    const offRouteDistanceMeters = Math.sqrt(bestDistSq);

    const progress = this.totalDistance > 0
      ? Math.max(0, Math.min(1, routeDistanceMeters / this.totalDistance))
      : 0;

    const projGeo = localMetersToGeo(bestProjX, bestProjZ, centerLat, centerLon);

    return {
      progress,
      routeDistanceMeters,
      visualPosition,
      projectedLat: projGeo.lat,
      projectedLon: projGeo.lon,
      offRouteDistanceMeters,
      segmentIndex: s0.segmentIndex ?? 0,
    };
  }

  public static projectGeoPointToVisualRoute(
    routeGeometry: RouteGeometry,
    lat: number,
    lon: number
  ): RouteProjectionResult {
    return routeGeometry.projectGeoPointToVisualRoute(lat, lon);
  }

  /**
   * Distance-based route interpolation:
   * Maps target distance in meters to exact 3D position and interpolated telemetry
   * using binary search on the cumulative distance table.
   */
  public getTelemetryAtDistance(distanceMeters: number): RouteTelemetry {
    const targetDist = Math.max(0, Math.min(this.totalDistance, distanceMeters));
    const points = this.track.points;

    if (points.length === 0) {
      return {
        position: new THREE.Vector3(),
        tangent: new THREE.Vector3(0, 0, -1),
        forward: new THREE.Vector3(0, 0, -1),
        currentPoint: {
          lat: 0,
          lon: 0,
          ele: 0,
          distanceFromStart: 0,
          elapsedSeconds: 0,
          playbackSeconds: 0,
          index: 0,
        },
        segmentIndex: 0,
      };
    }

    // Binary search on analytical track points
    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].distanceFromStart < targetDist) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const idx0 = Math.max(0, Math.min(points.length - 2, low - 1));
    const p0 = points[idx0];
    const p1 = points[idx0 + 1];

    const dSpan = p1.distanceFromStart - p0.distanceFromStart;
    const alpha = dSpan > 0.001 ? (targetDist - p0.distanceFromStart) / dSpan : 0;

    // Interpolate analytical point telemetry
    const ele = p0.ele + alpha * (p1.ele - p0.ele);
    const lat = p0.lat + alpha * (p1.lat - p0.lat);
    const lon = p0.lon + alpha * (p1.lon - p0.lon);
    const grade = (p0.grade ?? 0) + alpha * ((p1.grade ?? 0) - (p0.grade ?? 0));
    const speed = p0.speed !== undefined && p1.speed !== undefined
      ? p0.speed + alpha * (p1.speed - p0.speed)
      : p0.speed ?? p1.speed;

    const currentPoint: GPXPoint = {
      lat,
      lon,
      ele,
      rawEle: p0.rawEle,
      time: p0.time,
      distanceFromStart: targetDist,
      elapsedSeconds: p0.elapsedSeconds + alpha * (p1.elapsedSeconds - p0.elapsedSeconds),
      playbackSeconds: p0.playbackSeconds + alpha * (p1.playbackSeconds - p0.playbackSeconds),
      speed,
      grade,
      hr: p0.hr,
      cad: p0.cad,
      index: idx0,
      segmentIndex: p0.segmentIndex,
    };

    const segIdx = p0.segmentIndex ?? 0;
    const position = this.getVisualPositionAtDistance(targetDist);
    const forward = this.getRouteForwardAtDistance(targetDist);
    const tangent = forward.clone();

    const smoothedGrade = this.getSmoothedGradeAtDistance(targetDist);
    const smoothedSpeed = this.getSmoothedSpeedAtDistance(targetDist);

    return {
      position,
      tangent,
      forward,
      currentPoint,
      segmentIndex: segIdx,
      smoothedGrade,
      smoothedSpeed,
    };
  }

  public getTelemetryAtProgress(progress: number): RouteTelemetry {
    return this.getTelemetryAtDistance(progress * this.totalDistance);
  }

  /**
   * Samples analytical elevation at any target distance along the route.
   */
  public getElevationAtDistance(targetDist: number): number {
    const points = this.track.points;
    if (points.length === 0) return 0;
    if (points.length === 1) return points[0].ele;
    const dClamped = Math.max(0, Math.min(this.totalDistance, targetDist));

    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].distanceFromStart < dClamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const idx0 = Math.max(0, Math.min(points.length - 2, low - 1));
    const p0 = points[idx0];
    const p1 = points[idx0 + 1];
    const dSpan = p1.distanceFromStart - p0.distanceFromStart;
    const alpha = dSpan > 0.001 ? (dClamped - p0.distanceFromStart) / dSpan : 0;
    return p0.ele + alpha * (p1.ele - p0.ele);
  }

  /**
   * Computes spatially smoothed grade across a surrounding distance window (default 70m).
   * Eliminates single-sample GPS elevation spikes while accurately capturing sustained slopes.
   * Section 16.
   */
  public getSmoothedGradeAtDistance(targetDist: number, windowMeters: number = 70): number {
    if (this.totalDistance <= 1.0) return 0;
    const halfWindow = windowMeters / 2;
    const d0 = Math.max(0, targetDist - halfWindow);
    const d1 = Math.min(this.totalDistance, targetDist + halfWindow);
    const span = d1 - d0;
    if (span < 1.0) return 0;

    const ele0 = this.getElevationAtDistance(d0);
    const ele1 = this.getElevationAtDistance(d1);
    return ((ele1 - ele0) / span) * 100;
  }

  /**
   * Computes smoothed speed/pace using a moving distance window (default 150m)
   * with median filtering to reject isolated GPS speed spikes and drops.
   * Section 17.
   */
  public getSmoothedSpeedAtDistance(targetDist: number, windowMeters: number = 150): number {
    const points = this.track.points;
    if (points.length === 0) return 0;
    const halfWindow = windowMeters / 2;
    const d0 = Math.max(0, targetDist - halfWindow);
    const d1 = Math.min(this.totalDistance, targetDist + halfWindow);

    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].distanceFromStart < d0) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const startIdx = Math.max(0, low);

    const speeds: number[] = [];
    for (let i = startIdx; i < points.length && points[i].distanceFromStart <= d1; i++) {
      const spd = points[i].speed;
      if (spd !== undefined && !isNaN(spd) && spd >= 0) {
        speeds.push(spd);
      }
    }

    if (speeds.length > 0) {
      speeds.sort((a, b) => a - b);
      const mid = speeds.length >> 1;
      const medianSpeed = speeds.length % 2 === 1
        ? speeds[mid]
        : (speeds[mid - 1] + speeds[mid]) / 2;
      return medianSpeed;
    }

    // Fallback: estimate speed from distance / elapsedSeconds across window
    const t0 = this.getElapsedSecondsAtDistance(d0);
    const t1 = this.getElapsedSecondsAtDistance(d1);
    const dt = t1 - t0;
    const ds = d1 - d0;
    if (dt > 1.0 && ds > 1.0) {
      return ds / dt;
    }
    return points[0]?.speed ?? 0;
  }

  /**
   * Samples elapsed seconds at target distance along the route.
   */
  public getElapsedSecondsAtDistance(targetDist: number): number {
    const points = this.track.points;
    if (points.length === 0) return 0;
    if (points.length === 1) return points[0].elapsedSeconds;
    const dClamped = Math.max(0, Math.min(this.totalDistance, targetDist));

    let low = 0;
    let high = points.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (points[mid].distanceFromStart < dClamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const idx0 = Math.max(0, Math.min(points.length - 2, low - 1));
    const p0 = points[idx0];
    const p1 = points[idx0 + 1];
    const dSpan = p1.distanceFromStart - p0.distanceFromStart;
    const alpha = dSpan > 0.001 ? (dClamped - p0.distanceFromStart) / dSpan : 0;
    return p0.elapsedSeconds + alpha * (p1.elapsedSeconds - p0.elapsedSeconds);
  }
}
