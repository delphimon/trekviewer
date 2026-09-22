import * as THREE from 'three';
import type { GPXPoint, TrackStats, TrackSegment } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters } from '../gpx/Coordinates.ts';

export interface RouteTelemetry {
  position: THREE.Vector3;
  groundPosition: THREE.Vector3;
  tangent: THREE.Vector3;
  currentPoint: GPXPoint;
  segmentIndex: number;
}

export interface SegmentGeometry {
  segment: TrackSegment;
  localVectors: THREE.Vector3[];
  groundVectors: THREE.Vector3[];
  firstPersonVectors: THREE.Vector3[];
  visualVectors: THREE.Vector3[];
  curve: THREE.CatmullRomCurve3;
  groundCurve: THREE.CatmullRomCurve3;
  firstPersonCurve: THREE.CatmullRomCurve3;
}

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

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

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
    dioramaElevationOffset: number = 3.0
  ) {
    this.track = track;
    this.totalDistance = Math.max(track.totalDistance, 1);
    const centerLat = track.bounds.centerLat;
    const centerLon = track.bounds.centerLon;

    // Process each track segment independently to prevent connecting lines across gaps
    for (const seg of track.segments) {
      const localVectors: THREE.Vector3[] = [];
      const groundVectors: THREE.Vector3[] = [];
      const firstPersonVectors: THREE.Vector3[] = [];

      for (const p of seg.points) {
        const loc = geoToLocalMeters(p.lat, p.lon, p.ele, centerLat, centerLon, baseElevation);
        let groundY = loc.y;
        if (elevationSampler) {
          const terrainY = elevationSampler(loc.x, loc.z);
          if (!isNaN(terrainY) && Number.isFinite(terrainY)) {
            groundY = terrainY;
          }
        }
        groundVectors.push(new THREE.Vector3(loc.x, groundY, loc.z));
        localVectors.push(new THREE.Vector3(loc.x, groundY + dioramaElevationOffset, loc.z));
        firstPersonVectors.push(new THREE.Vector3(loc.x, groundY + 0.08, loc.z));
      }

      if (localVectors.length < 2) continue;

      // Visual route: RDP simplification with 6m tolerance to preserve tight switchbacks
      const visualVectors = simplifyPointsRDP(localVectors, 6.0);
      // Ensure at least 2 points
      const splinePoints = visualVectors.length >= 2 ? visualVectors : localVectors;

      // Conservative Catmull-Rom tension (0.15) to prevent cutting corners on alpine hairpins
      const curve = new THREE.CatmullRomCurve3(splinePoints, false, 'catmullrom', 0.15);
      const groundCurve = new THREE.CatmullRomCurve3(groundVectors, false, 'catmullrom', 0.15);
      const firstPersonCurve = new THREE.CatmullRomCurve3(firstPersonVectors, false, 'catmullrom', 0.15);

      this.segments.push({
        segment: seg,
        localVectors,
        groundVectors,
        firstPersonVectors,
        visualVectors: splinePoints,
        curve,
        groundCurve,
        firstPersonCurve,
      });
    }

    // Fallback if no segments were constructed
    if (this.segments.length === 0 && track.points.length >= 2) {
      const fallbackLocal: THREE.Vector3[] = [];
      const fallbackGround: THREE.Vector3[] = [];
      const fallbackFP: THREE.Vector3[] = [];

      for (const p of track.points) {
        const loc = geoToLocalMeters(p.lat, p.lon, p.ele, centerLat, centerLon, baseElevation);
        let groundY = loc.y;
        if (elevationSampler) {
          const terrainY = elevationSampler(loc.x, loc.z);
          if (!isNaN(terrainY) && Number.isFinite(terrainY)) {
            groundY = terrainY;
          }
        }
        fallbackGround.push(new THREE.Vector3(loc.x, groundY, loc.z));
        fallbackLocal.push(new THREE.Vector3(loc.x, groundY + dioramaElevationOffset, loc.z));
        fallbackFP.push(new THREE.Vector3(loc.x, groundY + 0.08, loc.z));
      }

      const curve = new THREE.CatmullRomCurve3(fallbackLocal, false, 'catmullrom', 0.15);
      const groundCurve = new THREE.CatmullRomCurve3(fallbackGround, false, 'catmullrom', 0.15);
      const firstPersonCurve = new THREE.CatmullRomCurve3(fallbackFP, false, 'catmullrom', 0.15);

      this.segments.push({
        segment: {
          points: track.points,
          distance: track.totalDistance,
          elevationGain: track.elevationGain,
          elevationLoss: track.elevationLoss,
          startIndex: 0,
          endIndex: track.points.length - 1,
        },
        localVectors: fallbackLocal,
        groundVectors: fallbackGround,
        firstPersonVectors: fallbackFP,
        visualVectors: fallbackLocal,
        curve,
        groundCurve,
        firstPersonCurve,
      });
    }
  }

  /**
   * Distance-based route interpolation:
   * Maps target distance in meters to exact 3D position and interpolated telemetry
   * using binary search strictly bounded within the segment containing targetDist.
   */
  public getTelemetryAtDistance(distanceMeters: number): RouteTelemetry {
    const targetDist = Math.max(0, Math.min(this.totalDistance, distanceMeters));

    if (this.track.points.length === 0 || this.segments.length === 0) {
      return {
        position: new THREE.Vector3(),
        groundPosition: new THREE.Vector3(),
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

    // 1. Locate the exact segment that contains targetDist
    let activeSegIdx = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i].segment;
      const segStart = seg.points[0]?.distanceFromStart ?? 0;
      const segEnd = seg.points[seg.points.length - 1]?.distanceFromStart ?? segStart;
      if (targetDist >= segStart && targetDist <= segEnd) {
        activeSegIdx = i;
        break;
      }
      if (targetDist < segStart) {
        activeSegIdx = Math.max(0, i - 1);
        break;
      }
      if (i === this.segments.length - 1) {
        activeSegIdx = i;
      }
    }

    const segGeom = this.segments[activeSegIdx];
    const segPoints = segGeom.segment.points;

    // 2. Binary search strictly WITHIN active segment to prevent cross-segment interpolation
    let idx0 = 0;
    if (segPoints.length > 1) {
      let low = 0;
      let high = segPoints.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (segPoints[mid].distanceFromStart < targetDist) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      idx0 = Math.max(0, Math.min(segPoints.length - 2, low - 1));
    }

    const p0 = segPoints[idx0];
    const p1 = segPoints[Math.min(idx0 + 1, segPoints.length - 1)];

    const dSpan = p1.distanceFromStart - p0.distanceFromStart;
    const alpha = dSpan > 0.001 ? Math.max(0, Math.min(1, (targetDist - p0.distanceFromStart) / dSpan)) : 0;

    // Interpolate analytical point telemetry strictly within segment
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
      index: p0.index,
      segmentIndex: p0.segmentIndex ?? activeSegIdx,
    };

    let position = new THREE.Vector3();
    let groundPosition = new THREE.Vector3();
    let tangent = new THREE.Vector3(0, 0, -1);

    if (segGeom && segGeom.segment.distance > 0 && segPoints.length > 1) {
      const segStart = segPoints[0].distanceFromStart;
      const segEnd = segPoints[segPoints.length - 1].distanceFromStart;
      const segSpan = Math.max(segEnd - segStart, 1e-4);
      const segDist = Math.max(0, Math.min(segSpan, targetDist - segStart));
      const segT = Math.min(1, Math.max(0, segDist / segSpan));

      position = segGeom.curve.getPointAt(segT);
      tangent = segGeom.curve.getTangentAt(segT);
      groundPosition = segGeom.groundCurve ? segGeom.groundCurve.getPointAt(segT) : position.clone();
    } else if (segGeom && segGeom.localVectors.length > 0) {
      position = segGeom.localVectors[0].clone();
      groundPosition = segGeom.groundVectors[0]?.clone() ?? position.clone();
    }

    return {
      position,
      groundPosition,
      tangent,
      currentPoint,
      segmentIndex: activeSegIdx,
    };
  }

  public getTelemetryAtProgress(progress: number): RouteTelemetry {
    return this.getTelemetryAtDistance(progress * this.totalDistance);
  }
}
