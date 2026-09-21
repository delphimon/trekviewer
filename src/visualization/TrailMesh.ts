import * as THREE from 'three';
import type { GPXPoint, TrackStats, TrailColorMode, ViewMode } from '../gpx/TrackTypes.ts';
import { geoToLocalMeters } from '../gpx/Coordinates.ts';

export interface TrailResult {
  group: THREE.Group;
  trailMesh: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  hikerMarker: THREE.Group;
  startBeacon: THREE.Group;
  summitBeacon: THREE.Group;
  updateHikerPosition: (progress: number) => { currentPoint: GPXPoint; position: THREE.Vector3 };
  setColorMode: (mode: TrailColorMode) => void;
  setViewMode: (mode: ViewMode) => void;
}

export class TrailMesh {
  /**
   * Generates dual-scale 3D route geometries:
   * - Diorama Mode: Prominent 14m radius glowing neon cord (1.8mm on table, visible across the room).
   * - 1:1 Immersion Mode: Sleek 0.08m (16cm wide) low-profile ground path that never blocks the view.
   */
  public static create(
    track: TrackStats,
    elevationSampler?: (x: number, z: number) => number
  ): TrailResult {
    const group = new THREE.Group();
    group.name = 'TrailGroup';

    const centerLat = track.bounds.centerLat;
    const centerLon = track.bounds.centerLon;
    const baseElevation = track.bounds.minEle;

    // Compute dynamic scale factor so route ribbon and hiker beacon scale gracefully
    // whether viewing a 5km day hike or an 80km multi-day traverse (e.g. Bailey Range)
    const maxDim = Math.max(track.bounds.widthMeters, track.bounds.depthMeters);
    const scaleFactor = Math.max(1.0, maxDim / 4000);
    // Ribbon half-width scales so it maintains a consistent ~2mm visible width on table
    const ribbonHalfWidth = Math.max(3.5, Math.min(80.0, maxDim / 850));
    const dioramaElevationOffset = Math.max(2.5, 2.0 * scaleFactor);

    // Precompute window-smoothed grade and speed for velvety continuous gradients
    const smoothedGrades: number[] = new Array(track.points.length);
    const smoothedSpeeds: number[] = new Array(track.points.length);
    const WINDOW = 2; // +/- 2 points (5-point moving window)

    for (let i = 0; i < track.points.length; i++) {
      let gradeSum = 0;
      let gradeCount = 0;
      let speedSum = 0;
      let speedCount = 0;

      for (let w = Math.max(0, i - WINDOW); w <= Math.min(track.points.length - 1, i + WINDOW); w++) {
        const pt = track.points[w];
        if (pt.grade !== undefined && !isNaN(pt.grade)) {
          gradeSum += Math.abs(pt.grade);
          gradeCount++;
        }
        if (pt.speed !== undefined && !isNaN(pt.speed)) {
          speedSum += pt.speed * 3.6; // convert m/s to km/h
          speedCount++;
        }
      }

      smoothedGrades[i] = gradeCount > 0 ? gradeSum / gradeCount : Math.abs(track.points[i].grade || 0);
      smoothedSpeeds[i] = speedCount > 0 ? speedSum / speedCount : (track.points[i].speed ? track.points[i].speed! * 3.6 : track.avgSpeed);
    }

    // Build raw vectors for both modes
    // Diorama offset: elevation above terrain (with polygonOffset) for crisp flat 2D map ribbon
    // 1:1 offset: +0.06m (6cm) above terrain so it sits right under boots without floating
    const dioramaVectors: THREE.Vector3[] = [];
    const firstPersonVectors: THREE.Vector3[] = [];

    for (let i = 0; i < track.points.length; i++) {
      const p = track.points[i];
      const loc = geoToLocalMeters(p.lat, p.lon, p.ele, centerLat, centerLon, baseElevation);

      let baseY = loc.y;
      if (elevationSampler) {
        const terrainY = elevationSampler(loc.x, loc.z);
        baseY = Math.max(loc.y, terrainY);
      }

      dioramaVectors.push(new THREE.Vector3(loc.x, baseY + dioramaElevationOffset, loc.z));
      firstPersonVectors.push(new THREE.Vector3(loc.x, baseY + 0.06, loc.z));
    }

    // Downsample points for smooth splines
    const maxSplinePoints = 1200;
    const step = Math.max(1, Math.floor(dioramaVectors.length / maxSplinePoints));
    const dioramaSplinePoints: THREE.Vector3[] = [];
    const fpSplinePoints: THREE.Vector3[] = [];

    for (let i = 0; i < dioramaVectors.length; i += step) {
      dioramaSplinePoints.push(dioramaVectors[i]);
      fpSplinePoints.push(firstPersonVectors[i]);
    }
    if (dioramaSplinePoints[dioramaSplinePoints.length - 1] !== dioramaVectors[dioramaVectors.length - 1]) {
      dioramaSplinePoints.push(dioramaVectors[dioramaVectors.length - 1]);
      fpSplinePoints.push(firstPersonVectors[firstPersonVectors.length - 1]);
    }

    const curve = new THREE.CatmullRomCurve3(dioramaSplinePoints, false, 'catmullrom', 0.2);
    const fpCurve = new THREE.CatmullRomCurve3(fpSplinePoints, false, 'catmullrom', 0.2);

    const tubularSegments = Math.min(dioramaSplinePoints.length * 4, 2400);

    // 1. Diorama Geometry: Crisp scale-adaptive flat 2D map ribbon (zero 3D cylinder bulk)
    const dioramaGeo = this.createFlatRibbonGeometry(curve, tubularSegments, ribbonHalfWidth);

    // 2. 1:1 Immersion Geometry: Sleek alpine ground footpath (radius = 0.08m = 16cm width)
    const firstPersonGeo = new THREE.TubeGeometry(fpCurve, tubularSegments, 0.08, 6, false);

    const minEle = track.minElevation;
    const eleSpan = Math.max(track.maxElevation - minEle, 10);

    const getColorForPoint = (ptIndex: number, mode: TrailColorMode, color: THREE.Color) => {
      const pt = track.points[ptIndex];
      if (mode === 'elevation') {
        const normEle = Math.min(Math.max((pt.ele - minEle) / eleSpan, 0), 1);
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
        // Steepness of trail grade (slope percentage)
        const grade = smoothedGrades[ptIndex];
        if (grade < 5) {
          // Flat or gentle cruise (< 5%) -> Bright Emerald Green
          color.setHex(0x10b981);
        } else if (grade < 15) {
          // Moderate hiking grade (5% - 15%) -> Emerald to Golden Yellow
          color.lerpColors(new THREE.Color(0x10b981), new THREE.Color(0xeab308), (grade - 5) / 10);
        } else if (grade < 25) {
          // Steep incline (15% - 25%) -> Golden Yellow to Bright Orange
          color.lerpColors(new THREE.Color(0xeab308), new THREE.Color(0xf97316), (grade - 15) / 10);
        } else if (grade < 40) {
          // Arduous / extreme grade (25% - 40%) -> Bright Orange to Crimson Red
          color.lerpColors(new THREE.Color(0xf97316), new THREE.Color(0xef4444), (grade - 25) / 15);
        } else {
          // Scramble / technical cliff (> 40%) -> Crimson to Alpine Violet
          const t = Math.min((grade - 40) / 25, 1);
          color.lerpColors(new THREE.Color(0xef4444), new THREE.Color(0xa855f7), t);
        }
      } else if (mode === 'speed') {
        // Pace / travel speed (km/h)
        const spd = smoothedSpeeds[ptIndex];
        if (spd < 1.8) {
          // Stopped or grueling slow crawl (< 1.8 km/h) -> Crimson Red
          color.setHex(0xef4444);
        } else if (spd < 3.2) {
          // Steep climb pace (1.8 - 3.2 km/h) -> Crimson to Orange
          color.lerpColors(new THREE.Color(0xef4444), new THREE.Color(0xf97316), (spd - 1.8) / 1.4);
        } else if (spd < 4.5) {
          // Steady hiking pace (3.2 - 4.5 km/h) -> Orange to Golden Amber
          color.lerpColors(new THREE.Color(0xf97316), new THREE.Color(0xeab308), (spd - 3.2) / 1.3);
        } else if (spd < 6.0) {
          // Brisk walking pace (4.5 - 6.0 km/h) -> Golden Amber to Emerald Green
          color.lerpColors(new THREE.Color(0xeab308), new THREE.Color(0x10b981), (spd - 4.5) / 1.5);
        } else {
          // Fast descent / trail run (> 6.0 km/h) -> Emerald to Radiant Cyan
          const t = Math.min((spd - 6.0) / 6.0, 1);
          color.lerpColors(new THREE.Color(0x10b981), new THREE.Color(0x06b6d4), t);
        }
      } else {
        color.setHex(0x38bdf8);
      }
    };

    const applyColorsToRibbon = (geo: THREE.BufferGeometry, segments: number, mode: TrailColorMode) => {
      const count = (segments + 1) * 2;
      const colors = new Float32Array(count * 3);
      const color = new THREE.Color();

      for (let i = 0; i <= segments; i++) {
        const progress = i / segments;
        const ptIndex = Math.min(
          Math.floor(progress * (track.points.length - 1)),
          track.points.length - 1
        );
        getColorForPoint(ptIndex, mode, color);

        const vIdx = i * 2;
        colors[vIdx * 3] = color.r;
        colors[vIdx * 3 + 1] = color.g;
        colors[vIdx * 3 + 2] = color.b;

        colors[(vIdx + 1) * 3] = color.r;
        colors[(vIdx + 1) * 3 + 1] = color.g;
        colors[(vIdx + 1) * 3 + 2] = color.b;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    };

    const applyColorsToTube = (geo: THREE.TubeGeometry, radialSegs: number, mode: TrailColorMode) => {
      const posAttr = geo.attributes.position;
      const count = posAttr.count;
      const colors = new Float32Array(count * 3);
      const color = new THREE.Color();

      for (let i = 0; i < count; i++) {
        const segmentIdx = Math.floor(i / (radialSegs + 1));
        const progress = segmentIdx / tubularSegments;
        const ptIndex = Math.min(
          Math.floor(progress * (track.points.length - 1)),
          track.points.length - 1
        );
        getColorForPoint(ptIndex, mode, color);

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    };

    let currentColorMode: TrailColorMode = 'solid';
    applyColorsToRibbon(dioramaGeo, tubularSegments, currentColorMode);
    applyColorsToTube(firstPersonGeo, 6, currentColorMode);

    // Diorama Material: Crisp self-illuminated flat 2D map ribbon (offset to hug terrain without z-fighting)
    const dioramaMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -4.0,
      polygonOffsetUnits: -8.0,
    });

    // 1:1 Immersion Material: Clean, low-profile ground-level alpine line
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

    // Start Beacon (Emerald Pin + Base Ring)
    const startBeacon = this.createPin(dioramaVectors[0], 0x10b981, 'TRAILHEAD', scaleFactor);
    group.add(startBeacon);

    // Summit / Finish Beacon (Golden Ruby Pin + Summit Flag)
    const endVec = dioramaVectors[dioramaVectors.length - 1];
    const summitBeacon = this.createPin(endVec, 0xf59e0b, 'SUMMIT', scaleFactor);
    group.add(summitBeacon);

    // Animated / Scrubber Hiker Marker: Radiant High-Visibility Alpine Beacon
    const hikerMarker = this.createHikerMarker(scaleFactor);
    hikerMarker.position.copy(dioramaVectors[0]);
    group.add(hikerMarker);

    // Update Hiker Position function
    const updateHikerPosition = (
      progress: number
    ): { currentPoint: GPXPoint; position: THREE.Vector3 } => {
      const clamped = Math.min(Math.max(progress, 0), 1);
      const pos = curve.getPointAt(clamped);
      hikerMarker.position.copy(pos);

      // Keep hiker marker beacon level with gravity/map surface (do NOT tilt group along 3D trail pitch)
      const tangent = curve.getTangentAt(clamped);
      const yaw = Math.atan2(tangent.x, tangent.z);
      hikerMarker.rotation.set(0, yaw, 0);

      const ptIdx = Math.min(
        Math.floor(clamped * (track.points.length - 1)),
        track.points.length - 1
      );
      const currentPoint = track.points[ptIdx];

      return { currentPoint, position: pos };
    };

    const setColorMode = (mode: TrailColorMode) => {
      currentColorMode = mode;
      applyColorsToRibbon(dioramaGeo, tubularSegments, mode);
      applyColorsToTube(firstPersonGeo, 6, mode);
      (dioramaGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (firstPersonGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    };

    const setViewMode = (mode: ViewMode) => {
      if (mode === 'first-person') {
        trailMesh.geometry = firstPersonGeo;
        trailMesh.material = firstPersonMat;
        hikerMarker.visible = false; // Hide external avatar since user is at 1:1 eye level
      } else {
        trailMesh.geometry = dioramaGeo;
        trailMesh.material = dioramaMat;
        hikerMarker.visible = true;
      }
    };

    return {
      group,
      trailMesh,
      curve,
      hikerMarker,
      startBeacon,
      summitBeacon,
      updateHikerPosition,
      setColorMode,
      setViewMode,
    };
  }

  /**
   * Constructs a flat 2D ribbon quad strip along a 3D curve with zero cylindrical thickness.
   */
  private static createFlatRibbonGeometry(
    curve: THREE.CatmullRomCurve3,
    segments: number,
    halfWidth: number
  ): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const numVertices = (segments + 1) * 2;
    const positions = new Float32Array(numVertices * 3);
    const normals = new Float32Array(numVertices * 3);
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const pt = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);

      // Perpendicular vector across the trail on horizontal X-Z plane
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
      const leftX = pt.x - perpX * halfWidth;
      const leftY = pt.y;
      const leftZ = pt.z - perpZ * halfWidth;

      // Right vertex
      const rightX = pt.x + perpX * halfWidth;
      const rightY = pt.y;
      const rightZ = pt.z + perpZ * halfWidth;

      const vIdx = i * 2;
      positions[vIdx * 3] = leftX;
      positions[vIdx * 3 + 1] = leftY;
      positions[vIdx * 3 + 2] = leftZ;

      positions[(vIdx + 1) * 3] = rightX;
      positions[(vIdx + 1) * 3 + 1] = rightY;
      positions[(vIdx + 1) * 3 + 2] = rightZ;

      // Upward normals
      normals[vIdx * 3] = 0;
      normals[vIdx * 3 + 1] = 1;
      normals[vIdx * 3 + 2] = 0;

      normals[(vIdx + 1) * 3] = 0;
      normals[(vIdx + 1) * 3 + 1] = 1;
      normals[(vIdx + 1) * 3 + 2] = 0;

      if (i < segments) {
        const v0 = i * 2;
        const v1 = i * 2 + 1;
        const v2 = (i + 1) * 2;
        const v3 = (i + 1) * 2 + 1;

        indices.push(v0, v1, v2);
        indices.push(v1, v3, v2);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
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

    // Pin head (glowing sphere)
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

    // Pin stem (slender cone pointing down)
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

    // Pulsing base ring
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

  /**
   * Creates a radiant alpine hiker beacon scaled to remain prominent across any trek extent.
   */
  private static createHikerMarker(scaleFactor: number = 1.0): THREE.Group {
    const group = new THREE.Group();
    group.name = 'HikerMarker';

    const s = Math.max(1.0, scaleFactor);

    // 1. Floating Radiant Beacon Jewel (elevated to y = 48m * s so it towers above alpine ridges)
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

    // Glowing white core sphere inside jewel
    const coreGeo = new THREE.SphereGeometry(7 * s, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = 48 * s;
    group.add(core);

    // 2. Vertical Radiant Laser Pillar connecting jewel down to ground
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

    // 3. Ground Footprint Target Rings (pulsing amber/cyan radar reticle level to map)
    const innerRingGeo = new THREE.RingGeometry(6 * s, 12 * s, 24);
    innerRingGeo.rotateX(-Math.PI / 2);
    const innerRingMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3.0,
      polygonOffsetUnits: -6.0,
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
      polygonOffset: true,
      polygonOffsetFactor: -3.0,
      polygonOffsetUnits: -6.0,
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    outerRing.position.y = 1.2 * s;
    outerRing.renderOrder = 6;
    group.add(outerRing);

    const perimeterRingGeo = new THREE.RingGeometry(32 * s, 36 * s, 32);
    perimeterRingGeo.rotateX(-Math.PI / 2);
    const perimeterRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3.0,
      polygonOffsetUnits: -6.0,
    });
    const perimeterRing = new THREE.Mesh(perimeterRingGeo, perimeterRingMat);
    perimeterRing.position.y = 1.2 * s;
    perimeterRing.renderOrder = 6;
    group.add(perimeterRing);

    // 4. Directional Forward Chevron Arrow (shows trail heading)
    const arrowGeo = new THREE.ConeGeometry(6 * s, 18 * s, 4);
    arrowGeo.rotateX(Math.PI / 2); // points forward along +Z
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
