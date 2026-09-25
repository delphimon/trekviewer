import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { SpatialHUD, type SpatialHUDCallbacks } from '../src/ui/SpatialHUD.ts';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { SceneManager } from '../src/core/SceneManager.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';
import type { GeoBounds, GPXWaypoint, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';
import type { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { QualityProfileManager } from '../src/terrain/QualityProfile.ts';

class MockCanvas {
  public width = 256;
  public height = 256;
  public pixelBuffer = new Uint8ClampedArray(256 * 256 * 4);
  getContext(type: string) {
    if (type !== '2d') return null;
    let currentFill = '#000000';
    return {
      canvas: this,
      get fillStyle() {
        return currentFill;
      },
      set fillStyle(val: string) {
        currentFill = val;
      },
      fillRect: () => {},
      strokeRect: () => {},
      rect: () => {},
      roundRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
      putImageData: () => {},
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillText: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      rotate: () => {},
      clearRect: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }),
      setLineDash: () => {},
      getLineDash: () => [],
      createLinearGradient: () => ({
        addColorStop: () => {},
      }),
    };
  }
}

describe('Stage X6: Persistent High-Res Across View Modes & Three-Tier Imagery Architecture', () => {
  let origDocument: any;

  const testBounds: GeoBounds = {
    minLat: 46.80,
    maxLat: 46.90,
    minLon: -121.80,
    maxLon: -121.70,
    centerLat: 46.85,
    centerLon: -121.75,
    minEle: 1000,
    maxEle: 4000,
    widthMeters: 8000,
    depthMeters: 8000,
    elevationSpan: 3000,
  };

  function createMockTrack(): TrackStats {
    const points: GPXPoint[] = [
      {
        lat: 46.851,
        lon: -121.758,
        ele: 1600,
        time: new Date('2026-09-25T08:00:00Z'),
        distanceFromStart: 0,
        elapsedSeconds: 0,
        playbackSeconds: 0,
        grade: 5,
        speed: 1.2,
        index: 0,
      },
      {
        lat: 46.855,
        lon: -121.755,
        ele: 1800,
        time: new Date('2026-09-25T08:30:00Z'),
        distanceFromStart: 1000,
        elapsedSeconds: 1800,
        playbackSeconds: 1800,
        grade: 5,
        speed: 1.2,
        index: 1,
      },
      {
        lat: 46.859,
        lon: -121.752,
        ele: 2100,
        time: new Date('2026-09-25T09:00:00Z'),
        distanceFromStart: 2000,
        elapsedSeconds: 3600,
        playbackSeconds: 3600,
        grade: 5,
        speed: 1.2,
        index: 2,
      },
    ];

    const waypoints: GPXWaypoint[] = [
      {
        lat: 46.851,
        lon: -121.758,
        ele: 1600,
        name: 'Trailhead',
      },
      {
        lat: 46.859,
        lon: -121.752,
        ele: 2100,
        name: 'Camp Muir',
      },
    ];

    return {
      name: 'Test Trail',
      bounds: testBounds,
      points,
      segments: [
        {
          points,
          distance: 2000,
          elevationGain: 500,
          elevationLoss: 0,
          startIndex: 0,
          endIndex: 2,
        },
      ],
      waypoints,
      landmarks: [],
      warnings: [],
      totalDistance: 2000,
      elevationGain: 500,
      elevationLoss: 0,
      minElevation: 1600,
      maxElevation: 2100,
      movingTime: 3600,
      avgSpeed: 2.0,
      maxSpeed: 3.0,
      totalPlaybackSeconds: 3600,
    };
  }

  const dummyHUDCallbacks: SpatialHUDCallbacks = {
    onTogglePlay: () => {},
    onToggleViewMode: () => {},
    onToggleTexture: () => {},
    onReset: () => {},
    onExitMR: () => {},
    onScrub: () => {},
    onSetSpeed: () => {},
    onStepSeconds: () => {},
    onFocusHiker: () => {},
  };

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return new MockCanvas();
        }
        return {
          appendChild: () => {},
          removeChild: () => {},
        };
      },
    };
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  describe('Three-Tier Imagery Architecture & View Mode Persistence', () => {
    it('preserves resident patches in Warm GPU set across view mode switches instead of destroying them', async () => {
      const mockCanvas = new MockCanvas() as any;

      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async () => {
        return mockCanvas as any;
      });

      const routeGeometry: RouteGeometry = {
        totalDistance: 10000,
        getTelemetryAtProgress: (p: number) => ({
          currentPoint: {
            lat: 46.85,
            lon: -121.75,
            ele: 1500,
            distanceFromStart: p * 10000,
            time: new Date(),
          },
          smoothedElevation: 1500,
          currentGrade: 0.05,
          distanceRemaining: (1 - p) * 10000,
        }),
        getTelemetryAtDistance: (d: number) => ({
          currentPoint: {
            lat: 46.85,
            lon: -121.75,
            ele: 1500,
            distanceFromStart: d,
            time: new Date(),
          },
          smoothedElevation: 1500,
          currentGrade: 0.05,
          distanceRemaining: 10000 - d,
        }),
        getPointAtProgress: () => new THREE.Vector3(0, 0, 0),
        getTangentAtProgress: () => new THREE.Vector3(0, 0, -1),
        worldPoints: [new THREE.Vector3(0, 0, 0)],
        cumulativeDistances: [0, 10000],
        points: [],
      } as any;

      const lod = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        verticalExaggeration: 1.0,
        elevationSampler: () => 1500,
      });
      lod.setRouteGeometry(routeGeometry);

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      camera.position.set(0, 1.2, 1.8);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);

      // Step 1: Initial tabletop update populates patches
      lod.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 120));

      const diagBefore = lod.getDiagnostics();
      expect(diagBefore.viewMode).toBe('diorama');
      expect(diagBefore.activePatchesCount).toBeGreaterThan(0);
      expect(diagBefore.visibleCount).toBeGreaterThan(0);
      const initialActiveCount = diagBefore.activePatchesCount;

      // Step 2: Switch to First-Person view mode
      lod.setViewMode('first-person');
      const diagAfterSwitch = lod.getDiagnostics();
      expect(diagAfterSwitch.viewMode).toBe('first-person');

      // Crucial Stage X6 Invariant: Patches are NOT wiped to 0; they reside in Warm GPU set
      expect(diagAfterSwitch.activePatchesCount).toBe(initialActiveCount);
      expect(diagAfterSwitch.visibleCount).toBe(0);
      expect(diagAfterSwitch.residentWarmCount).toBe(initialActiveCount);

      // Step 3: First-Person update activates overlapping resident patches immediately
      dioramaRoot.scale.set(1, 1, 1);
      lod.update(camera, dioramaRoot, false, 0.5);
      await new Promise((r) => setTimeout(r, 120));

      const diagFP = lod.getDiagnostics();
      expect(diagFP.viewMode).toBe('first-person');
      expect(diagFP.visibleCount).toBeGreaterThan(0);

      // Step 4: Switch back to tabletop diorama mode
      lod.setViewMode('diorama');
      const diagBack = lod.getDiagnostics();
      expect(diagBack.viewMode).toBe('diorama');
      expect(diagBack.activePatchesCount).toBeGreaterThan(0);
      expect(diagBack.visibleCount).toBe(0);
      expect(diagBack.residentWarmCount).toBe(diagBack.activePatchesCount);

      lod.dispose();
    });

    it('enforces patch budget on view mode switch from higher to lower patch budget', async () => {
      const mockCanvas = new MockCanvas() as any;

      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async () => {
        return mockCanvas as any;
      });

      const lod = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        verticalExaggeration: 1.0,
        elevationSampler: () => 1500,
      });

      // Set profile with distinct budgets
      const baseProfile = QualityProfileManager.getDefaultProfile(false);
      lod.setQualityProfile({
        ...baseProfile,
        tabletopPatches: 10,
        firstPersonPatches: 25,
      });

      expect(lod.getQualityProfile().tabletopPatches).toBe(10);
      expect(lod.getQualityProfile().firstPersonPatches).toBe(25);

      lod.setViewMode('first-person');
      expect((lod as any).maxPatches).toBe(25);

      lod.setViewMode('diorama');
      expect((lod as any).maxPatches).toBe(10);

      lod.dispose();
    });
  });

  describe('Failed-Tile Negative Caching with TTL in TileImageCache', () => {
    it('records failed tile in negative cache with TTL and fast-fails repeated requests', async () => {
      const mockProvider: ImageryProvider = {
        id: 'test-neg-prov',
        displayName: 'Test Provider',
        maxZoom: 19,
        getTileUrls: () => ['https://example.com/missing/15/1/1.png'],
        attribution: 'Test',
      };

      // Mock network failure
      let fetchAttempts = 0;
      vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockImplementation(async () => {
        fetchAttempts++;
        throw new Error('HTTP 404 Not Found');
      });

      const key = TileImageCache.getTileKey('test-neg-prov', 15, 1, 1);
      expect(TileImageCache.isNegativelyCached(key)).toBe(false);

      // First attempt triggers network and fails
      await expect(TileImageCache.loadTile(mockProvider, 15, 1, 1, 1000)).rejects.toThrow('HTTP 404 Not Found');
      expect(fetchAttempts).toBe(1);

      // Verify negative cache record
      expect(TileImageCache.isNegativelyCached(key)).toBe(true);
      expect(TileImageCache.getNegativeCacheSize()).toBe(1);
      expect(TileImageCache.getStats().negativeCacheSize).toBe(1);

      // Second attempt within TTL must fail immediately without making a network request
      await expect(TileImageCache.loadTile(mockProvider, 15, 1, 1, 1000)).rejects.toThrow('in negative cache');
      expect(fetchAttempts).toBe(1); // Still 1! No network storm

      // Expire negative cache entry manually
      const entry = (TileImageCache as any).negativeCache.get(key);
      if (entry) {
        entry.timestamp = entry.timestamp - 70000; // past 60s TTL
      }

      // Next attempt after TTL expiry should retry network
      await expect(TileImageCache.loadTile(mockProvider, 15, 1, 1, 1000)).rejects.toThrow('HTTP 404 Not Found');
      expect(fetchAttempts).toBe(2);
    });

    it('uses 15s TTL for timeouts and 60s for HTTP 404/network errors', async () => {
      const mockProvider: ImageryProvider = {
        id: 'test-prov-ttl',
        displayName: 'Test TTL Provider',
        maxZoom: 19,
        getTileUrls: (z, x, y) => [`https://example.com/tile/${z}/${x}/${y}.png`],
        attribution: 'Test',
      };

      vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockImplementation(async (url: any) => {
        if (typeof url === 'string' && url.includes('timeout')) {
          throw new Error('Tile load timeout after 4500ms');
        }
        throw new Error('404 Not Found');
      });

      const keyTimeout = TileImageCache.getTileKey('test-prov-ttl', 15, 1, 1);
      const key404 = TileImageCache.getTileKey('test-prov-ttl', 15, 2, 2);

      // Timeout failure
      await expect(
        TileImageCache.loadTile(
          { ...mockProvider, getTileUrls: () => ['https://example.com/timeout.png'] },
          15,
          1,
          1
        )
      ).rejects.toThrow();

      // 404 failure
      await expect(
        TileImageCache.loadTile(
          { ...mockProvider, getTileUrls: () => ['https://example.com/404.png'] },
          15,
          2,
          2
        )
      ).rejects.toThrow();

      const entryTimeout = (TileImageCache as any).negativeCache.get(keyTimeout);
      const entry404 = (TileImageCache as any).negativeCache.get(key404);

      expect(entryTimeout.retryAfterMs).toBe(15000);
      expect(entry404.retryAfterMs).toBe(60000);
    });

    it('clear() flushes the negative cache', async () => {
      const mockProvider: ImageryProvider = {
        id: 'test-clear-prov',
        displayName: 'Test',
        maxZoom: 19,
        getTileUrls: () => ['https://example.com/tile.png'],
        attribution: 'Test',
      };

      vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockRejectedValue(new Error('Network failure'));

      await expect(TileImageCache.loadTile(mockProvider, 15, 1, 1)).rejects.toThrow();
      expect(TileImageCache.getNegativeCacheSize()).toBe(1);

      TileImageCache.clear();
      expect(TileImageCache.getNegativeCacheSize()).toBe(0);
      expect(TileImageCache.getStats().negativeCacheSize).toBe(0);
    });
  });

  describe('Color-Space Correctness and Physical Terrain Material Properties', () => {
    it('sets sRGB colorSpace and non-metallic properties on adaptive imagery patches', () => {
      const mockCanvas = new MockCanvas() as any;
      const lod = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        verticalExaggeration: 1.0,
        elevationSampler: () => 1500,
      });

      const key = 'satellite:15:100:200';
      (lod as any).createAndMountPatch(key, 15, 100, 200, mockCanvas, 1.0, 1000);

      const patch = (lod as any).patches.get(key);
      expect(patch).toBeDefined();

      const mat = patch.mesh.material as THREE.MeshStandardMaterial;
      expect(mat.isMeshStandardMaterial).toBe(true);
      expect(mat.roughness).toBe(0.9);
      expect(mat.metalness).toBe(0.0);

      const tex = mat.map;
      expect(tex).toBeDefined();
      expect(tex?.colorSpace).toBe(THREE.SRGBColorSpace);

      lod.dispose();
    });

    it('configures base terrain material with physical non-metallic properties', async () => {
      const mockTrack = createMockTrack();

      const mockGrid: ElevationGrid = {
        zoom: 13,
        tileXMin: 1322,
        tileXMax: 1323,
        tileYMin: 2883,
        tileYMax: 2884,
        numTilesX: 2,
        numTilesY: 2,
        width: 512,
        height: 512,
        data: new Float32Array(512 * 512).fill(2000),
        tileValidity: new Uint8Array(4).fill(1),
        minElevation: 1500,
        maxElevation: 2500,
        isRealDEM: true,
      };

      const preparedElevation = {
        demGrid: mockGrid,
        terrainGeoBounds: testBounds,
        elevationSamplerForGeo: () => 1700,
      };

      const terrain = await TerrainGenerator.generate(
        mockTrack,
        () => {},
        undefined,
        1.0,
        false,
        preparedElevation
      );

      expect(terrain.terrainMesh).toBeDefined();
      const baseMat = terrain.terrainMesh.material as THREE.MeshStandardMaterial;
      expect(baseMat.roughness).toBe(0.9);
      expect(baseMat.metalness).toBe(0.0);

      terrain.dispose();
    });

    it('sets sRGB colorSpace on TextureProvider generated textures', async () => {
      const mockCanvas = new MockCanvas() as any;

      const tileGrid = {
        tileXMin: 100,
        tileXMax: 101,
        tileYMin: 200,
        tileYMax: 201,
        numTilesX: 2,
        numTilesY: 2,
        totalTiles: 4,
        zoom: 14,
        style: 'satellite' as const,
      };

      // Mock TileImageCache.loadTile returning mock canvas
      vi.spyOn(TileImageCache, 'loadTile').mockResolvedValue(mockCanvas);

      const satTex = await TextureProvider.fetchSatelliteTexture(tileGrid);
      expect(satTex?.colorSpace).toBe(THREE.SRGBColorSpace);

      const hybridTex = await TextureProvider.fetchHybridTexture(tileGrid);
      expect(hybridTex?.colorSpace).toBe(THREE.SRGBColorSpace);

      const topoTex = await TextureProvider.fetchTopoTexture(tileGrid);
      expect(topoTex?.colorSpace).toBe(THREE.SRGBColorSpace);

      const proceduralTopo = TextureProvider.generateTopoTexture(
        testBounds,
        tileGrid,
        () => 1500
      );
      expect(proceduralTopo.colorSpace).toBe(THREE.SRGBColorSpace);
    });

    it('SpatialHUD texture has sRGB colorSpace and plane material has toneMapped: false', () => {
      const mockTrack = createMockTrack();

      const hud = new SpatialHUD(mockTrack, dummyHUDCallbacks);
      const hudMesh = hud.group.getObjectByName('SpatialHUDMesh') as THREE.Mesh;
      expect(hudMesh).toBeDefined();

      const hudMat = hudMesh.material as THREE.MeshBasicMaterial;
      expect(hudMat.toneMapped).toBe(false);

      const hudTex = hudMat.map;
      expect(hudTex).toBeDefined();
      expect(hudTex?.colorSpace).toBe(THREE.SRGBColorSpace);

      hud.dispose();
    });

    it('Waypoint label sprite material has toneMapped: false and sRGB colorSpace', () => {
      const wp: GPXWaypoint = {
        name: 'Camp Muir',
        lat: 46.835,
        lon: -121.732,
        ele: 3072,
        type: 'summit',
      };

      const diorama = DioramaBase.create(testBounds, -80, [wp], 1000, undefined, 1.0);
      const sprite = diorama.getObjectByName('WaypointLabelSprite') as THREE.Sprite;
      expect(sprite).toBeDefined();

      const spriteMat = sprite.material;
      expect(spriteMat.toneMapped).toBe(false);
      expect(spriteMat.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    });
  });

  describe('XR Safety & Session Correctness', () => {
    it('setXREnergyMode toggles shadows without calling setFramebufferScaleFactor', () => {
      const setFramebufferSpy = vi.fn();
      const mockSceneManager = {
        renderer: {
          shadowMap: { enabled: true },
          xr: {
            setFramebufferScaleFactor: setFramebufferSpy,
          },
        },
        sunLight: { castShadow: true },
      };

      SceneManager.prototype.setXREnergyMode.call(mockSceneManager as any, true);
      expect(setFramebufferSpy).not.toHaveBeenCalled();
      expect(mockSceneManager.renderer.shadowMap.enabled).toBe(false);
      expect(mockSceneManager.sunLight.castShadow).toBe(false);

      SceneManager.prototype.setXREnergyMode.call(mockSceneManager as any, false);
      expect(setFramebufferSpy).not.toHaveBeenCalled();
      expect(mockSceneManager.renderer.shadowMap.enabled).toBe(true);
      expect(mockSceneManager.sunLight.castShadow).toBe(true);
    });
  });
});
