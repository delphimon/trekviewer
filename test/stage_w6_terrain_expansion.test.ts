import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import { TerrainGenerator, type TerrainResult } from '../src/terrain/TerrainGenerator.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { QualityProfileManager } from '../src/terrain/QualityProfile.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';

describe('Stage W6: Local High-Resolution Terrain 1000-1500m & Seamless Multi-Chunk Streaming', () => {
  const testBounds: GeoBounds = {
    minLat: 46.85,
    maxLat: 47.05,
    minLon: -121.76,
    maxLon: -121.74,
    centerLat: 46.95,
    centerLon: -121.75,
    minEle: 1500,
    maxEle: 2500,
    widthMeters: 4000,
    depthMeters: 22000,
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

  function createMockGrid(zoom: number = 15, baseElevation: number = 2000): ElevationGrid {
    const width = 256;
    const height = 256;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data[y * width + x] = baseElevation + (x / width) * 100;
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
      minElevation: baseElevation,
      maxElevation: baseElevation + 100,
      isRealDEM: true,
    };
  }

  function createMockRoute(): { route: RouteGeometry; track: TrackStats } {
    const numPoints = 50;
    const totalDistance = 20000;
    const points: GPXPoint[] = [];
    for (let i = 0; i <= numPoints; i++) {
      const frac = i / numPoints;
      points.push({
        lat: 46.85 + frac * 0.18, // ~20,000 meters North
        lon: -121.75,
        ele: 1600 + frac * 400,
        time: new Date(Date.now() + i * 1000),
        distanceFromStart: frac * totalDistance,
        elapsedSeconds: frac * 1000,
        playbackSeconds: frac * 1000,
        index: i,
      });
    }

    const track: TrackStats = {
      name: 'Test W6 Trail',
      points,
      totalDistance,
      elevationGain: 400,
      elevationLoss: 0,
      minElevation: 1600,
      maxElevation: 2000,
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

    const route = new RouteGeometry(track, 1500, () => 1600);
    return { route, track };
  }

  describe('LocalTerrainChunk Radius Expansion & Centering', () => {
    it('defaults radiusMeters to 1250m (QualityProfile Quest specification)', () => {
      const grid = createMockGrid();
      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: 46.86,
        centerLon: -121.75,
        terrainBaseElevation: 1500,
      });

      expect(chunk.radiusMeters).toBe(1250);
      expect(chunk.localBounds.maxX - chunk.localBounds.minX).toBe(2500);
      expect(chunk.localBounds.maxZ - chunk.localBounds.minZ).toBe(2500);

      chunk.dispose();
    });

    it('supports 1500m radius (Desktop high quality profile)', () => {
      const grid = createMockGrid();
      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: 46.86,
        centerLon: -121.75,
        terrainBaseElevation: 1500,
        radiusMeters: 1500,
      });

      expect(chunk.radiusMeters).toBe(1500);
      expect(chunk.localBounds.maxX - chunk.localBounds.minX).toBe(3000);
      expect(chunk.localBounds.maxZ - chunk.localBounds.minZ).toBe(3000);

      chunk.dispose();
    });

    it('positions mesh in 3D diorama space using referenceCenter coordinates', () => {
      const grid = createMockGrid();
      // Chunk center is shifted ~500m North of reference terrain center
      // 500m North corresponds to -Z in Three.js coordinates
      const refLat = 46.86;
      const refLon = -121.75;
      const chunkLat = 46.86 + 500 / 111320;
      const chunkLon = -121.75;

      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: chunkLat,
        centerLon: chunkLon,
        referenceCenterLat: refLat,
        referenceCenterLon: refLon,
        terrainBaseElevation: 1500,
        radiusMeters: 1000,
      });

      // Mesh position Z should be roughly -500
      expect(chunk.mesh.position.z).toBeCloseTo(-500, -1);
      expect(chunk.localCenter.z).toBeCloseTo(-500, -1);

      // Sampling at chunk center should return valid elevation
      const centerSample = chunk.sampleLocalSurfaceY(chunk.localCenter.x, chunk.localCenter.z);
      expect(centerSample).not.toBeNull();

      chunk.dispose();
    });
  });

  describe('Seamless Boundary Blending to Base Elevation', () => {
    it('smoothly blends boundary vertices to match base elevation at chunk perimeter', () => {
      const grid = createMockGrid(15, 2200);
      const spySample = vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({
        elevation: 2200,
        isValid: true,
      });

      // Base terrain is at elevation 1800 (hBase = 300)
      const baseElev = 1800;
      const terrainBase = 1500;
      const baseSampler = () => baseElev - terrainBase; // 300m

      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: 46.86,
        centerLon: -121.75,
        terrainBaseElevation: terrainBase,
        radiusMeters: 1000,
        baseElevationSampler: baseSampler,
        blendMarginRatio: 0.2, // outer 20% blends to base
      });

      // Inside core (r = 0): pure high-res elevation (2200 - 1500 = 700m)
      const coreY = chunk.sampleLocalSurfaceY(0, 0);
      expect(coreY).toBeCloseTo(700, 0);

      // Near perimeter (r = 980m, inside the outer 20% margin):
      // Should be blended strongly toward base elevation (300m)
      const nearEdgeY = chunk.sampleLocalSurfaceY(0, 980);
      expect(nearEdgeY).not.toBeNull();
      expect(nearEdgeY!).toBeLessThan(700);
      expect(nearEdgeY!).toBeGreaterThan(300);

      chunk.dispose();
      spySample.mockRestore();
    });
  });

  describe('Multi-Chunk Streaming and Seamless Route Coverage', () => {
    let terrain: TerrainResult;
    let mockRoute: RouteGeometry;
    let mockTrack: TrackStats;

    beforeEach(async () => {
      const created = createMockRoute();
      mockRoute = created.route;
      mockTrack = created.track;

      terrain = await TerrainGenerator.generate(
        mockTrack,
        undefined,
        undefined,
        1.0,
        false
      );
    });

    afterEach(() => {
      terrain.dispose();
    });

    it('attaches and manages multiple local chunks concurrently on TerrainResult', () => {
      const grid = createMockGrid(15, 2100);
      const spySample = vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({
        elevation: 2100,
        isValid: true,
      });

      const c1 = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: 46.85,
        centerLon: -121.75,
        terrainBaseElevation: terrain.terrainBaseElevation,
        radiusMeters: 1000,
      });
      const c2 = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: 46.86,
        centerLon: -121.75,
        terrainBaseElevation: terrain.terrainBaseElevation,
        radiusMeters: 1000,
      });

      terrain.attachLocalChunk!(c1);
      terrain.attachLocalChunk!(c2);

      expect(terrain.localChunks?.length).toBe(2);
      expect(terrain.localChunk).toBe(c1);

      // Exaggeration updates both chunks
      terrain.setVerticalExaggeration(2.5);
      expect(c1.mesh.geometry.attributes.position.getY(0)).toBeGreaterThan(0);
      expect(c2.mesh.geometry.attributes.position.getY(0)).toBeGreaterThan(0);

      // Detach specific chunk
      terrain.detachLocalChunk!(c1);
      expect(terrain.localChunks?.length).toBe(1);
      expect(terrain.localChunks![0]).toBe(c2);

      // Detach all
      terrain.detachAllLocalChunks!();
      expect(terrain.localChunks?.length).toBe(0);

      spySample.mockRestore();
    });

    it('streams rolling multi-chunks along route via LocalTerrainStreamer', () => {
      const grid = createMockGrid(15, 2050);
      const spySample = vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({
        elevation: 2050,
        isValid: true,
      });
      const questProfile = QualityProfileManager.getProfile('quest-high');

      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: mockRoute,
        demGrid: grid,
        qualityProfile: questProfile,
        chunkRadiusM: 1250,
        maxChunks: 3,
        evalThresholdM: 20,
      });

      // 1. Initial update at start of route (progress = 0)
      streamer.update(0.0);

      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(1);
      expect(streamer.activeChunks.length).toBeLessThanOrEqual(3);
      expect(terrain.localChunks?.length).toBe(streamer.activeChunks.length);

      const initialFirstChunk = streamer.activeChunks[0];

      // 2. Advance hiker halfway along 20,000m route (progress = 0.5, 10,000m)
      streamer.update(0.5);

      // Chunks should have updated to surround progress 0.5
      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(2);
      expect(streamer.activeChunks.length).toBeLessThanOrEqual(3);

      // Initial chunk at progress 0 should have been evicted due to distance (10,000m > 2500m envelope)
      const hasInitial = streamer.activeChunks.includes(initialFirstChunk);
      expect(hasInitial).toBe(false);

      // 3. Complete route (progress = 1.0)
      streamer.update(1.0);
      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(1);
      expect(streamer.activeChunks.length).toBeLessThanOrEqual(3);

      // Dispose cleans up all chunks cleanly
      streamer.dispose();
      expect(streamer.activeChunks.length).toBe(0);
      expect(terrain.localChunks?.length).toBe(0);

      spySample.mockRestore();
    });
  });
});
