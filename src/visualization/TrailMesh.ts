import * as THREE from 'three';
import type { GPXPoint, TrackStats, TrailColorMode, ViewMode } from '../gpx/TrackTypes.ts';
import { RouteGeometry, yawForForwardVector } from './RouteGeometry.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface TrailResult {
  group: THREE.Group;
  trailMesh: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  routeGeometry: RouteGeometry;
  hikerMarker: THREE.Group;
  startBeacon: THREE.Group;
  finishBeacon: THREE.Group;
  summitBeacon: THREE.Group;
  updateHikerPosition: (progress: number) => { currentPoint: GPXPoint; position: THREE.Vector3 };
  setColorMode: (mode: TrailColorMode) => void;
  setViewMode: (mode: ViewMode) => void;
  setVerticalExaggeration: (factor: number) => void;
  dispose: () => void;
}

export class TrailMesh {
  public static create(
    track: TrackStats,
    elevationSampler?: (x: number, z: number) => number,
    baseElevation: number = track.bounds.minEle,
    initialExaggeration: number = 1.0
  ): TrailResult {
    const group = new THREE.Group();
    group.name = 'TrailGroup';

    const maxDim = Math.max(track.bounds.widthMeters, track.bounds.depthMeters);
    const scaleFactor = Math.max(1.0, maxDim / 4000);
    const ribbonHalfWidth = Math.max(3.5, Math.min(80.0, maxDim / 850));
    const dioramaElevationOffset = Math.max(2.5, 2.0 * scaleFactor);

    // Construct pure RouteGeometry (analytical and ground DEM coordinates without diorama offsets)
    const routeGeometry = new RouteGeometry(
      track,
      baseElevation,
      elevationSampler
    );

    // Primary curve for backward-compatibility with tests & controllers
    const primaryCurve = routeGeometry.segments[0]?.curve ||
      new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(0, 0, -10)]);

    // Total ribbon segments
    const totalSegments = Math.min(track.points.length * 3, 2400);

    // 1. Build Multi-Segment Flat Ribbon Geometry for Tabletop Diorama
    const { geometry: dioramaGeo, unscaledGroundY } = this.buildMultiSegmentRibbon(
      routeGeometry,
      ribbonHalfWidth,
      totalSegments,
      dioramaElevationOffset,
      initialExaggeration,
      elevationSampler
    );

    // 2. 1:1 Immersion Low-Profile Path Geometry across all segments (0.35m half-width = 70cm path, 0.08m ground clearance) (Section 11)
    const { geometry: firstPersonGeo } = this.buildMultiSegmentRibbon(
      routeGeometry,
      0.35,
      totalSegments,
      0.08,
      1.0,
      elevationSampler
    );

    // Color application helper with smoothed broad bands and run-length filtering (Sections 14-18)
    const applyColorsToGeo = (geo: THREE.BufferGeometry, mode: TrailColorMode) => {
      const posAttr = geo.attributes.position;
      if (!posAttr) return;
      const count = posAttr.count;
      const numStations = count / 2;
      const colors = new Float32Array(count * 3);
      const progresses = geo.userData.progresses as Float32Array | undefined;

      if (mode === 'solid') {
        const solidCol = new THREE.Color(0x38bdf8);
        for (let i = 0; i < count; i++) {
          colors[i * 3] = solidCol.r;
          colors[i * 3 + 1] = solidCol.g;
          colors[i * 3 + 2] = solidCol.b;
        }
      } else if (mode === 'elevation') {
        const color = new THREE.Color();
        for (let i = 0; i < count; i += 2) {
          const progress = progresses ? progresses[i] : (count > 1 ? i / (count - 1) : 0);
          const telemetry = routeGeometry.getTelemetryAtProgress(progress);
          TrailMesh.getColorForPoint(telemetry.currentPoint, track, 'elevation', color);

          colors[i * 3] = color.r;
          colors[i * 3 + 1] = color.g;
          colors[i * 3 + 2] = color.b;

          if (i + 1 < count) {
            colors[(i + 1) * 3] = color.r;
            colors[(i + 1) * 3 + 1] = color.g;
            colors[(i + 1) * 3 + 2] = color.b;
          }
        }
      } else {
        // 'grade' or 'speed' mode with broad bands and run-length filtering
        const stationDists = new Float32Array(numStations);
        const rawBands = new Int8Array(numStations);

        for (let s = 0; s < numStations; s++) {
          const prog = progresses ? progresses[s * 2] : (numStations > 1 ? s / (numStations - 1) : 0);
          const dist = prog * routeGeometry.totalDistance;
          stationDists[s] = dist;

          if (mode === 'grade') {
            const smoothedGrade = routeGeometry.getSmoothedGradeAtDistance(dist);
            rawBands[s] = TrailMesh.getGradeBand(smoothedGrade);
          } else {
            const smoothedSpeed = routeGeometry.getSmoothedSpeedAtDistance(dist);
            rawBands[s] = TrailMesh.getSpeedBand(smoothedSpeed);
          }
        }

        const filteredBands = TrailMesh.filterBandsRunLength(rawBands, stationDists, 60.0);
        const color = new THREE.Color();

        for (let s = 0; s < numStations; s++) {
          const band = filteredBands[s];
          if (mode === 'grade') {
            TrailMesh.getColorForGradeBand(band, color);
          } else {
            TrailMesh.getColorForSpeedBand(band, color);
          }

          const i0 = s * 2;
          const i1 = s * 2 + 1;
          colors[i0 * 3] = color.r;
          colors[i0 * 3 + 1] = color.g;
          colors[i0 * 3 + 2] = color.b;

          if (i1 < count) {
            colors[i1 * 3] = color.r;
            colors[i1 * 3 + 1] = color.g;
            colors[i1 * 3 + 2] = color.b;
          }
        }
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    };

    let currentColorMode: TrailColorMode = 'solid';
    applyColorsToGeo(dioramaGeo, currentColorMode);
    applyColorsToGeo(firstPersonGeo, currentColorMode);

    // Diorama Material
    const dioramaMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -4.0,
      polygonOffsetUnits: -8.0,
    });

    // 1:1 First-Person Material
    const firstPersonMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.4,
      metalness: 0.2,
      emissive: new THREE.Color(0x223344),
      emissiveIntensity: 0.6,
      side: THREE.DoubleSide,
    });

    const trailMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(dioramaGeo, dioramaMat);
    trailMesh.renderOrder = 5;
    group.add(trailMesh);

    // Start Beacon (Neutral Start / Trailhead)
    const firstTele = routeGeometry.getTelemetryAtDistance(0);
    const startGroundY = firstTele.position.y;
    const startPos = new THREE.Vector3(firstTele.position.x, startGroundY * initialExaggeration + 8.0, firstTele.position.z);
    const startBeacon = this.createPin(startPos, 0x10b981, 'START', scaleFactor);
    group.add(startBeacon);

    // Finish / Summit Beacon (Neutral semantics: SUMMIT only if at peak elevation, else FINISH)
    const lastTele = routeGeometry.getTelemetryAtDistance(routeGeometry.totalDistance);
    const finishGroundY = lastTele.position.y;
    const lastPoint = lastTele.currentPoint;
    const isSummit = Math.abs(lastPoint.ele - track.maxElevation) < 15 ||
      (track.waypoints && track.waypoints.some((wp) =>
        (wp.name.toLowerCase().includes('summit') || wp.sym?.toLowerCase().includes('summit')) &&
        Math.hypot(wp.lat - lastPoint.lat, wp.lon - lastPoint.lon) < 0.002
      ));
    const finishLabel = isSummit ? 'SUMMIT' : 'FINISH';
    const finishPos = new THREE.Vector3(lastTele.position.x, finishGroundY * initialExaggeration + 8.0, lastTele.position.z);
    const finishBeacon = this.createPin(finishPos, 0xf59e0b, finishLabel, scaleFactor);
    group.add(finishBeacon);
    const summitBeacon = finishBeacon;

    // Radiant Hiker Marker
    let currentExaggeration = initialExaggeration;
    let currentProgress = 0;
    const hikerMarker = this.createHikerMarker(scaleFactor);
    hikerMarker.position.set(firstTele.position.x, startGroundY * initialExaggeration + dioramaElevationOffset, firstTele.position.z);
    group.add(hikerMarker);

    // Distance-interpolated position update
    const updateHikerPosition = (
      progress: number
    ): { currentPoint: GPXPoint; position: THREE.Vector3 } => {
      currentProgress = progress;
      const telemetry = routeGeometry.getTelemetryAtProgress(progress);
      let hikerGroundY = telemetry.position.y;
      if (elevationSampler) {
        const sampled = elevationSampler(telemetry.position.x, telemetry.position.z);
        if (!isNaN(sampled)) {
          hikerGroundY = sampled;
        }
      }
      const hikerY = hikerGroundY * currentExaggeration + dioramaElevationOffset;
      hikerMarker.position.set(telemetry.position.x, hikerY, telemetry.position.z);

      // Keep hiker beacon upright to gravity while aligning yaw with route forward (Sections 4, 5)
      const forward = routeGeometry.getRouteForwardAtProgress(progress);
      const yaw = yawForForwardVector(forward);
      hikerMarker.rotation.set(0, yaw, 0);

      return {
        currentPoint: telemetry.currentPoint,
        position: hikerMarker.position,
      };
    };

    const setColorMode = (mode: TrailColorMode) => {
      currentColorMode = mode;
      applyColorsToGeo(dioramaGeo, mode);
      applyColorsToGeo(firstPersonGeo, mode);
    };

    const setViewMode = (mode: ViewMode) => {
      if (mode === 'first-person') {
        trailMesh.geometry = firstPersonGeo;
        trailMesh.material = firstPersonMat;
        hikerMarker.visible = false;
        startBeacon.visible = false;
        finishBeacon.visible = false;
      } else {
        trailMesh.geometry = dioramaGeo;
        trailMesh.material = dioramaMat;
        hikerMarker.visible = true;
        startBeacon.visible = true;
        finishBeacon.visible = true;
      }
    };

    const setVerticalExaggeration = (factor: number) => {
      currentExaggeration = factor;
      const posArray = dioramaGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < unscaledGroundY.length; i++) {
        posArray[i * 3 + 1] = unscaledGroundY[i] * factor + dioramaElevationOffset;
      }
      dioramaGeo.attributes.position.needsUpdate = true;

      // Update start and finish beacons with constant +8.0 offset
      startBeacon.position.y = startGroundY * factor + 8.0;
      finishBeacon.position.y = finishGroundY * factor + 8.0;

      // Update hiker marker position with terrain elevation
      const telemetry = routeGeometry.getTelemetryAtProgress(currentProgress);
      let hikerGroundY = telemetry.position.y;
      if (elevationSampler) {
        const sampled = elevationSampler(telemetry.position.x, telemetry.position.z);
        if (!isNaN(sampled)) {
          hikerGroundY = sampled;
        }
      }
      hikerMarker.position.y = hikerGroundY * factor + dioramaElevationOffset;
    };

    const dispose = () => {
      if (group.parent) {
        group.parent.remove(group);
      }
      disposeObject3D(group);
      dioramaGeo.dispose();
      firstPersonGeo.dispose();
      dioramaMat.dispose();
      firstPersonMat.dispose();
    };

    return {
      group,
      trailMesh,
      curve: primaryCurve,
      routeGeometry,
      hikerMarker,
      startBeacon,
      finishBeacon,
      summitBeacon,
      updateHikerPosition,
      setColorMode,
      setViewMode,
      setVerticalExaggeration,
      dispose,
    };
  }

  private static buildMultiSegmentRibbon(
    routeGeometry: RouteGeometry,
    halfWidth: number,
    totalSegments: number,
    verticalOffset: number = 0,
    verticalExaggeration: number = 1.0,
    elevationSampler?: (x: number, z: number) => number
  ): { geometry: THREE.BufferGeometry; unscaledGroundY: Float32Array } {
    const geo = new THREE.BufferGeometry();
    const allPositions: number[] = [];
    const allNormals: number[] = [];
    const allIndices: number[] = [];
    const unscaledGroundYList: number[] = [];
    const allProgresses: number[] = [];

    let vertexOffset = 0;

    for (const segGeom of routeGeometry.segments) {
      const segCurve = segGeom.curve;
      const segPointsCount = Math.max(8, Math.round((segGeom.segment.distance / routeGeometry.totalDistance) * totalSegments));
      const segStartDist = segGeom.segment.points[0]?.distanceFromStart ?? 0;
      const segDistSpan = segGeom.segment.distance;

      for (let i = 0; i <= segPointsCount; i++) {
        const t = i / segPointsCount;
        const pt = segCurve.getPointAt(t);
        const tangent = segCurve.getTangentAt(t);

        let perpX = -tangent.z;
        let perpZ = tangent.x;
        const len = Math.hypot(perpX, perpZ);
        if (len > 1e-5) {
          perpX /= len;
          perpZ /= len;
        } else {
          perpX = 1;
          perpZ = 0;
        }

        // DENSE TERRAIN REPROJECTION (Sections 5, 6, 10):
        // Query elevationSampler directly at the exact X/Z coordinates of the centerline point!
        // Never use interpolated spline Y as final ground height.
        let groundY = pt.y;
        if (elevationSampler) {
          const sampled = elevationSampler(pt.x, pt.z);
          if (!isNaN(sampled)) {
            groundY = sampled;
          }
        }
        const finalY = groundY * verticalExaggeration + verticalOffset;

        // Left vertex
        allPositions.push(pt.x - perpX * halfWidth, finalY, pt.z - perpZ * halfWidth);
        allNormals.push(0, 1, 0);
        unscaledGroundYList.push(groundY);

        // Right vertex
        allPositions.push(pt.x + perpX * halfWidth, finalY, pt.z + perpZ * halfWidth);
        allNormals.push(0, 1, 0);
        unscaledGroundYList.push(groundY);

        // Track progress
        const dist = segStartDist + t * segDistSpan;
        const prog = routeGeometry.totalDistance > 0 ? Math.min(1, Math.max(0, dist / routeGeometry.totalDistance)) : 0;
        allProgresses.push(prog, prog);

        if (i < segPointsCount) {
          const v0 = vertexOffset + i * 2;
          const v1 = vertexOffset + i * 2 + 1;
          const v2 = vertexOffset + (i + 1) * 2;
          const v3 = vertexOffset + (i + 1) * 2 + 1;

          allIndices.push(v0, v1, v2);
          allIndices.push(v1, v3, v2);
        }
      }

      vertexOffset += (segPointsCount + 1) * 2;
    }

    geo.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(allNormals, 3));
    geo.setIndex(allIndices);
    geo.userData.progresses = new Float32Array(allProgresses);

    return {
      geometry: geo,
      unscaledGroundY: new Float32Array(unscaledGroundYList),
    };
  }

  public static getGradeBand(grade: number): number {
    const absG = Math.abs(grade);
    if (absG < 8) return 0;   // 0-8% Gentle
    if (absG < 15) return 1;  // 8-15% Moderate
    if (absG < 25) return 2;  // 15-25% Steep
    if (absG < 40) return 3;  // 25-40% Very Steep
    return 4;                 // 40%+ Extreme
  }

  public static getColorForGradeBand(band: number, color: THREE.Color): void {
    switch (band) {
      case 0: color.setHex(0x10b981); break; // Green
      case 1: color.setHex(0xeab308); break; // Yellow
      case 2: color.setHex(0xf97316); break; // Orange
      case 3: color.setHex(0xef4444); break; // Red
      case 4: default: color.setHex(0xa855f7); break; // Purple
    }
  }

  public static getSpeedBand(speedMs: number): number {
    const spdKmh = speedMs * 3.6;
    if (spdKmh < 1.8) return 0; // < 1.8 km/h (< 1.1 mph) Slow
    if (spdKmh < 3.2) return 1; // 1.8 - 3.2 km/h (1.1 - 2.0 mph)
    if (spdKmh < 4.5) return 2; // 3.2 - 4.5 km/h (2.0 - 2.8 mph) Steady
    if (spdKmh < 6.0) return 3; // 4.5 - 6.0 km/h (2.8 - 3.7 mph) Brisk
    return 4;                   // 6.0+ km/h (3.7+ mph) Fast
  }

  public static getColorForSpeedBand(band: number, color: THREE.Color): void {
    switch (band) {
      case 0: color.setHex(0xef4444); break; // Red
      case 1: color.setHex(0xf97316); break; // Orange
      case 2: color.setHex(0xeab308); break; // Yellow
      case 3: color.setHex(0x10b981); break; // Green
      case 4: default: color.setHex(0x06b6d4); break; // Cyan
    }
  }

  public static filterBandsRunLength(
    rawBands: Int8Array,
    stationDists: Float32Array,
    minRunLength: number = 60.0
  ): Int8Array {
    const n = rawBands.length;
    if (n <= 2) return new Int8Array(rawBands);

    const filtered = new Int8Array(rawBands);

    interface BandRun {
      band: number;
      start: number;
      end: number;
      lengthMeters: number;
    }

    const getRuns = (arr: Int8Array): BandRun[] => {
      const runs: BandRun[] = [];
      let start = 0;
      for (let i = 1; i <= n; i++) {
        if (i === n || arr[i] !== arr[start]) {
          const end = i - 1;
          const lengthMeters = stationDists[end] - stationDists[start];
          runs.push({ band: arr[start], start, end, lengthMeters });
          start = i;
        }
      }
      return runs;
    };

    const runs = getRuns(filtered);

    // Merge isolated transient runs (length < minRunLength)
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (run.lengthMeters < minRunLength) {
        const prev = r > 0 ? runs[r - 1] : null;
        const next = r < runs.length - 1 ? runs[r + 1] : null;

        if (prev && next && prev.band === next.band) {
          for (let k = run.start; k <= run.end; k++) {
            filtered[k] = prev.band;
          }
        } else if (prev && Math.abs(run.band - prev.band) <= 1 && (!next || prev.lengthMeters >= (next?.lengthMeters ?? 0))) {
          for (let k = run.start; k <= run.end; k++) {
            filtered[k] = prev.band;
          }
        } else if (next && Math.abs(run.band - next.band) <= 1) {
          for (let k = run.start; k <= run.end; k++) {
            filtered[k] = next.band;
          }
        }
      }
    }

    return filtered;
  }

  public static getColorForPoint(
    pt: GPXPoint,
    track: TrackStats,
    mode: TrailColorMode,
    color: THREE.Color
  ): void {
    if (mode === 'elevation') {
      const span = Math.max(track.maxElevation - track.minElevation, 10);
      const normEle = Math.min(Math.max((pt.ele - track.minElevation) / span, 0), 1);
      if (normEle < 0.25) {
        color.lerpColors(new THREE.Color(0x00f5d4), new THREE.Color(0x10b981), normEle / 0.25);
      } else if (normEle < 0.55) {
        color.lerpColors(new THREE.Color(0x10b981), new THREE.Color(0xf59e0b), (normEle - 0.25) / 0.3);
      } else if (normEle < 0.85) {
        color.lerpColors(new THREE.Color(0xf59e0b), new THREE.Color(0xef4444), (normEle - 0.55) / 0.3);
      } else {
        color.lerpColors(new THREE.Color(0xef4444), new THREE.Color(0xffffff), (normEle - 0.85) / 0.15);
      }
    } else if (mode === 'grade') {
      const band = TrailMesh.getGradeBand(pt.grade ?? 0);
      TrailMesh.getColorForGradeBand(band, color);
    } else if (mode === 'speed') {
      const speedMs = pt.speed ?? (track.avgSpeed / 3.6);
      const band = TrailMesh.getSpeedBand(speedMs);
      TrailMesh.getColorForSpeedBand(band, color);
    } else {
      color.setHex(0x38bdf8);
    }
  }

  private static createPin(
    position: THREE.Vector3,
    colorHex: number,
    label: string,
    scaleFactor: number = 1.0
  ): THREE.Group {
    const pinGroup = new THREE.Group();
    pinGroup.name = `Pin_${label}`;
    pinGroup.position.copy(position);

    const s = Math.max(0.6, scaleFactor);

    const sphereGeo = new THREE.SphereGeometry(6 * s, 16, 16);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 0.8,
      roughness: 0.2,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.y = 18 * s;
    pinGroup.add(sphere);

    const coneGeo = new THREE.ConeGeometry(2 * s, 18 * s, 12);
    coneGeo.rotateX(Math.PI);
    const coneMat = new THREE.MeshStandardMaterial({
      color: colorHex,
      metalness: 0.6,
      roughness: 0.3,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.y = 9 * s;
    pinGroup.add(cone);

    const ringGeo = new THREE.RingGeometry(4 * s, 8 * s, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.5 * s;
    pinGroup.add(ring);

    return pinGroup;
  }

  private static createHikerMarker(scaleFactor: number = 1.0): THREE.Group {
    const group = new THREE.Group();
    group.name = 'HikerMarker';

    const s = Math.max(1.0, scaleFactor);

    // 1. Floating Radiant Beacon Jewel
    const jewelGeo = new THREE.OctahedronGeometry(16 * s, 0);
    const jewelMat = new THREE.MeshStandardMaterial({
      color: 0xffb703,
      emissive: 0xf59e0b,
      emissiveIntensity: 4.5,
      roughness: 0.1,
      metalness: 0.2,
    });
    const jewel = new THREE.Mesh(jewelGeo, jewelMat);
    jewel.position.y = 48 * s;
    group.add(jewel);

    // Glowing core
    const coreGeo = new THREE.SphereGeometry(7 * s, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = 48 * s;
    group.add(core);

    // 2. Vertical Radiant Laser Pillar
    const pillarHeight = 48 * s;
    const pillarGeo = new THREE.CylinderGeometry(1.8 * s, 1.8 * s, pillarHeight, 12);
    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.85,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = pillarHeight / 2;
    group.add(pillar);

    // 3. Ground Radar Reticles
    const innerRingGeo = new THREE.RingGeometry(6 * s, 12 * s, 24);
    innerRingGeo.rotateX(-Math.PI / 2);
    const innerRingMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
    innerRing.position.y = 1.2 * s;
    innerRing.renderOrder = 6;
    group.add(innerRing);

    const outerRingGeo = new THREE.RingGeometry(16 * s, 30 * s, 32);
    outerRingGeo.rotateX(-Math.PI / 2);
    const outerRingMat = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRing.position.y = 1.2 * s;
    outerRing.renderOrder = 6;
    group.add(outerRing);

    // 4. Directional Forward Chevron Arrow (pointing along local -Z per Section 4)
    const arrowGeo = new THREE.ConeGeometry(6 * s, 18 * s, 4);
    arrowGeo.rotateX(-Math.PI / 2);
    const arrowMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 2.8,
      roughness: 0.2,
    });
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.position.y = 20 * s;
    group.add(arrow);

    return group;
  }
}
