import * as THREE from 'three';
import type { GPXPoint, TrackStats, TrackSegment } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters } from '../gpx/Coordinates.ts';
import { generateVisualRouteCurve } from './VisualRoute.ts';

export interface RouteTelemetry {
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  currentPoint: GPXPoint;
  segmentIndex: number;
}

export interface SegmentGeometry {
  segment: TrackSegment;
  groundVectors: THREE.Vector3[];
  localVectors: THREE.Vector3[];
  visualVectors: THREE.Vector3[];
  curve: THREE.CatmullRomCurve3;
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

  constructor(
    track: TrackStats,
    baseElevation: number,
    elevationSampler?: (x: number, z: number) => number,
    _deprecatedOffset?: number
  ) {
    this.track = track;
    this.totalDistance = Math.max(track.totalDistance, 1);
    const centerLat = track.bounds.centerLat;
    const centerLon = track.bounds.centerLon;

    // Process each track segment independently to prevent connecting lines across gaps
    for (const seg of track.segments) {
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

      this.segments.push({
        segment: seg,
        groundVectors,
        localVectors: groundVectors,
        visualVectors: visualPoints,
        curve,
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
      const { visualPoints, curve } = generateVisualRouteCurve(fallbackGround);
      this.segments.push({
        segment: {
          points: track.points,
          distance: track.totalDistance,
          elevationGain: track.elevationGain,
          elevationLoss: track.elevationLoss,
          startIndex: 0,
          endIndex: track.points.length - 1,
        },
        groundVectors: fallbackGround,
        localVectors: fallbackGround,
        visualVectors: visualPoints,
        curve,
      });
    }
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

    // Locate segment and curve for smooth visual representation
    const segIdx = p0.segmentIndex ?? 0;
    const segGeom = this.segments[Math.min(segIdx, this.segments.length - 1)];

    let position = new THREE.Vector3();
    let tangent = new THREE.Vector3(0, 0, -1);

    if (segGeom && segGeom.segment.distance > 0) {
      const segDist = Math.max(0, targetDist - segGeom.segment.points[0].distanceFromStart);
      const segT = Math.min(1, Math.max(0, segDist / segGeom.segment.distance));
      position = segGeom.curve.getPointAt(segT);
      tangent = segGeom.curve.getTangentAt(segT);
    } else if (segGeom && segGeom.localVectors.length > 0) {
      position = segGeom.localVectors[0].clone();
    }

    return {
      position,
      tangent,
      currentPoint,
      segmentIndex: segIdx,
    };
  }

  public getTelemetryAtProgress(progress: number): RouteTelemetry {
    return this.getTelemetryAtDistance(progress * this.totalDistance);
  }
}
