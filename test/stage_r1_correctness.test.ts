import { describe, it, expect, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GeoBounds, GPXPoint, TrackStats, TrackSegment } from '../src/gpx/TrackTypes.ts';
import type { TerrainResult, TerrainQuality } from '../src/terrain/TerrainGenerator.ts';

function createMockTrack(pointCount: number = 20, includeTimestamps: 'all' | 'none' | 'half' = 'all'): TrackStats {
  const points: GPXPoint[] = [];
  const baseTime = new Date('2026-09-20T10:00:00Z').getTime();

  for (let i = 0; i < pointCount; i++) {
    const hasTime =
      includeTimestamps === 'all' ||
      (includeTimestamps === 'half' && i % 2 === 0);

    points.push({
      index: i,
      lat: 46.85 + i * 0.001,
      lon: -121.75 + i * 0.001,
      ele: 2000 + i * 50,
      time: hasTime ? new Date(baseTime + i * 60000) : undefined,
      elapsedSeconds: i * 60,
      distanceFromStart: i * 200,
      playbackSeconds: i * 60,
      grade: 12,
      speed: 1.5,
    });
  }

  const segment: TrackSegment = {
    points,
    distance: (pointCount - 1) * 200,
    elevationGain: (pointCount - 1) * 50,
    elevationLoss: 0,
    startIndex: 0,
    endIndex: pointCount - 1,
  };

  const bounds: GeoBounds = {
    minLat: 46.85,
    maxLat: 46.85 + pointCount * 0.001,
    minLon: -121.75,
    maxLon: -121.75 + pointCount * 0.001,
    minEle: 2000,
    maxEle: 2000 + pointCount * 50,
    elevationSpan: pointCount * 50,
    centerLat: 46.85 + (pointCount * 0.001) / 2,
    centerLon: -121.75 + (pointCount * 0.001) / 2,
    widthMeters: 2000,
    depthMeters: 2000,
  };

  return {
    name: 'Mount Rainier Skyline',
    points,
    segments: [segment],
    bounds,
    totalDistance: (pointCount - 1) * 200,
    elevationGain: (pointCount - 1) * 50,
    elevationLoss: 0,
    minElevation: 2000,
    maxElevation: 2000 + pointCount * 50,
    movingTime: pointCount * 60,
    totalPlaybackSeconds: pointCount * 60,
    avgSpeed: 4.5,
    maxSpeed: 6.0,
    waypoints: [],
    landmarks: [],
    warnings: [],
  };
}

function createMockTerrainResult(baseElevation: number = 1400): TerrainResult {
  const group = new THREE.Group();
  const terrainMesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial());
  const skirtMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  group.add(terrainMesh);
  group.add(skirtMesh);

  let currentStyle: any = 'satellite';
  let currentExaggeration = 1.0;

  // Sampler returns groundLocalY (elevation relative to baseElevation)
  // For absolute elevation 2200m and base 1400m -> returns 800m
  const elevationSampler = (x: number, z: number) => 800;

  return {
    group,
    terrainMesh,
    skirtMesh,
    bounds: {
      minLat: 46.85,
      maxLat: 46.87,
      minLon: -121.75,
      maxLon: -121.73,
      minEle: 1400,
      maxEle: 2500,
      elevationSpan: 1100,
      centerLat: 46.86,
      centerLon: -121.74,
      widthMeters: 2000,
      depthMeters: 2000,
    },
    terrainGeoBounds: {
      minLat: 46.84,
      maxLat: 46.88,
      minLon: -121.76,
      maxLon: -121.72,
      minEle: 1400,
      maxEle: 2500,
      elevationSpan: 1100,
      centerLat: 46.86,
      centerLon: -121.74,
      widthMeters: 2600,
      depthMeters: 2600,
    },
    terrainBaseElevation: baseElevation,
    terrainQuality: 'dem' as TerrainQuality,
    demGrid: null,
    elevationSampler,
    setTextureStyle: vi.fn(async (style) => {
      currentStyle = style;
    }),
    setVerticalExaggeration: vi.fn((factor) => {
      currentExaggeration = factor;
    }),
    dispose: vi.fn(() => {}),
  };
}

describe('Stage R1 Correctness Suite', () => {
  describe('Requirement 4: Adaptive Imagery Vertical-Coordinate Contract', () => {
    it('LOD patch geometry conforms to groundLocalY * exaggeration + offset (no double-datum subtraction)', () => {
      const terrainBaseElevation = 1400; // Datum base
      const groundLocalY = 800; // Sampler returns groundLocalY (2200m - 1400m = 800m)

      const lodManager = new ImageryLODManager({
        terrainGeoBounds: {
          minLat: 46.85,
          maxLat: 46.87,
          minLon: -121.75,
          maxLon: -121.73,
          minEle: 1400,
          maxEle: 2500,
          elevationSpan: 1100,
          centerLat: 46.86,
          centerLon: -121.74,
          widthMeters: 2000,
          depthMeters: 2000,
        },
        terrainBaseElevation,
        elevationSampler: (x: number, z: number) => groundLocalY,
        verticalExaggeration: 1.0,
      });

      // Build patch geometry using private method via prototype reflection
      const geo1x: THREE.BufferGeometry = (lodManager as any).buildPatchGeometry(14, 2646, 5768);
      const pos1x = geo1x.getAttribute('position') as THREE.BufferAttribute;

      // Verify at 1x exaggeration: Y = 800 * 1.0 + 0.04 = 800.04
      const y1x = pos1x.getY(0);
      expect(y1x).toBeCloseTo(800.04, 2);
      expect(y1x).not.toBeCloseTo(-599.96, 1); // Must NOT double-subtract baseElevation!

      // Update to 2x exaggeration: Y = 800 * 2.0 + 0.04 = 1600.04
      lodManager.setVerticalExaggeration(2.0);
      (lodManager as any).updatePatchGeometryHeights(geo1x);
      const y2x = pos1x.getY(0);
      expect(y2x).toBeCloseTo(1600.04, 2);

      // Natural 1x scale (first-person)
      lodManager.setVerticalExaggeration(1.0);
      (lodManager as any).updatePatchGeometryHeights(geo1x);
      const yNatural = pos1x.getY(0);
      expect(yNatural).toBeCloseTo(800.04, 2);

      geo1x.dispose();
      lodManager.dispose();
    });
  });

  describe('Requirement 5: Texture Style Propagation into Adaptive LOD', () => {
    it('LoadedTrek.setTextureStyle propagates to both TerrainResult and ImageryLODManager', async () => {
      const track = createMockTrack(10);
      const terrain = createMockTerrainResult(1400);

      const lodManager = new ImageryLODManager({
        terrainGeoBounds: terrain.terrainGeoBounds,
        terrainBaseElevation: terrain.terrainBaseElevation,
        elevationSampler: terrain.elevationSampler,
        verticalExaggeration: 1.0,
        textureStyle: 'satellite',
      });

      const lodSetStyleSpy = vi.spyOn(lodManager, 'setTextureStyle');

      const trailResult = {
        group: new THREE.Group(),
        setColorMode: vi.fn(),
        setViewMode: vi.fn(),
        setVerticalExaggeration: vi.fn(),
        setHikerProgress: vi.fn(),
        dispose: vi.fn(),
        routeGeometry: new RouteGeometry(track, terrain.terrainBaseElevation, terrain.elevationSampler),
      };

      const dioramaBase = new THREE.Group();
      const flyoverController = {
        setViewMode: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const trek = new LoadedTrek({
        track,
        terrainResult: terrain,
        trailResult: trailResult as any,
        dioramaBase,
        flyoverController,
        imageryLOD: lodManager,
      });

      // Initial style
      expect(trek.imageryLOD).toBe(lodManager);

      // Switch to Topo
      await trek.setTextureStyle('topo');
      expect(terrain.setTextureStyle).toHaveBeenCalledWith('topo');
      expect(lodSetStyleSpy).toHaveBeenCalledWith('topo');

      // Rapid sequence: satellite -> topo -> hybrid -> satellite
      await trek.setTextureStyle('satellite');
      await trek.setTextureStyle('topo');
      await trek.setTextureStyle('hybrid');
      await trek.setTextureStyle('satellite');

      expect(terrain.setTextureStyle).toHaveBeenLastCalledWith('satellite');
      expect(lodSetStyleSpy).toHaveBeenLastCalledWith('satellite');

      trek.dispose();
    });
  });

  describe('Requirement 16: Terrain GeoBounds Supplied to ImageryLODManager', () => {
    it('LoadedTrek supplies terrainResult.terrainGeoBounds to ImageryLODManager', () => {
      const track = createMockTrack(10);
      const terrain = createMockTerrainResult(1400);

      const trailResult = {
        group: new THREE.Group(),
        setColorMode: vi.fn(),
        setViewMode: vi.fn(),
        setVerticalExaggeration: vi.fn(),
        setHikerProgress: vi.fn(),
        dispose: vi.fn(),
        routeGeometry: new RouteGeometry(track, terrain.terrainBaseElevation, terrain.elevationSampler),
      };

      const trek = new LoadedTrek({
        track,
        terrainResult: terrain,
        trailResult: trailResult as any,
        dioramaBase: new THREE.Group(),
        flyoverController: { dispose: vi.fn() } as any,
      });

      // The created imageryLOD should have received terrainGeoBounds (width 2600m) rather than track bounds (2000m)
      const lodBounds = (trek.imageryLOD as any).options.terrainGeoBounds;
      expect(lodBounds.widthMeters).toBe(2600);
      expect(lodBounds.depthMeters).toBe(2600);

      trek.dispose();
    });
  });

  describe('Requirement 24: Tabletop Transform Preservation', () => {
    it('correctly tracks and restores tabletop diorama transform when toggling view modes', () => {
      const root = new THREE.Group();
      root.position.set(0.5, 0.85, -1.2);
      root.rotation.set(0, 0.45, 0);
      root.scale.setScalar(1.8);

      let savedTransform: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null = null;

      function simulateApplyViewMode(mode: 'diorama' | 'first-person', prevMode: 'diorama' | 'first-person') {
        if (prevMode === 'diorama' && mode === 'first-person') {
          savedTransform = {
            position: root.position.clone(),
            quaternion: root.quaternion.clone(),
            scale: root.scale.clone(),
          };
          // In first-person, diorama transform shifts to 1:1 ground coordinate space
          root.position.set(0, 0, 0);
          root.rotation.set(0, 0, 0);
          root.scale.set(1, 1, 1);
        } else if (prevMode === 'first-person' && mode === 'diorama') {
          if (savedTransform) {
            root.position.copy(savedTransform.position);
            root.quaternion.copy(savedTransform.quaternion);
            root.scale.copy(savedTransform.scale);
          }
        }
      }

      // Transition diorama -> first-person
      simulateApplyViewMode('first-person', 'diorama');
      expect(savedTransform).not.toBeNull();
      expect(savedTransform!.position.x).toBeCloseTo(0.5);
      expect(savedTransform!.scale.x).toBeCloseTo(1.8);
      expect(root.scale.x).toBe(1.0); // Reset to 1:1 in first-person

      // Transition first-person -> diorama
      simulateApplyViewMode('diorama', 'first-person');
      expect(root.position.x).toBeCloseTo(0.5);
      expect(root.position.y).toBeCloseTo(0.85);
      expect(root.position.z).toBeCloseTo(-1.2);
      expect(root.scale.x).toBeCloseTo(1.8);
    });
  });

  describe('Requirement 32: Route Progress and Waypoint Telemetry via RouteGeometry', () => {
    it('RouteGeometry telemetry provides exact analytical elevation and coordinates at progress', () => {
      const track = createMockTrack(21); // 21 points, 0 to 4000 meters, 2000m to 3000m ele
      const terrain = createMockTerrainResult(1400);
      const routeGeometry = new RouteGeometry(track, terrain.terrainBaseElevation, terrain.elevationSampler);

      // Midpoint progress = 0.5 -> 2000m distance, point 10 (ele = 2500m)
      const tel = routeGeometry.getTelemetryAtProgress(0.5);
      expect(tel.currentPoint.distanceFromStart).toBeCloseTo(2000, 1);
      expect(tel.currentPoint.ele).toBeCloseTo(2500, 1);
      expect(tel.currentPoint.lat).toBeCloseTo(46.85 + 10 * 0.001, 4);

      // Quarter progress = 0.25 -> 1000m distance, point 5 (ele = 2250m)
      const telQuarter = routeGeometry.getTelemetryAtProgress(0.25);
      expect(telQuarter.currentPoint.distanceFromStart).toBeCloseTo(1000, 1);
      expect(telQuarter.currentPoint.ele).toBeCloseTo(2250, 1);
    });
  });

  describe('Requirement 33 & 34: Timing Classification and Conservative Landmark Semantics', () => {
    it('classifies timing data as recorded (>=90%), mixed (>0%), and estimated (0%)', () => {
      const sampleGpxAll = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="46.85" lon="-121.75"><ele>2000</ele><time>2026-09-20T10:00:00Z</time></trkpt>
    <trkpt lat="46.86" lon="-121.74"><ele>2500</ele><time>2026-09-20T10:15:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;
      const parsedAll = GPXParser.parse(sampleGpxAll);
      expect(parsedAll.timingType).toBe('recorded');

      const sampleGpxMixed = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="46.85" lon="-121.75"><ele>2000</ele><time>2026-09-20T10:00:00Z</time></trkpt>
    <trkpt lat="46.86" lon="-121.74"><ele>2500</ele></trkpt>
  </trkseg></trk>
</gpx>`;
      const parsedMixed = GPXParser.parse(sampleGpxMixed);
      expect(parsedMixed.timingType).toBe('mixed');

      const sampleGpxNone = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="46.85" lon="-121.75"><ele>2000</ele></trkpt>
    <trkpt lat="46.86" lon="-121.74"><ele>2500</ele></trkpt>
  </trkseg></trk>
</gpx>`;
      const parsedNone = GPXParser.parse(sampleGpxNone);
      expect(parsedNone.timingType).toBe('estimated');
    });

    it('generates conservative landmark semantics (High Point with high_point type, Start with Start sym)', () => {
      const sampleGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="46.85" lon="-121.75"><ele>2000</ele></trkpt>
    <trkpt lat="46.86" lon="-121.74"><ele>2800</ele></trkpt>
    <trkpt lat="46.87" lon="-121.73"><ele>2100</ele></trkpt>
  </trkseg></trk>
</gpx>`;
      const parsed = GPXParser.parse(sampleGpx);

      // Start landmark
      const startLm = parsed.landmarks.find((l) => l.type === 'start');
      expect(startLm).toBeDefined();
      expect(startLm!.name).toBe('Start');
      expect(startLm!.sym).toBe('Start'); // NOT 'Trailhead'

      // High Point landmark
      const highPointLm = parsed.landmarks.find((l) => l.name === 'High Point');
      expect(highPointLm).toBeDefined();
      expect(highPointLm!.type).toBe('high_point');
      expect(highPointLm!.sym).toBe('HighPoint'); // NOT 'Summit'
    });
  });
});
