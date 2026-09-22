import * as THREE from 'three';
import type { GPXPoint, TrackStats, TrailColorMode, ViewMode } from '../gpx/TrackTypes.ts';
import { RouteGeometry } from './RouteGeometry.ts';
import { disposeObject3D } from '../core/ResourceLifecycle.ts';

export interface TrailResult {
  group: THREE.Group;
  trailMesh: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  routeGeometry: RouteGeometry;
  hikerMarker: THREE.Group;
  startBeacon: THREE.Group;
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
    baseElevation: number = track.bounds.minEle
  ): TrailResult {
    const group = new THREE.Group();
    group.name = 'TrailGroup';

    const maxDim = Math.max(track.bounds.widthMeters, track.bounds.depthMeters);
    const scaleFactor = Math.max(1.0, maxDim / 4000);
    const ribbonHalfWidth = Math.max(3.5, Math.min(80.0, maxDim / 850));
    const dioramaElevationOffset = Math.max(2.5, 2.0 * scaleFactor);

    // Construct dual-representation RouteGeometry
    const routeGeometry = new RouteGeometry(
      track,
      baseElevation,
      elevationSampler,
      dioramaElevationOffset
    );

    // Primary curve for backward-compatibility with tests
    const primaryCurve = routeGeometry.segments[0]?.curve ||
      new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(0, 0, -10)]);

    // Total tubular segments
    const totalSegments = Math.min(track.points.length * 3, 2400);

    // 1. Build Multi-Segment Flat Ribbon Geometry (prevents cross-segment lines)
    const dioramaGeo = this.buildMultiSegmentRibbon(routeGeometry, ribbonHalfWidth, totalSegments);

    // 2. 1:1 Immersion Low-Profile Path Geometry
    const firstPersonGeo = new THREE.TubeGeometry(primaryCurve, totalSegments, 0.08, 6, false);

    // Color application helper
    const applyColorsToGeo = (geo: THREE.BufferGeometry, mode: TrailColorMode) => {
      const posAttr = geo.attributes.position;
      const count = posAttr.count;
      const colors = new Float32Array(count * 3);
      const color = new THREE.Color();

      for (let i = 0; i < count; i += 2) {
        const progress = i / count;
        const telemetry = routeGeometry.getTelemetryAtProgress(progress);
        this.getColorForPoint(telemetry.currentPoint, track, mode, color);

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;

        if (i + 1 < count) {
          colors[(i + 1) * 3] = color.r;
          colors[(i + 1) * 3 + 1] = color.g;
          colors[(i + 1) * 3 + 2] = color.b;
        }
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    };

    let currentColorMode: TrailColorMode = 'grade';
    applyColorsToGeo(dioramaGeo, currentColorMode);

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
    });

    const trailMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(dioramaGeo, dioramaMat);
    trailMesh.renderOrder = 5;
    group.add(trailMesh);

    // Start Beacon (Trailhead)
    const firstTele = routeGeometry.getTelemetryAtDistance(0);
    const startBeacon = this.createPin(firstTele.position, 0x10b981, 'TRAILHEAD', scaleFactor);
    group.add(startBeacon);

    // Summit / Finish Beacon
    const lastTele = routeGeometry.getTelemetryAtDistance(routeGeometry.totalDistance);
    const summitBeacon = this.createPin(lastTele.position, 0xf59e0b, 'SUMMIT', scaleFactor);
    group.add(summitBeacon);

    // Radiant Hiker Marker
    const hikerMarker = this.createHikerMarker(scaleFactor);
    hikerMarker.position.copy(firstTele.position);
    group.add(hikerMarker);

    // Distance-interpolated position update
    const updateHikerPosition = (
      progress: number
    ): { currentPoint: GPXPoint; position: THREE.Vector3 } => {
      const telemetry = routeGeometry.getTelemetryAtProgress(progress);
      hikerMarker.position.copy(telemetry.position);

      // Keep hiker beacon upright to gravity while aligning yaw with heading
      const yaw = Math.atan2(telemetry.tangent.x, telemetry.tangent.z);
      hikerMarker.rotation.set(0, yaw, 0);

      return {
        currentPoint: telemetry.currentPoint,
        position: telemetry.position,
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
      } else {
        trailMesh.geometry = dioramaGeo;
        trailMesh.material = dioramaMat;
        hikerMarker.visible = true;
      }
    };

    // Keep unscaled ribbon Y positions for vertical exaggeration
    const unscaledPositions = (dioramaGeo.attributes.position.array as Float32Array).slice();

    const setVerticalExaggeration = (factor: number) => {
      const posArray = dioramaGeo.attributes.position.array as Float32Array;
      for (let i = 1; i < posArray.length; i += 3) {
        posArray[i] = unscaledPositions[i] * factor;
      }
      dioramaGeo.attributes.position.needsUpdate = true;
    };

    const dispose = () => {
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
    totalSegments: number
  ): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const allPositions: number[] = [];
    const allNormals: number[] = [];
    const allIndices: number[] = [];

    let vertexOffset = 0;

    for (const segGeom of routeGeometry.segments) {
      const segCurve = segGeom.curve;
      const segPointsCount = Math.max(8, Math.round((segGeom.segment.distance / routeGeometry.totalDistance) * totalSegments));

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

        // Left vertex
        allPositions.push(pt.x - perpX * halfWidth, pt.y, pt.z - perpZ * halfWidth);
        allNormals.push(0, 1, 0);

        // Right vertex
        allPositions.push(pt.x + perpX * halfWidth, pt.y, pt.z + perpZ * halfWidth);
        allNormals.push(0, 1, 0);

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
    return geo;
  }

  private static getColorForPoint(
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
      const grade = Math.abs(pt.grade ?? 0);
      if (grade < 5) {
        color.setHex(0x10b981);
      } else if (grade < 15) {
        color.lerpColors(new THREE.Color(0x10b981), new THREE.Color(0xeab308), (grade - 5) / 10);
      } else if (grade < 25) {
        color.lerpColors(new THREE.Color(0xeab308), new THREE.Color(0xf97316), (grade - 15) / 10);
      } else if (grade < 40) {
        color.lerpColors(new THREE.Color(0xf97316), new THREE.Color(0xef4444), (grade - 25) / 15);
      } else {
        const t = Math.min((grade - 40) / 25, 1);
        color.lerpColors(new THREE.Color(0xef4444), new THREE.Color(0xa855f7), t);
      }
    } else if (mode === 'speed') {
      const spdKmh = (pt.speed ?? (track.avgSpeed / 3.6)) * 3.6;
      if (spdKmh < 1.8) {
        color.setHex(0xef4444);
      } else if (spdKmh < 3.2) {
        color.lerpColors(new THREE.Color(0xef4444), new THREE.Color(0xf97316), (spdKmh - 1.8) / 1.4);
      } else if (spdKmh < 4.5) {
        color.lerpColors(new THREE.Color(0xf97316), new THREE.Color(0xeab308), (spdKmh - 3.2) / 1.3);
      } else if (spdKmh < 6.0) {
        color.lerpColors(new THREE.Color(0xeab308), new THREE.Color(0x10b981), (spdKmh - 4.5) / 1.5);
      } else {
        const t = Math.min((spdKmh - 6.0) / 6.0, 1);
        color.lerpColors(new THREE.Color(0x10b981), new THREE.Color(0x06b6d4), t);
      }
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

    // 4. Directional Forward Chevron Arrow
    const arrowGeo = new THREE.ConeGeometry(6 * s, 18 * s, 4);
    arrowGeo.rotateX(Math.PI / 2);
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
