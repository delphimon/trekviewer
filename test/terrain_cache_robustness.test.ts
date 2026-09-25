import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { SpatialHUD } from '../src/ui/SpatialHUD.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import { tileToLatLon } from '../src/gpx/Coordinates.ts';
import type { GeoBounds, TrackStats } from '../src/gpx/TrackTypes.ts';

describe('Stage O: Terrain, Cache, and Memory Robustness', () => {
  let origImage: any;
  let origDocument: any;

  beforeEach(() => {
    origImage = (globalThis as any).Image;
    origDocument = (globalThis as any).document;

    TileImageCache.clear();
    TileImageCache.setTargetDevice(false); // Reset to desktop default
    TextureProvider.setMaxAnisotropy(4);

    const mockCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      measureText: () => ({ width: 50 }),
      roundRect: vi.fn(),
      drawImage: vi.fn(),
      setLineDash: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 1024,
            height: 1024,
            getContext: () => mockCtx,
          };
        }
        return {};
      },
    };
  });

  afterEach(() => {
    (globalThis as any).Image = origImage;
    (globalThis as any).document = origDocument;
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  describe('Requirement #104: Dynamic Anisotropy Configuration', () => {
    it('sets and retrieves renderer max anisotropy with bounds [1, 16]', () => {
      TextureProvider.setMaxAnisotropy(8);
      assert.strictEqual(TextureProvider.getMaxAnisotropy(), 8);

      // Clamp upper bound to 16
      TextureProvider.setMaxAnisotropy(32);
      assert.strictEqual(TextureProvider.getMaxAnisotropy(), 16);

      // Clamp lower bound to 1
      TextureProvider.setMaxAnisotropy(0);
      assert.strictEqual(TextureProvider.getMaxAnisotropy(), 1);

      // Ignore NaN or negative
      TextureProvider.setMaxAnisotropy(12);
      TextureProvider.setMaxAnisotropy(NaN);
      assert.strictEqual(TextureProvider.getMaxAnisotropy(), 12);
    });
  });

  describe('Requirement #105: TileImageCache Memory Instrumentation & Device Profiles', () => {
    it('configures Quest vs Desktop limits correctly', () => {
      TileImageCache.setTargetDevice(true); // Quest (Stage W: 240 entries / 64MB in quest-high)
      const questStats = TileImageCache.getStats();
      assert.strictEqual(questStats.maxEntries, 240);
      assert.strictEqual(questStats.maxDecodedBytes, 64 * 1024 * 1024);

      TileImageCache.setTargetDevice(false); // Desktop (Stage W: 360 entries / 96MB in desktop-high)
      const deskStats = TileImageCache.getStats();
      assert.strictEqual(deskStats.maxEntries, 360);
      assert.strictEqual(deskStats.maxDecodedBytes, 96 * 1024 * 1024);
    });

    it('instruments decoded bytes accurately and evicts on entry count and byte capacity', () => {
      // Set small limits for test: 3 entries, 2 * 256KB max bytes
      const TILE_BYTES = 256 * 256 * 4; // 262,144 bytes
      TileImageCache.setLimits(3, TILE_BYTES * 2); // Cap at 2 tiles by bytes

      const mockImg = (w: number = 256, h: number = 256) => {
        return {
          naturalWidth: w,
          naturalHeight: h,
          width: w,
          height: h,
          src: 'data:image/png;base64,mock',
        } as unknown as HTMLImageElement;
      };

      TileImageCache.set('tile:1', mockImg());
      assert.strictEqual(TileImageCache.size(), 1);
      assert.strictEqual(TileImageCache.getEstimatedDecodedBytes(), TILE_BYTES);

      TileImageCache.set('tile:2', mockImg());
      assert.strictEqual(TileImageCache.size(), 2);
      assert.strictEqual(TileImageCache.getEstimatedDecodedBytes(), TILE_BYTES * 2);

      // Adding 3rd tile must evict oldest tile:1 because byte limit (2 * TILE_BYTES) is exceeded
      TileImageCache.set('tile:3', mockImg());
      assert.strictEqual(TileImageCache.size(), 2);
      assert.strictEqual(TileImageCache.has('tile:1'), false, 'Oldest tile:1 should be evicted');
      assert.strictEqual(TileImageCache.has('tile:2'), true);
      assert.strictEqual(TileImageCache.has('tile:3'), true);
      assert.strictEqual(TileImageCache.getEstimatedDecodedBytes(), TILE_BYTES * 2);

      // Updating existing tile refreshes bytes without double-counting
      TileImageCache.set('tile:2', mockImg(128, 128)); // Smaller: 128*128*4 = 65,536 bytes
      const expectedBytes = 65536 + TILE_BYTES;
      assert.strictEqual(TileImageCache.getEstimatedDecodedBytes(), expectedBytes);

      // Clear cleans up all bytes
      TileImageCache.clear();
      assert.strictEqual(TileImageCache.size(), 0);
      assert.strictEqual(TileImageCache.getEstimatedDecodedBytes(), 0);
    });
  });

  describe('Requirement #102: Normalized Bilinear DEM Interpolation', () => {
    const zoom = 12;
    const tileXMin = 2000;
    const tileXMax = 2000;
    const tileYMin = 1500;
    const tileYMax = 1500;
    const width = 256;
    const height = 256;

    it('returns exact bilinear interpolation when all 4 corners are valid', () => {
      const data = new Float32Array(width * height);
      const tileValidity = new Uint8Array([1]);

      // Set pixel values at x0=100, x1=101, y0=100, y1=101
      data[100 * width + 100] = 100;
      data[100 * width + 101] = 200;
      data[101 * width + 100] = 300;
      data[101 * width + 101] = 400;

      const grid: ElevationGrid = {
        width,
        height,
        zoom,
        tileXMin,
        tileXMax,
        tileYMin,
        tileYMax,
        numTilesX: 1,
        numTilesY: 1,
        data,
        tileValidity,
        minElevation: 100,
        maxElevation: 400,
        isRealDEM: true,
      };

      // Sample exactly halfway between pixel (100, 100) and (101, 101)
      const coord = tileToLatLon(tileXMin + 100.5 / 256, tileYMin + 100.5 / 256, zoom);
      const mid = ElevationTileService.sampleElevation(grid, coord.lat, coord.lon);
      assert.strictEqual(mid.isValid, true);
      // (100 + 200 + 300 + 400) / 4 = 250
      assert.ok(Math.abs(mid.elevation - 250) < 0.1);
    });

    it('smoothly interpolates with normalized weighting when one or more corners are NaN', () => {
      const data = new Float32Array(width * height);
      const tileValidity = new Uint8Array([1]);

      // Set pixel values: e00=100, e10=NaN, e01=300, e11=400
      data[100 * width + 100] = 100;
      data[100 * width + 101] = NaN;
      data[101 * width + 100] = 300;
      data[101 * width + 101] = 400;

      const grid: ElevationGrid = {
        width,
        height,
        zoom,
        tileXMin,
        tileXMax,
        tileYMin,
        tileYMax,
        numTilesX: 1,
        numTilesY: 1,
        data,
        tileValidity,
        minElevation: 100,
        maxElevation: 400,
        isRealDEM: true,
      };

      // At fx=0.5, fy=0.5:
      // w00 = 0.25, w10 = 0.25 (NaN), w01 = 0.25, w11 = 0.25
      // Valid weights sum = 0.25 + 0.25 + 0.25 = 0.75
      // Valid elevation sum = 0.25*100 + 0.25*300 + 0.25*400 = 25 + 75 + 100 = 200
      // Normalized elevation = 200 / 0.75 = 266.6667
      const coord = tileToLatLon(tileXMin + 100.5 / 256, tileYMin + 100.5 / 256, zoom);
      const mid = ElevationTileService.sampleElevation(grid, coord.lat, coord.lon);
      assert.strictEqual(mid.isValid, true);
      assert.ok(Math.abs(mid.elevation - (200 / 0.75)) < 0.2);
    });

    it('returns isValid: false when all 4 corners are NaN', () => {
      const data = new Float32Array(width * height);
      data.fill(NaN);
      const tileValidity = new Uint8Array([1]);

      const grid: ElevationGrid = {
        width,
        height,
        zoom,
        tileXMin,
        tileXMax,
        tileYMin,
        tileYMax,
        numTilesX: 1,
        numTilesY: 1,
        data,
        tileValidity,
        minElevation: 0,
        maxElevation: 0,
        isRealDEM: true,
      };

      const coord = tileToLatLon(tileXMin + 100.5 / 256, tileYMin + 100.5 / 256, zoom);
      const res = ElevationTileService.sampleElevation(grid, coord.lat, coord.lon);
      assert.strictEqual(res.isValid, false);
      assert.ok(Number.isNaN(res.elevation));
    });
  });

  describe('Requirement #100 & #101: Bounded Concurrency & DEM Tile Cap', () => {
    it('bounds tile concurrency to pool of workers (max 6)', async () => {
      let activeConcurrency = 0;
      let maxRecordedConcurrency = 0;

      // Mock TileImageCache.loadTile to track concurrent in-flight calls
      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async () => {
        activeConcurrency++;
        maxRecordedConcurrency = Math.max(maxRecordedConcurrency, activeConcurrency);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeConcurrency--;
        return {
          width: 256,
          height: 256,
          naturalWidth: 256,
          naturalHeight: 256,
        } as unknown as HTMLImageElement;
      });

      // Bounds covering ~9-16 tiles
      const bounds: GeoBounds = {
        minLat: 46.80,
        maxLat: 46.88,
        minLon: 8.20,
        maxLon: 8.35,
        centerLat: 46.84,
        centerLon: 8.27,
        minEle: 1000,
        maxEle: 3000,
        elevationSpan: 2000,
        widthMeters: 12000,
        depthMeters: 10000,
      };

      await ElevationTileService.fetchElevationGrid(bounds, 0.05);

      assert.ok(
        maxRecordedConcurrency <= 6,
        `Max concurrency (${maxRecordedConcurrency}) must be <= 6`
      );
    });

    it('enforces tile cap (<= 25 tiles) by stepping down zoom with while loop', async () => {
      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async () => {
        return {
          width: 256,
          height: 256,
          naturalWidth: 256,
          naturalHeight: 256,
        } as unknown as HTMLImageElement;
      });

      // Very wide bounds that span hundreds of tiles at initial zoom (e.g. 13)
      const wideBounds: GeoBounds = {
        minLat: 45.0,
        maxLat: 47.0,
        minLon: 6.0,
        maxLon: 9.0,
        centerLat: 46.0,
        centerLon: 7.5,
        minEle: 500,
        maxEle: 4810,
        elevationSpan: 4310,
        widthMeters: 230000,
        depthMeters: 220000,
      };

      const grid = await ElevationTileService.fetchElevationGrid(wideBounds, 0.05);
      assert.ok(grid !== null);
      const tilesX = grid!.tileXMax - grid!.tileXMin + 1;
      const tilesY = grid!.tileYMax - grid!.tileYMin + 1;
      const totalTiles = tilesX * tilesY;
      assert.ok(
        totalTiles <= 25 || grid!.zoom === 10,
        `Total DEM tiles (${totalTiles}) must be <= 25 or clamped at min zoom 10`
      );
    });
  });

  describe('Requirement #103: Procedural Topo Contour Green Channel Math', () => {
    it('verifies contour dimming decrements green from green rather than red', () => {
      let putData: Uint8ClampedArray | null = null;
      (globalThis as any).document = {
        createElement: (tag: string) => {
          if (tag === 'canvas') {
            return {
              width: 10,
              height: 10,
              getContext: () => ({
                createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
                putImageData: (imgData: any) => {
                  putData = imgData.data;
                },
              }),
            };
          }
          return {};
        },
      };

      const bounds: GeoBounds = {
        minLat: 46.5,
        maxLat: 46.6,
        minLon: 8.0,
        maxLon: 8.1,
        centerLat: 46.55,
        centerLon: 8.05,
        minEle: 1000,
        maxEle: 2000,
        elevationSpan: 1000,
        widthMeters: 8000,
        depthMeters: 8000,
      };

      const grid = {
        zoom: 12,
        tileXMin: 2000,
        tileXMax: 2000,
        tileYMin: 1500,
        tileYMax: 1500,
        numTilesX: 1,
        numTilesY: 1,
        width: 256,
        height: 256,
      };

      // Elevation 1051 produces normEle = 51/1000 = 0.051 (< 0.25, lush green band)
      // contour100 = |(1051 % 100) - 50| = |51 - 50| = 1 (< 3, triggers 100m contour)
      // Base colors for normEle = 0.051:
      // t = 0.051 / 0.25 = 0.204
      // r = 30 + 0.204*45 = 39.18
      // g = 68 + 0.204*40 = 76.16
      // With fix (g = g - 18): g ≈ 58.
      // If broken (g = r - 18): g would be 39 - 18 = 21 (way too low!)
      TextureProvider.generateTopoTexture(
        bounds,
        grid as any,
        () => 1051,
        4,
        4
      );

      assert.ok(putData !== null);
      const gValue = putData![1]; // Green channel of first pixel
      assert.ok(
        gValue > 50,
        `Green channel (${gValue}) must retain green tint (>50) rather than being overwritten with red (${putData![0]})`
      );
    });
  });

  describe('Requirement #106: Explicit Resource Ownership and Clean Detachment', () => {
    const mockBounds: GeoBounds = {
      minLat: 46.5,
      maxLat: 46.6,
      minLon: 8.0,
      maxLon: 8.1,
      centerLat: 46.55,
      centerLon: 8.05,
      minEle: 1200,
      maxEle: 2800,
      elevationSpan: 1600,
      widthMeters: 8000,
      depthMeters: 10000,
    };

    const pointCount = 10;
    const mockPoints: any[] = [];
    for (let i = 0; i < pointCount; i++) {
      mockPoints.push({
        index: i,
        lat: 46.52 + i * 0.006,
        lon: 8.02 + i * 0.006,
        ele: 1200 + i * 40,
        dist: i * 500,
        distanceFromStart: i * 500,
        elapsedSeconds: i * 360,
        playbackSeconds: i * 360,
      });
    }

    const mockTrack: TrackStats = {
      name: 'Test Trail',
      points: mockPoints,
      segments: [
        {
          points: mockPoints,
          distance: 4500,
          elevationGain: 360,
          elevationLoss: 0,
          startIndex: 0,
          endIndex: pointCount - 1,
        },
      ],
      bounds: mockBounds,
      totalDistance: 4500,
      elevationGain: 360,
      elevationLoss: 0,
      minElevation: 1200,
      maxElevation: 1560,
      movingTime: 3600,
      totalPlaybackSeconds: 3600,
      timingType: 'recorded',
      avgSpeed: 1.4,
      maxSpeed: 2.0,
      waypoints: [],
      landmarks: [],
      warnings: [],
    };

    it('cleanly detaches TerrainResult group from parent upon disposal', async () => {
      // Mock prepareElevation to return fast synthetic grid
      const terrain = await TerrainGenerator.generate(
        mockTrack,
        undefined,
        undefined,
        1.0,
        false,
        {
          demGrid: null,
          terrainGeoBounds: mockBounds,
          elevationSamplerForGeo: () => 1400,
        }
      );

      const parentScene = new THREE.Scene();
      parentScene.add(terrain.group);
      assert.strictEqual(terrain.group.parent, parentScene);

      terrain.dispose();
      assert.strictEqual(terrain.group.parent, null, 'Terrain group must be detached from parent on dispose');
    });

    it('cleanly detaches ImageryLODManager group from parent upon disposal', () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1200,
        elevationSampler: () => 1400,
        verticalExaggeration: 1.0,
        textureStyle: 'satellite',
        maxPatches: 10,
      });

      const parentScene = new THREE.Scene();
      parentScene.add(lod.group);
      assert.strictEqual(lod.group.parent, parentScene);

      lod.dispose();
      assert.strictEqual(lod.group.parent, null, 'Imagery LOD group must be detached from parent on dispose');
    });

    it('cleanly detaches SpatialHUD group from parent upon disposal', () => {
      const hud = new SpatialHUD(mockTrack, {} as any);
      const parentScene = new THREE.Scene();
      parentScene.add(hud.group);
      assert.strictEqual(hud.group.parent, parentScene);

      hud.dispose();
      assert.strictEqual(hud.group.parent, null, 'SpatialHUD group must be detached from parent on dispose');
    });

    it('cleanly detaches TrailMesh group from parent upon disposal', () => {
      const trail = TrailMesh.create(mockTrack, () => 1400, 1200);
      const parentScene = new THREE.Scene();
      parentScene.add(trail.group);
      assert.strictEqual(trail.group.parent, parentScene);

      trail.dispose();
      assert.strictEqual(trail.group.parent, null, 'Trail group must be detached from parent on dispose');
    });

    it('cleanly detaches LoadedTrek container and all child groups upon disposal', async () => {
      const terrain = await TerrainGenerator.generate(
        mockTrack,
        undefined,
        undefined,
        1.0,
        false,
        {
          demGrid: null,
          terrainGeoBounds: mockBounds,
          elevationSamplerForGeo: () => 1400,
        }
      );
      const trail = TrailMesh.create(mockTrack, () => 1400, 1200);
      const dioramaBase = new THREE.Group();
      const flyover = new FlyoverController(trail, mockTrack);

      const loadedTrek = new LoadedTrek({
        track: mockTrack,
        terrainResult: terrain,
        trailResult: trail,
        dioramaBase,
        flyoverController: flyover,
      });

      const scene = new THREE.Scene();
      scene.add(loadedTrek.group);
      assert.strictEqual(loadedTrek.group.parent, scene);

      loadedTrek.dispose();
      assert.strictEqual(loadedTrek.group.parent, null, 'LoadedTrek group must be detached from scene on dispose');
      assert.strictEqual(loadedTrek.isDisposed, true);
    });
  });
});
