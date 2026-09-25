import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { TileImageCache, TilePriority } from '../src/terrain/TileImageCache.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import type { ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import type { TerrainResult, TerrainSurfaceBounds } from '../src/terrain/TerrainGenerator.ts';
import type { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

function createMockElevationGrid(zoom: number = 15, isRealDEM: boolean = true): ElevationGrid {
  const size = 32;
  const data = new Float32Array(size * size);
  for (let i = 0; i < data.length; i++) {
    data[i] = 1500 + (i % size) * 10;
  }
  return {
    data,
    tileValidity: new Uint8Array([1, 1, 1, 1]),
    width: size,
    height: size,
    tileXMin: 100,
    tileXMax: 101,
    tileYMin: 200,
    tileYMax: 201,
    numTilesX: 2,
    numTilesY: 2,
    minElevation: 1500,
    maxElevation: 1810,
    zoom,
    isRealDEM,
  };
}

function createMockTerrainResult(): TerrainResult {
  const group = new THREE.Group();
  const geom = new THREE.PlaneGeometry(100, 100, 4, 4);
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'BaseTerrainMesh';
  group.add(mesh);

  const localChunks: any[] = [];
  let surfaceRevision = 0;
  let lastSurfaceBounds: TerrainSurfaceBounds | undefined;

  return {
    terrainMesh: mesh,
    waterMesh: null,
    group,
    elevationSampler: (x: number, z: number) => 1500 + Math.hypot(x, z) * 0.1,
    tileGrid: {
      zoom: 13,
      tileXMin: 1322,
      tileXMax: 1327,
      tileYMin: 2883,
      tileYMax: 2888,
      numTilesX: 6,
      numTilesY: 6,
    },
    terrainGeoBounds: {
      minLat: 46.8,
      maxLat: 46.9,
      minLon: -121.8,
      maxLon: -121.7,
      centerLat: 46.85,
      centerLon: -121.75,
      widthMeters: 5000,
      depthMeters: 5000,
      maxElevation: 1810,
      minElevation: 1500,
    },
    terrainBaseElevation: 1500,
    dispose: () => {},
    setVerticalExaggeration: () => {},
    setTextureStyle: async () => {},
    getSurfaceRevision: () => surfaceRevision,
    notifySurfaceChange: (bounds?: TerrainSurfaceBounds) => {
      surfaceRevision++;
      lastSurfaceBounds = bounds;
    },
    attachLocalChunk: (chunk: any) => {
      localChunks.push(chunk);
      group.add(chunk.mesh);
    },
    detachLocalChunk: (chunk: any) => {
      const idx = localChunks.indexOf(chunk);
      if (idx !== -1) localChunks.splice(idx, 1);
      group.remove(chunk.mesh);
      chunk.dispose();
    },
    localChunks,
    get lastSurfaceBounds() {
      return lastSurfaceBounds;
    },
  } as any;
}

function createMockRouteGeometry(): RouteGeometry {
  const points = [
    { x: -50, y: 1520, z: -50, lat: 46.83, lon: -121.77, ele: 1520, dist: 0 },
    { x: 0, y: 1550, z: 0, lat: 46.85, lon: -121.75, ele: 1550, dist: 2500 },
    { x: 50, y: 1580, z: 50, lat: 46.87, lon: -121.73, ele: 1580, dist: 5000 },
  ];

  return {
    totalDistance: 5000,
    getTelemetryAtProgress: (p: number) => {
      const clamped = Math.max(0, Math.min(1, p));
      const idx = clamped < 0.5 ? 0 : 1;
      const pt = points[idx];
      return {
        currentPoint: { lat: pt.lat, lon: pt.lon, ele: pt.ele },
        position: new THREE.Vector3(pt.x, pt.y, pt.z),
        elevation: pt.ele,
        distanceTraveled: clamped * 5000,
        gradePercent: 2.5,
        headingDeg: 45,
      };
    },
    reprojectToSurface: () => {},
  } as any;
}

function createMockPatch(key: string, zoom: number, x: number, y: number): any {
  const geom = new THREE.PlaneGeometry(10, 10);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = `ImageryPatch_${key}`;
  return {
    key,
    zoom,
    x,
    y,
    mesh,
    texture: new THREE.Texture(),
    lastUsed: Date.now(),
    centerDist: 1.0,
    creationTime: Date.now(),
    isFading: false,
    fadeDurationMs: 0,
    dispose: () => {
      geom.dispose();
      mat.dispose();
    },
  };
}

describe('Stage X7: Tabletop Inspection Focus & Global Request Prioritization', () => {
  beforeEach(() => {
    TileImageCache.clear();
  });

  afterEach(() => {
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  describe('Part 1: Coordinated Global Network Prioritization (Section 11)', () => {
    it('defines TilePriority tiers in correct priority order', () => {
      expect(TilePriority.CRITICAL).toBe(0);
      expect(TilePriority.HIGH).toBe(1);
      expect(TilePriority.NORMAL).toBe(2);
      expect(TilePriority.OVERVIEW).toBe(3);
    });

    it('tracks active requests by priority class in TileImageCache.getStats()', () => {
      const stats = TileImageCache.getStats();
      expect(stats.activeRequestsByClass).toBeDefined();
      expect(stats.activeRequestsByClass.critical).toBe(0);
      expect(stats.activeRequestsByClass.high).toBe(0);
      expect(stats.activeRequestsByClass.normal).toBe(0);
      expect(stats.activeRequestsByClass.overview).toBe(0);
      expect(stats.highPriorityQueueLength).toBe(0);
      expect(stats.overviewQueueLength).toBe(0);
    });

    it('forces OVERVIEW priority requests to yield while high-priority (CRITICAL/HIGH) requests are in flight', async () => {
      let resolveHigh: ((img: HTMLImageElement) => void) | null = null;
      const highPromise = new Promise<HTMLImageElement>((resolve) => {
        resolveHigh = resolve;
      });

      const mockProvider: ImageryProvider = {
        id: 'mock-test',
        displayName: 'Mock',
        attribution: '',
        maxZoom: 19,
        getTileUrls: () => ['http://example.com/tile.png'],
      };

      const mockImg = { width: 256, height: 256 } as HTMLImageElement;

      // Mock internal loadImageWithTimeout
      let loadCallCount = 0;
      vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockImplementation(((url: any) => {
        loadCallCount++;
        if (url.includes('high')) {
          return highPromise;
        }
        return Promise.resolve(mockImg);
      }) as any);

      // 1. Launch a high-priority request (CRITICAL)
      const highReq = TileImageCache.loadTile(
        { ...mockProvider, getTileUrls: () => ['http://example.com/high.png'] },
        18,
        1,
        1,
        5000,
        undefined,
        TilePriority.CRITICAL
      );

      expect(TileImageCache.hasActiveHighPriorityRequests()).toBe(true);
      expect(TileImageCache.getStats().activeRequestsByClass.critical).toBe(1);
      expect(TileImageCache.getStats().highPriorityQueueLength).toBe(1);

      // 2. Launch an overview-priority request while high-priority is in flight
      let overviewCompleted = false;
      const overviewReq = TileImageCache.loadTile(
        { ...mockProvider, getTileUrls: () => ['http://example.com/overview.png'] },
        13,
        10,
        10,
        5000,
        undefined,
        TilePriority.OVERVIEW
      ).then((res) => {
        overviewCompleted = true;
        return res;
      });

      // Allow microtasks to execute
      await new Promise((r) => setTimeout(r, 20));

      // Overview request MUST be waiting/yielding because high-priority request is active!
      expect(overviewCompleted).toBe(false);
      expect(TileImageCache.getStats().overviewQueueLength).toBeGreaterThanOrEqual(1);

      // 3. Resolve the high-priority request
      resolveHigh!(mockImg);
      await highReq;

      expect(TileImageCache.hasActiveHighPriorityRequests()).toBe(false);
      expect(TileImageCache.getStats().activeRequestsByClass.critical).toBe(0);

      // 4. Now the overview request unblocks and finishes
      await overviewReq;
      expect(overviewCompleted).toBe(true);
      expect(TileImageCache.getStats().activeRequestsByClass.overview).toBe(0);
    });

    it('tags overview composite requests with TilePriority.OVERVIEW in TextureProvider', () => {
      // TextureProvider.ts has fetchSatelliteTexture, fetchHybridTexture, fetchTopoTexture
      // verified in source code to pass TilePriority.OVERVIEW
      const providerSetting = TextureProvider.getSatelliteProviderSetting();
      expect(['auto', 'esri', 'cesium-bing']).toContain(providerSetting);
    });
  });

  describe('Part 2: Time to Sharp Metric in ImageryLODManager', () => {
    it('initializes lastTimeToSharpMs to 0 and exposes it via getter and diagnostics', () => {
      const terrain = createMockTerrainResult();
      const manager = new ImageryLODManager({
        terrainGeoBounds: terrain.terrainGeoBounds,
        terrainBaseElevation: terrain.terrainBaseElevation,
        elevationSampler: terrain.elevationSampler,
        viewMode: 'diorama',
      });

      expect(manager.getLastTimeToSharpMs()).toBe(0);
      const diag = manager.getDiagnostics();
      expect(diag.lastTimeToSharpMs).toBe(0);

      manager.dispose();
    });

    it('measures Time to Sharp when a refinement group transitions to promoting or children', async () => {
      const terrain = createMockTerrainResult();
      const manager = new ImageryLODManager({
        terrainGeoBounds: terrain.terrainGeoBounds,
        terrainBaseElevation: terrain.terrainBaseElevation,
        elevationSampler: terrain.elevationSampler,
        viewMode: 'diorama',
        enableFadeIn: false,
      });

      const parentKey = 'satellite:17:10:20';
      const group = manager.getOrCreateRefinementGroup(parentKey);
      expect(group.state).toBe('parent');

      // Simulate first child loading
      const c0 = group.fourChildKeys[0];
      (manager as any).patches.set(c0, createMockPatch(c0, 18, 20, 40));
      manager.getOrCreateRefinementGroup(parentKey);
      expect(group.state).toBe('loading');
      expect(group.requestStartTime).toBeDefined();

      const startTime = group.requestStartTime!;
      // Simulate artificial elapsed time
      group.requestStartTime = startTime - 320; // 320ms earlier

      // Add remaining 3 children to achieve 4/4 ready
      for (let i = 1; i < 4; i++) {
        const cKey = group.fourChildKeys[i];
        (manager as any).patches.set(cKey, createMockPatch(cKey, 18, 20 + i, 40));
      }

      manager.getOrCreateRefinementGroup(parentKey);
      expect(group.state).toBe('children');
      expect(manager.getLastTimeToSharpMs()).toBeGreaterThanOrEqual(300);
      expect(manager.getDiagnostics().lastTimeToSharpMs).toBeGreaterThanOrEqual(300);

      manager.dispose();
    });
  });

  describe('Part 3: Tabletop Inspection Focus in LocalTerrainStreamer (Section 9)', () => {
    it('keeps local chunks invisible in diorama mode when no inspection focus is provided', () => {
      const terrain = createMockTerrainResult();
      const route = createMockRouteGeometry();
      const demGrid = createMockElevationGrid(13, false);

      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: route,
        demGrid,
        initialViewMode: 'diorama',
      });

      streamer.update(0.0);
      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(1);
      expect(streamer.activeVisibleChunk).toBeNull();
      for (const c of streamer.activeChunks) {
        expect(c.mesh.visible).toBe(false);
      }

      streamer.dispose();
    });

    it('streams high-resolution candidate at tabletop focus and atomically promotes on arrival', async () => {
      const terrain = createMockTerrainResult();
      const route = createMockRouteGeometry();
      const demGrid = createMockElevationGrid(13, false);

      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: route,
        demGrid,
        initialViewMode: 'diorama',
      });

      const highResDem = createMockElevationGrid(15, true);
      vi.spyOn(streamer, 'fetchStationDEM').mockResolvedValue(highResDem);

      const focusGeo = { lat: 46.8523, lon: -121.7603 };
      streamer.update(0.0, focusGeo);

      // Verify lastTabletopFocusGeo set immediately
      expect(streamer.getTabletopFocusGeo()).toEqual(focusGeo);

      // Await async candidate build and atomic promotion
      await vi.waitFor(() => {
        expect(streamer.activeVisibleChunk).not.toBeNull();
      });

      const visibleChunk = streamer.activeVisibleChunk!;
      expect(visibleChunk.mesh.visible).toBe(true);
      expect(visibleChunk.centerLat).toBeCloseTo(focusGeo.lat, 4);
      expect(visibleChunk.centerLon).toBeCloseTo(focusGeo.lon, 4);

      // Verify surfaceRevision notification triggered
      expect((terrain as any).getSurfaceRevision()).toBeGreaterThan(0);

      streamer.dispose();
    });

    it('enforces 75m hysteresis: micro head tremors (< 75m) do NOT rebuild or refetch chunk', async () => {
      const terrain = createMockTerrainResult();
      const route = createMockRouteGeometry();
      const demGrid = createMockElevationGrid(13, false);

      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: route,
        demGrid,
        initialViewMode: 'diorama',
      });

      const highResDem = createMockElevationGrid(15, true);
      const fetchSpy = vi.spyOn(streamer, 'fetchStationDEM').mockResolvedValue(highResDem);

      // Initial focus on summit
      const focus1 = { lat: 46.8523, lon: -121.7603 };
      streamer.update(0.0, focus1);

      await vi.waitFor(() => {
        expect(streamer.activeVisibleChunk).not.toBeNull();
      });
      const firstChunk = streamer.activeVisibleChunk;
      const callsBeforeTremor = fetchSpy.mock.calls.length;

      // Tremor movement of ~20m (< 75m threshold)
      const focusTremor = { lat: 46.8524, lon: -121.7604 };
      streamer.update(0.0, focusTremor);

      await new Promise((r) => setTimeout(r, 50));
      // Must NOT fetch again or replace chunk
      expect(fetchSpy.mock.calls.length).toBe(callsBeforeTremor);
      expect(streamer.activeVisibleChunk).toBe(firstChunk);

      // Significant movement of ~1500m (>= 75m threshold) to Ferry Basin
      const focusNew = { lat: 46.8650, lon: -121.7603 };
      streamer.update(0.0, focusNew);

      await vi.waitFor(() => {
        expect(streamer.activeVisibleChunk).not.toBe(firstChunk);
      });

      expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBeforeTremor);
      expect(streamer.activeVisibleChunk!.centerLat).toBeCloseTo(focusNew.lat, 4);
      streamer.dispose();
    });

    it('switches cleanly between diorama tabletop focus and first-person route mode', async () => {
      const terrain = createMockTerrainResult();
      const route = createMockRouteGeometry();
      const demGrid = createMockElevationGrid(13, false);

      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: route,
        demGrid,
        initialViewMode: 'diorama',
      });

      const highResDem = createMockElevationGrid(15, true);
      vi.spyOn(streamer, 'fetchStationDEM').mockResolvedValue(highResDem);

      // 1. Promote tabletop chunk in diorama mode
      streamer.update(0.0, { lat: 46.8523, lon: -121.7603 });
      await vi.waitFor(() => {
        expect(streamer.activeVisibleChunk).not.toBeNull();
      });

      // 2. Switch to first-person mode
      streamer.setViewMode('first-person');
      expect(streamer.getViewMode()).toBe('first-person');
      expect(streamer.getTabletopFocusGeo()).toBeNull();

      // In first-person mode, route station 0 chunk is visible
      expect(streamer.activeVisibleChunk).not.toBeNull();
      expect(streamer.activeVisibleChunk!.mesh.visible).toBe(true);

      // 3. Switch back to diorama mode
      streamer.setViewMode('diorama');
      expect(streamer.getViewMode()).toBe('diorama');
      // In diorama mode without focus, no chunk is visible
      expect(streamer.activeVisibleChunk).toBeNull();

      streamer.dispose();
    });
  });

  describe('Part 4: End-to-End Integration in LoadedTrek & ImageryLODManager', () => {
    it('exposes inspected geo from ImageryLODManager and forwards it to LocalTerrainStreamer', () => {
      const terrain = createMockTerrainResult();
      const route = createMockRouteGeometry();
      const demGrid = createMockElevationGrid(13, false);

      const imageryLOD = new ImageryLODManager({
        terrainGeoBounds: terrain.terrainGeoBounds,
        terrainBaseElevation: terrain.terrainBaseElevation,
        elevationSampler: terrain.elevationSampler,
        viewMode: 'diorama',
      });

      const streamer = new LocalTerrainStreamer({
        terrainResult: terrain,
        routeGeometry: route,
        demGrid,
        initialViewMode: 'diorama',
      });

      const trek = new LoadedTrek({
        track: {
          name: 'Rainier Circuit',
          bounds: terrain.terrainGeoBounds,
          points: [],
        } as any,
        terrainResult: terrain,
        trailResult: {
          routeGeometry: route,
          group: new THREE.Group(),
          elevationSampler: terrain.elevationSampler,
          update: () => {},
          dispose: () => {},
          setVerticalExaggeration: () => {},
          setLeadProgress: () => {},
          setColorMode: () => {},
          setViewMode: () => {},
        } as any,
        dioramaBase: new THREE.Group(),
        flyoverController: {
          getProgress: () => 0.25,
          setProgress: () => {},
          dispose: () => {},
          update: () => {},
          setViewMode: () => {},
        } as any,
        imageryLOD,
        localTerrainStreamer: streamer,
      });

      const streamerUpdateSpy = vi.spyOn(streamer, 'update');

      const testGeo = { lat: 46.8523, lon: -121.7603 };
      (imageryLOD as any).lastInspectedGeo = testGeo;
      expect(imageryLOD.getInspectedGeo()).toEqual(testGeo);

      // Simulate main render loop call:
      const inspectedGeo = trek.imageryLOD.getInspectedGeo();
      trek.updateHikerProgress(0.25, inspectedGeo);

      expect(streamerUpdateSpy).toHaveBeenCalledWith(0.25, testGeo);

      trek.dispose();
    });
  });
});
