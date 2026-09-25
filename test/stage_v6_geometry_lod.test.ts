import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { AWSTerrariumElevationProvider } from '../src/terrain/providers/ImageryProvider.ts';
import {
  ElevationTileService,
  type ElevationGrid,
} from '../src/terrain/ElevationTiles.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { TerrainGenerator, type TerrainResult } from '../src/terrain/TerrainGenerator.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import type { GPXPoint, TrackStats, GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage V7 & V8: Local Terrain Geometry LOD & Trail Surface Conformance Suite', () => {
  const testBounds: GeoBounds = {
    minLat: 46.85,
    maxLat: 46.86,
    minLon: -121.76,
    maxLon: -121.75,
    centerLat: 46.855,
    centerLon: -121.755,
    minEle: 1500,
    maxEle: 2500,
    widthMeters: 4000,
    depthMeters: 4000,
    elevationSpan: 1000,
  };

  let origDocument: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    const mockCtx = {
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      measureText: () => ({ width: 50 }),
      roundRect: () => {},
      drawImage: () => {},
      setLineDash: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 1024,
            height: 1024,
            getContext: () => mockCtx,
            style: {},
          };
        }
        return { style: {} };
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
  });

  // Mock DEM grid for testing
  function createMockGrid(zoom: number, baseElevation: number = 1800): ElevationGrid {
    const width = 256;
    const height = 256;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Sloped surface + micro-terrain ridge
        data[y * width + x] = baseElevation + (x / width) * 200 + Math.sin(y * 0.1) * 20;
      }
    }
    return {
      width,
      height,
      zoom,
      tileXMin: 1000,
      tileXMax: 1000,
      tileYMin: 2000,
      tileYMax: 2000,
      numTilesX: 1,
      numTilesY: 1,
      data,
      tileValidity: new Uint8Array([1]),
      minElevation: baseElevation - 50,
      maxElevation: baseElevation + 250,
      isRealDEM: true,
    };
  }

  describe('AWS Terrarium Resolution & Local Chunk Fetching (Stage V7.1)', () => {
    it('verifies AWS Terrarium DEM provider supports high-resolution zoom 15 (~4.8m spacing)', () => {
      const provider = new AWSTerrariumElevationProvider();
      expect(provider.maxZoom).toBe(15);
      const urls = provider.getTileUrls(15, 5293, 11536);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls[0]).toContain('/15/5293/11536.png');
    });

    it('samples prioritizing local high-res DEM grid, falling back cleanly to base grid', () => {
      const baseGrid = createMockGrid(12, 1800);
      const localHighResGrid = createMockGrid(15, 1850);

      // Spy on sampleElevation to simulate hit on local vs base
      const spySample = vi.spyOn(ElevationTileService, 'sampleElevation');
      spySample.mockImplementation((grid, lat, lon) => {
        if (grid.zoom === 15) {
          // Local high-res returns 1850m
          return { elevation: 1850, isValid: true };
        } else {
          // Base grid returns 1800m
          return { elevation: 1800, isValid: true };
        }
      });

      // Point covered by local grid
      const sample1 = ElevationTileService.sampleElevationWithFallback(
        localHighResGrid,
        baseGrid,
        46.855,
        -121.755
      );
      expect(sample1.isValid).toBe(true);
      expect(sample1.elevation).toBe(1850); // Prioritized local grid!

      // Point outside local grid coverage (local invalid)
      spySample.mockImplementation((grid, lat, lon) => {
        if (grid.zoom === 15) {
          return { elevation: NaN, isValid: false };
        } else {
          return { elevation: 1800, isValid: true };
        }
      });

      const sample2 = ElevationTileService.sampleElevationWithFallback(
        localHighResGrid,
        baseGrid,
        47.0,
        -122.0
      );
      expect(sample2.isValid).toBe(true);
      expect(sample2.elevation).toBe(1800); // Fell back to base grid!

      spySample.mockRestore();
    });
  });

  function createMockTrack(pointCount: number = 10): TrackStats {
    const points: GPXPoint[] = [];
    const baseTime = new Date('2026-09-20T10:00:00Z').getTime();

    for (let i = 0; i < pointCount; i++) {
      points.push({
        index: i,
        lat: 46.85 + i * 0.001,
        lon: -121.75 + i * 0.001,
        ele: 1600 + i * 50,
        time: new Date(baseTime + i * 60000),
        elapsedSeconds: i * 60,
        distanceFromStart: i * 200,
        playbackSeconds: i * 60,
        grade: 12,
        speed: 1.5,
      });
    }

    const segments = [
      {
        points,
        distance: (pointCount - 1) * 200,
        elevationGain: (pointCount - 1) * 50,
        elevationLoss: 0,
        startIndex: 0,
        endIndex: pointCount - 1,
      },
    ];

    return {
      name: 'Mock Test Track',
      points,
      segments,
      waypoints: [
        {
          name: 'Midway Camp',
          lat: 46.855,
          lon: -121.745,
          ele: 1800,
          type: 'day_boundary',
        },
      ],
      landmarks: [],
      bounds: testBounds,
      totalDistance: (pointCount - 1) * 200,
      elevationGain: (pointCount - 1) * 50,
      elevationLoss: 0,
      minElevation: 1600,
      maxElevation: 1600 + (pointCount - 1) * 50,
      movingTime: (pointCount - 1) * 60,
      totalPlaybackSeconds: (pointCount - 1) * 60,
      avgSpeed: 1.5,
      maxSpeed: 2.0,
      warnings: [],
    };
  }

  describe('Local High-Resolution DEM Geometry Chunk (Stage V7.2)', () => {
    it('creates bounded local terrain mesh and samples fine-grained surface elevation', () => {
      const localGrid = createMockGrid(14, 2000);
      const spySample = vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({
        elevation: 2150,
        isValid: true,
      });

      const chunk = new LocalTerrainChunk({
        localGrid,
        centerLat: 46.855,
        centerLon: -121.755,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 32,
        initialExaggeration: 1.0,
      });

      expect(chunk.mesh.name).toBe('LocalHighResTerrainMesh');
      expect(chunk.mesh.geometry).toBeDefined();

      // Sample inside chunk bounds (radius 500m => x, z in [-500, 500])
      const insideY = chunk.sampleLocalSurfaceY(100, 100);
      expect(insideY).not.toBeNull();
      // Elevation 2150 - base 1500 = 650m
      expect(insideY).toBeCloseTo(650, 0);

      // Sample outside chunk bounds (> 500m)
      const outsideY = chunk.sampleLocalSurfaceY(600, 100);
      expect(outsideY).toBeNull();

      chunk.dispose();
      spySample.mockRestore();
    });

    it('attaches local chunk to terrainResult and updates sampleRenderedSurfaceY authoritatively', async () => {
      const mockTrack = createMockTrack(5);
      const terrain = await TerrainGenerator.generate(
        mockTrack,
        undefined,
        undefined,
        1.0,
        false
      );

      const baseSurfaceY = terrain.sampleRenderedSurfaceY(0, 0);
      expect(typeof baseSurfaceY).toBe('number');

      // Create a local chunk with specific distinct elevation at center
      const localGrid = createMockGrid(15, 2200);
      const spySample = vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({
        elevation: 2200,
        isValid: true,
      });

      const chunk = new LocalTerrainChunk({
        localGrid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        terrainBaseElevation: terrain.terrainBaseElevation,
        radiusMeters: 400,
        segments: 32,
      });

      // Attach chunk
      terrain.attachLocalChunk!(chunk);
      expect(terrain.localChunk).toBe(chunk);
      expect(terrain.group.getObjectByName('LocalHighResTerrainMesh')).toBe(chunk.mesh);

      // sampleRenderedSurfaceY inside chunk should now authoritatively return local chunk height!
      const highResSurfaceY = terrain.sampleRenderedSurfaceY(0, 0);
      expect(highResSurfaceY).toBeCloseTo(2200 - terrain.terrainBaseElevation, 0);

      // setVerticalExaggeration updates both base and local chunk
      terrain.setVerticalExaggeration(2.0);
      const posAttr = chunk.mesh.geometry.attributes.position;
      expect(posAttr.getY(0)).toBeCloseTo((2200 - terrain.terrainBaseElevation) * 2.0, 0);

      // Detach chunk restores base surface
      terrain.detachLocalChunk!();
      expect(terrain.localChunk).toBeNull();
      const restoredSurfaceY = terrain.sampleRenderedSurfaceY(0, 0);
      expect(restoredSurfaceY).toBeCloseTo(baseSurfaceY, 1);

      terrain.dispose();
      spySample.mockRestore();
    });
  });

  describe('Trail Ribbon & Waypoint Surface Conformance (Stage V8.1, V8.2)', () => {
    it('enforces that trail ribbon left/right vertices strictly hug sampleRenderedSurfaceY', () => {
      const mockTrack = createMockTrack(5);

      // Surface elevation function returning known values
      const surfaceSampler = (x: number, z: number) => 150 + Math.sin(x * 0.01) * 10;

      const trail = TrailMesh.create(mockTrack, surfaceSampler, 1400, 1.0);

      // 1. Tabletop Diorama mode: ribbon sits at surface + dioramaElevationOffset
      const dioramaMesh = trail.trailMesh;
      const dioramaPos = dioramaMesh.geometry.attributes.position;
      expect(dioramaPos.count).toBeGreaterThan(0);

      // In 1:1 first-person mode: ribbon switches to low-profile path (offset = 0.08m)
      trail.setViewMode('first-person');
      const fpMesh = trail.trailMesh;
      const fpPos = fpMesh.geometry.attributes.position;

      // Check a sample station: left vertex and right vertex
      const x0 = fpPos.getX(0);
      const y0 = fpPos.getY(0);
      const z0 = fpPos.getZ(0);
      const expectedSurfaceY = surfaceSampler(x0, z0);

      // In 1:1 first-person mode: final Y = surfaceY * 1.0 + 0.08m
      expect(y0).toBeCloseTo(expectedSurfaceY + 0.08, 1);

      trail.dispose();
    });

    it('enforces clean waypoint and beacon elevation alignment on rendered surface', () => {
      const mockTrack = createMockTrack(5);
      const surfaceSampler = (x: number, z: number) => 250;

      const base = DioramaBase.create(
        testBounds,
        -80,
        mockTrack.waypoints,
        1400,
        surfaceSampler,
        1.0
      );

      const wpPin = base.getObjectByName('Waypoint_Midway Camp') as THREE.Group;
      expect(wpPin).toBeDefined();

      // At 1.0x exaggeration: pin position Y is baseYPos * 1.0 + 8
      expect(wpPin.position.y).toBeCloseTo(250 * 1.0 + 8, 1);

      // On vertical exaggeration adjustment (e.g. 2.5x): pin position Y scales baseY * factor + 8
      DioramaBase.setVerticalExaggeration(base, 2.5);
      expect(wpPin.position.y).toBeCloseTo(250 * 2.5 + 8, 1);

      base.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      });
    });
  });
});
