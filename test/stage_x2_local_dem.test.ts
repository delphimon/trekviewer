import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ElevationTileService,
  type ElevationGrid,
} from '../src/terrain/ElevationTiles.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import { QualityProfileManager } from '../src/terrain/QualityProfile.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';
import type { TerrainResult } from '../src/terrain/TerrainGenerator.ts';

import { latLonToTile } from '../src/gpx/Coordinates.ts';

describe('Stage X2: Real High-Resolution Local DEM Acquisition & Caching', () => {
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

  function createMockGrid(zoom: number = 15, baseElevation: number = 2000, centerLat: number = 46.855, centerLon: number = -121.755): ElevationGrid {
    const tile = latLonToTile(centerLat, centerLon, zoom);
    const tileXMin = tile.x - 2;
    const tileXMax = tile.x + 2;
    const tileYMin = tile.y - 2;
    const tileYMax = tile.y + 2;
    const numTilesX = tileXMax - tileXMin + 1;
    const numTilesY = tileYMax - tileYMin + 1;
    const width = numTilesX * 256;
    const height = numTilesY * 256;
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
      tileXMin,
      tileXMax,
      tileYMin,
      tileYMax,
      numTilesX,
      numTilesY,
      data,
      tileValidity: new Uint8Array(numTilesX * numTilesY).fill(1),
      minElevation: baseElevation,
      maxElevation: baseElevation + 100,
      isRealDEM: true,
    };
  }

  const dummyPoints: GPXPoint[] = [
    { lat: 46.85, lon: -121.76, ele: 1500, distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
    { lat: 46.855, lon: -121.755, ele: 2000, distanceFromStart: 1000, elapsedSeconds: 1800, playbackSeconds: 1800, index: 1 },
    { lat: 46.86, lon: -121.75, ele: 2500, distanceFromStart: 2000, elapsedSeconds: 3600, playbackSeconds: 3600, index: 2 },
  ];

  const dummyTrack = {
    name: 'Test Trail',
    points: dummyPoints,
    segments: [{ points: dummyPoints, distance: 2000, elevationGain: 1000, elevationLoss: 0 }],
    totalDistance: 2000,
    elevationGain: 1000,
    elevationLoss: 0,
    minElevation: 1500,
    maxElevation: 2500,
    bounds: testBounds,
    estimatedDuration: 3600,
  } as any as TrackStats;

  const dummyRouteGeometry = new RouteGeometry(dummyTrack, 1500, () => 1800);

  const createDummyTerrainResult = (): TerrainResult => ({
    group: new THREE.Group(),
    terrainMesh: new THREE.Mesh(),
    skirtMesh: new THREE.Mesh(),
    demGrid: createMockGrid(12, 1800),
    terrainGeoBounds: testBounds,
    terrainBaseElevation: 1500,
    terrainQuality: 'dem',
    elevationSampler: () => 1800,
    sampleRenderedSurfaceY: () => 1800,
    setVerticalExaggeration: () => {},
    dispose: () => {},
  } as any as TerrainResult);

  beforeEach(() => {
    ElevationTileService.clearLocalGridCache();
    QualityProfileManager.setActiveProfile('quest-high');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ElevationTileService.fetchLocalElevationGrid Budgets & Zoom Scaling', () => {
    it('attempts zoom 15 by default and bounds tile budget to maxTiles (Quest-high: 16 tiles)', async () => {
      let requestedZoom = 0;
      let requestedNumTiles = 0;

      const spyDecode = vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockImplementation(
        async (...args: any[]) => {
          const [zoom, xMin, xMax, yMin, yMax] = args;
          requestedZoom = zoom;
          requestedNumTiles = (xMax - xMin + 1) * (yMax - yMin + 1);
          return createMockGrid(zoom, 1950);
        }
      );

      // 1250m radius at lat 46.85
      const grid = await ElevationTileService.fetchLocalElevationGrid(
        46.855,
        -121.755,
        1250,
        15,
        16 // Quest-high budget
      );

      expect(grid).not.toBeNull();
      expect(requestedZoom).toBeLessThanOrEqual(15);
      expect(requestedZoom).toBeGreaterThanOrEqual(13);
      expect(requestedNumTiles).toBeLessThanOrEqual(16);

      spyDecode.mockRestore();
    });

    it('falls back to zoom 14 or 13 when radius exceeds tight maxTiles budget (Quest-balanced: 8 tiles)', async () => {
      let requestedZoom = 0;
      let requestedNumTiles = 0;

      const spyDecode = vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockImplementation(
        async (...args: any[]) => {
          const [zoom, xMin, xMax, yMin, yMax] = args;
          requestedZoom = zoom;
          requestedNumTiles = (xMax - xMin + 1) * (yMax - yMin + 1);
          return createMockGrid(zoom, 1900);
        }
      );

      // Large 2000m radius with tight 8-tile budget must reduce zoom below 15
      const grid = await ElevationTileService.fetchLocalElevationGrid(
        46.855,
        -121.755,
        2000,
        15,
        8 // Tight balanced budget
      );

      expect(grid).not.toBeNull();
      expect(requestedZoom).toBeLessThan(15);
      expect(requestedNumTiles).toBeLessThanOrEqual(8);

      spyDecode.mockRestore();
    });

    it('caches and reuses decoded ElevationGrid across repeated queries', async () => {
      let decodeCalls = 0;
      const mockGrid = createMockGrid(15, 2100);

      const spyDecode = vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockImplementation(
        async () => {
          decodeCalls++;
          return mockGrid;
        }
      );

      const grid1 = await ElevationTileService.fetchLocalElevationGrid(46.855, -121.755, 1000, 15, 16);
      expect(decodeCalls).toBe(1);
      expect(grid1).toBe(mockGrid);

      // Second identical call must hit localDemGridCache without re-decoding
      const grid2 = await ElevationTileService.fetchLocalElevationGrid(46.855, -121.755, 1000, 15, 16);
      expect(decodeCalls).toBe(1);
      expect(grid2).toBe(mockGrid);

      spyDecode.mockRestore();
    });
  });

  describe('LocalTerrainChunk.updateElevationGrid Dynamic Mesh Refinement', () => {
    it('recalculates vertex heights and flags isRealHighRes = true when high-res grid is applied', () => {
      const coarseGrid = createMockGrid(12, 1700);
      const highResGrid = createMockGrid(15, 2300);

      const chunk = new LocalTerrainChunk({
        localGrid: coarseGrid,
        centerLat: 46.855,
        centerLon: -121.755,
        terrainBaseElevation: 1500,
        radiusMeters: 1000,
      });

      expect(chunk.isRealHighRes).toBe(false);
      expect(chunk.currentGrid.zoom).toBe(12);

      // Apply real z15 high-res DEM
      chunk.updateElevationGrid(highResGrid, () => 300);

      expect(chunk.isRealHighRes).toBe(true);
      expect(chunk.currentGrid.zoom).toBe(15);

      // Verify center vertex has elevated to ~800m above base (2300m - 1500m)
      const centerElev = chunk.sampleLocalSurfaceY(chunk.localCenter.x, chunk.localCenter.z);
      expect(centerElev).not.toBeNull();
      expect(centerElev!).toBeGreaterThan(700);

      chunk.dispose();
    });
  });

  describe('LocalTerrainStreamer High-Res DEM Acquisition & Prefetching', () => {
    it('asynchronously acquires real station DEM and pre-populates upcoming corridor stations', async () => {
      const mockZ15 = createMockGrid(15, 2200);
      const spyFetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue(mockZ15);

      const terrain = createDummyTerrainResult();
      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: dummyRouteGeometry,
        demGrid: terrain.demGrid!,
        qualityProfile: QualityProfileManager.getProfile('quest-high'),
      });

      // Streamer update at progress 0
      streamer.update(0.0);

      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(1);

      // Verify streamer triggered fetchStationDEM for stations
      expect(spyFetch).toHaveBeenCalled();

      // Await fetchStationDEM for the active station
      const activeChunk = streamer.activeChunks[0];
      const activeGrid = await streamer.fetchStationDEM(activeChunk.centerLat, activeChunk.centerLon);

      expect(activeGrid).toBe(mockZ15);

      // Deduplication: calling fetchStationDEM for the same coordinates returns cached grid immediately
      const callCountBefore = spyFetch.mock.calls.length;
      const cachedGrid = await streamer.fetchStationDEM(activeChunk.centerLat, activeChunk.centerLon);
      expect(cachedGrid).toBe(mockZ15);
      expect(spyFetch.mock.calls.length).toBe(callCountBefore);

      streamer.dispose();
      spyFetch.mockRestore();
    });
  });
});
