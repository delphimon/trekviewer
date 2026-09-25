import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  type ImageryPatch,
} from '../src/terrain/ImageryLODManager.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';
import type { ElevationGrid } from '../src/terrain/ElevationTiles.ts';

describe('Stage W7: Runtime Diagnostics and Multi-Tier Visual Outlines', () => {
  const testBounds: GeoBounds = {
    minLat: 46.85,
    maxLat: 46.87,
    minLon: -121.76,
    maxLon: -121.74,
    centerLat: 46.86,
    centerLon: -121.75,
    minEle: 1500,
    maxEle: 2500,
    widthMeters: 4000,
    depthMeters: 4000,
    elevationSpan: 1000,
  };

  let manager: ImageryLODManager;
  let mockRoute: RouteGeometry;

  beforeEach(() => {
    const points: GPXPoint[] = [];
    for (let i = 0; i <= 20; i++) {
      points.push({
        lat: 46.85 + i * 0.001,
        lon: -121.75,
        ele: 1500,
        time: new Date(Date.now() + i * 1000),
        distanceFromStart: i * 100,
        elapsedSeconds: i * 100,
        playbackSeconds: i * 100,
        index: i,
      });
    }

    const mockTrack: TrackStats = {
      name: 'Test Trail W7',
      points,
      totalDistance: 2000,
      elevationGain: 0,
      elevationLoss: 0,
      minElevation: 1500,
      maxElevation: 1500,
      movingTime: 1000,
      totalPlaybackSeconds: 1000,
      avgSpeed: 5.0,
      maxSpeed: 6.0,
      bounds: testBounds,
      segments: [],
      waypoints: [],
      landmarks: [],
      warnings: [],
    };

    mockRoute = new RouteGeometry(mockTrack, 1500, () => 1500);

    manager = new ImageryLODManager({
      terrainGeoBounds: testBounds,
      terrainBaseElevation: 1000,
      elevationSampler: () => 1500,
      routeGeometry: mockRoute,
      viewMode: 'first-person',
      enableInXR: true,
      enableFadeIn: false,
    });
  });

  afterEach(() => {
    manager.dispose();
  });

  function createMockPatch(key: string, zoom: number): ImageryPatch {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    const texture = new THREE.Texture();
    const patch: ImageryPatch = {
      key,
      x: 100,
      y: 100,
      zoom,
      mesh,
      texture,
      lastUsed: performance.now(),
      centerDist: 0.5,
      creationTime: performance.now(),
      isFading: false,
      fadeDurationMs: 0,
      dispose: () => {
        geo.dispose();
        mat.dispose();
        texture.dispose();
      },
    };
    return patch;
  }

  describe('Runtime Diagnostics & Telemetry', () => {
    it('computes coveragePercent, residentWarmCount, evictionsTotal, and cacheHitRate', () => {
      const diag = manager.getDiagnostics();

      expect(typeof diag.coveragePercent).toBe('number');
      expect(diag.coveragePercent).toBeGreaterThanOrEqual(0);
      expect(diag.coveragePercent).toBeLessThanOrEqual(100);

      expect(typeof diag.residentWarmCount).toBe('number');
      expect(diag.residentWarmCount).toBeGreaterThanOrEqual(0);

      expect(typeof diag.evictionsTotal).toBe('number');
      expect(diag.evictionsTotal).toBeGreaterThanOrEqual(0);

      expect(typeof diag.cacheHitRate).toBe('number');
      expect(diag.cacheHitRate).toBeGreaterThanOrEqual(0);
      expect(diag.cacheHitRate).toBeLessThanOrEqual(100);

      expect(typeof diag.z19AheadDistanceMeters).toBe('number');
      expect(diag.z19AheadDistanceMeters).toBeGreaterThanOrEqual(0);
    });

    it('calculates z19AheadDistanceMeters along the route when z19 patches are active ahead', () => {
      const patchesMap = (manager as any).patches as Map<string, ImageryPatch>;
      (manager as any).currentTargetZoom = 19;
      (manager as any).currentProgress = 0.0; // Hiker at 46.85

      // Add contiguous z19 patches along trail for ~200m ahead
      for (let i = 0; i <= 4; i++) {
        const checkLat = 46.85 + (i * 50) / 111320;
        const tile = latLonToTile(checkLat, -121.75, 19);
        const key = `satellite:19:${tile.x}:${tile.y}`;
        const patch = createMockPatch(key, 19);
        patch.mesh.visible = true;
        patchesMap.set(key, patch);
      }

      const diag = manager.getDiagnostics();
      expect(diag.z19AheadDistanceMeters).toBeGreaterThanOrEqual(150);
    });
  });

  describe('Multi-Tier Visual Debug Outlines', () => {
    it('assigns distinct colors to z19 (green), z18 (amber), and z17/base (cyan/indigo)', () => {
      const patchesMap = (manager as any).patches as Map<string, ImageryPatch>;

      const p19 = createMockPatch('satellite:19:1:1', 19);
      const p18 = createMockPatch('satellite:18:1:1', 18);
      const p17 = createMockPatch('satellite:17:1:1', 17);

      patchesMap.set(p19.key, p19);
      patchesMap.set(p18.key, p18);
      patchesMap.set(p17.key, p17);

      // Enable debug patch bounds
      manager.setDebugPatchBounds(true);

      expect(p19.outlineMesh).toBeDefined();
      expect(p18.outlineMesh).toBeDefined();
      expect(p17.outlineMesh).toBeDefined();

      const mat19 = p19.outlineMesh!.material as THREE.LineBasicMaterial;
      const mat18 = p18.outlineMesh!.material as THREE.LineBasicMaterial;
      const mat17 = p17.outlineMesh!.material as THREE.LineBasicMaterial;

      // z19 emerald green (0x22c55e)
      expect(mat19.color.getHex()).toBe(0x22c55e);
      // z18 amber (0xfbbf24)
      expect(mat18.color.getHex()).toBe(0xfbbf24);
      // z17 sky cyan (0x38bdf8)
      expect(mat17.color.getHex()).toBe(0x38bdf8);

      // Disabling debug patch bounds removes and cleans up all outlines
      manager.setDebugPatchBounds(false);
      expect(p19.outlineMesh).toBeUndefined();
      expect(p18.outlineMesh).toBeUndefined();
      expect(p17.outlineMesh).toBeUndefined();
    });

    it('attaches magenta/rose outline for LocalTerrainChunk extents', () => {
      const mockGrid: ElevationGrid = {
        width: 10,
        height: 10,
        zoom: 15,
        tileXMin: 100,
        tileXMax: 100,
        tileYMin: 100,
        tileYMax: 100,
        numTilesX: 1,
        numTilesY: 1,
        data: new Float32Array(100),
        tileValidity: new Uint8Array([1]),
        minElevation: 1500,
        maxElevation: 1600,
        isRealDEM: true,
      };

      const chunk = new LocalTerrainChunk({
        localGrid: mockGrid,
        centerLat: 46.86,
        centerLon: -121.75,
        terrainBaseElevation: 1500,
        radiusMeters: 1000,
      });

      // Initially no outline
      expect(chunk.outlineMesh).toBeUndefined();

      // Enable debug outline
      chunk.setDebugOutline(true);
      expect(chunk.outlineMesh).toBeDefined();
      expect(chunk.outlineMesh!.name).toBe('DebugLocalTerrainBoundary');

      const mat = chunk.outlineMesh!.material as THREE.LineBasicMaterial;
      // Rose/magenta color (0xf43f5e)
      expect(mat.color.getHex()).toBe(0xf43f5e);

      // Disable outline
      chunk.setDebugOutline(false);
      expect(chunk.outlineMesh).toBeUndefined();

      chunk.dispose();
    });
  });
});
