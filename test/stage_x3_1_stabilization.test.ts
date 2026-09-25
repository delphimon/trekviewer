import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ElevationTileService,
  type ElevationGrid,
} from '../src/terrain/ElevationTiles.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import { TextureProvider, type TileGridBounds } from '../src/terrain/TextureProvider.ts';
import { QualityProfileManager } from '../src/terrain/QualityProfile.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';

describe('Stage X3.1: Visual Corruption Emergency Stabilization', () => {
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

  const testTileGrid: TileGridBounds = {
    zoom: 13,
    tileXMin: 1322,
    tileXMax: 1323,
    tileYMin: 2883,
    tileYMax: 2884,
    numTilesX: 2,
    numTilesY: 2,
  };

  function createMockGridWithInvalidTile(invalidTileIdx: number = 0): ElevationGrid {
    const zoom = 15;
    const tile = latLonToTile(testBounds.centerLat, testBounds.centerLon, zoom);
    const tileXMin = tile.x - 1;
    const tileXMax = tile.x;
    const tileYMin = tile.y - 1;
    const tileYMax = tile.y;
    const numTilesX = 2;
    const numTilesY = 2;
    const width = numTilesX * 256;
    const height = numTilesY * 256;
    const data = new Float32Array(width * height);
    const tileValidity = new Uint8Array(4).fill(1);

    // Fill valid elevation = 2200m
    data.fill(2200);

    // Mark one tile as invalid
    tileValidity[invalidTileIdx] = 0;
    const tx = invalidTileIdx % numTilesX;
    const ty = Math.floor(invalidTileIdx / numTilesX);
    for (let py = ty * 256; py < (ty + 1) * 256; py++) {
      for (let px = tx * 256; px < (tx + 1) * 256; px++) {
        data[py * width + px] = NaN;
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
      tileValidity,
      minElevation: 2200,
      maxElevation: 2200,
      isRealDEM: true,
      quality: {
        validTileRatio: 0.75,
        totalTiles: 4,
        validTiles: 3,
        zoom,
      },
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

  class MockCanvas {
    private _width = 256;
    private _height = 256;
    public pixelBuffer: Uint8ClampedArray;
    constructor(w = 256, h = 256) {
      this._width = w;
      this._height = h;
      this.pixelBuffer = new Uint8ClampedArray(w * h * 4);
    }
    get width() {
      return this._width;
    }
    set width(w: number) {
      this._width = w;
      this.pixelBuffer = new Uint8ClampedArray(this._width * this._height * 4);
    }
    get height() {
      return this._height;
    }
    set height(h: number) {
      this._height = h;
      this.pixelBuffer = new Uint8ClampedArray(this._width * this._height * 4);
    }
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
        fillRect: (x: number, y: number, w: number, h: number) => {
          let r = 0, g = 0, b = 0, a = 255;
          if (currentFill === '#6b7280') { r = 107; g = 114; b = 128; }
          else if (currentFill === '#10b981') { r = 16; g = 185; b = 129; }
          else if (currentFill === '#fbbf24') { r = 251; g = 191; b = 36; }
          else if (currentFill === '#3b82f6') { r = 59; g = 130; b = 246; }
          for (let py = Math.max(0, y); py < Math.min(this._height, y + h); py++) {
            for (let px = Math.max(0, x); px < Math.min(this._width, x + w); px++) {
              const idx = (py * this._width + px) * 4;
              this.pixelBuffer[idx] = r;
              this.pixelBuffer[idx + 1] = g;
              this.pixelBuffer[idx + 2] = b;
              this.pixelBuffer[idx + 3] = a;
            }
          }
        },
        drawImage: (img: any, dx: number, dy: number, dw?: number, dh?: number) => {
          const srcBuffer = img?.pixelBuffer;
          const sw = img?.width ?? 256;
          const sh = img?.height ?? 256;
          const destW = dw ?? sw;
          const destH = dh ?? sh;
          if (srcBuffer) {
            for (let py = 0; py < destH; py++) {
              for (let px = 0; px < destW; px++) {
                const srcPx = Math.floor((px / destW) * sw);
                const srcPy = Math.floor((py / destH) * sh);
                const srcIdx = (srcPy * sw + srcPx) * 4;
                const dstIdx = ((dy + py) * this._width + (dx + px)) * 4;
                if (dstIdx >= 0 && dstIdx + 3 < this.pixelBuffer.length) {
                  this.pixelBuffer[dstIdx] = srcBuffer[srcIdx];
                  this.pixelBuffer[dstIdx + 1] = srcBuffer[srcIdx + 1];
                  this.pixelBuffer[dstIdx + 2] = srcBuffer[srcIdx + 2];
                  this.pixelBuffer[dstIdx + 3] = srcBuffer[srcIdx + 3];
                }
              }
            }
          }
        },
        getImageData: (x: number, y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
              const srcIdx = ((y + py) * this._width + (x + px)) * 4;
              const dstIdx = (py * w + px) * 4;
              if (srcIdx >= 0 && srcIdx + 3 < this.pixelBuffer.length) {
                data[dstIdx] = this.pixelBuffer[srcIdx];
                data[dstIdx + 1] = this.pixelBuffer[srcIdx + 1];
                data[dstIdx + 2] = this.pixelBuffer[srcIdx + 2];
                data[dstIdx + 3] = this.pixelBuffer[srcIdx + 3];
              }
            }
          }
          return { data };
        },
      };
    }
  }

  let origDocument: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return new MockCanvas();
        }
        return {};
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
    vi.restoreAllMocks();
  });

  describe('Test A & B: Partial DEM Fallback & No Zero-Elevation Collapse', () => {
    it('uses base terrain height for missing DEM tiles and never collapses vertices to zero', () => {
      const grid = createMockGridWithInvalidTile(0);
      const baseTerrainElevation = 1500;
      const baseElevationSampler = (_x: number, _z: number) => 550; // base height = 550m

      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: baseTerrainElevation,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler,
        tileGrid: testTileGrid,
      });

      const posAttr = chunk.geometry.attributes.position;
      const vertexCount = posAttr.count;
      expect(vertexCount).toBeGreaterThan(0);

      // Verify no vertices collapsed to 0 (which caused the deep black pits and gray squares)
      for (let i = 0; i < vertexCount; i++) {
        const y = posAttr.getY(i);
        expect(y).toBeGreaterThan(0);
        expect(Number.isFinite(y)).toBe(true);
        expect(isNaN(y)).toBe(false);
      }

      // Validation should succeed because invalid vertices gracefully fall back to base terrain
      const val = chunk.validate(baseElevationSampler);
      expect(val.isValid).toBe(true);
      expect(val.nanCount).toBe(0);
      expect(val.infiniteCount).toBe(0);
      expect(val.fallbackRatio).toBeGreaterThan(0); // at least some vertices fell back to base

      chunk.dispose();
    });

    it('updateElevationGrid with incomplete grid replaces missing areas with base height without collapsing', () => {
      const gridInitial = createMockGridWithInvalidTile(0);
      const baseElevationSampler = (_x: number, _z: number) => 600;

      const chunk = new LocalTerrainChunk({
        localGrid: gridInitial,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler,
      });

      // Update with another grid with tile 1 invalid
      const gridUpdate = createMockGridWithInvalidTile(1);
      chunk.updateElevationGrid(gridUpdate, baseElevationSampler);

      const posAttr = chunk.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const y = posAttr.getY(i);
        expect(y).toBeGreaterThan(0);
        expect(Number.isFinite(y)).toBe(true);
      }

      const val = chunk.validate(baseElevationSampler);
      expect(val.isValid).toBe(true);
      chunk.dispose();
    });
  });

  describe('Test C & D: Partial Satellite Canvas & Tile Failure Safety', () => {
    it('pre-populates composite canvas with fallback image so unloaded cells are never blank/black', async () => {
      // 16 imagery tiles (4x4) as specified by Section 15 Test C
      const testTileGrid16: TileGridBounds = {
        zoom: 13,
        tileXMin: 1320,
        tileXMax: 1323,
        tileYMin: 2880,
        tileYMax: 2883,
        numTilesX: 4,
        numTilesY: 4,
      };

      const fallbackCanvas = new MockCanvas(1024, 1024);
      const fbCtx = fallbackCanvas.getContext('2d')!;
      fbCtx.fillStyle = '#10b981'; // vibrant emerald green
      fbCtx.fillRect(0, 0, 1024, 1024);

      let intermediateCanvasSeen = false;
      let unloadedCellPixelsValid = false;

      // Mock TileImageCache.loadTile with a delay for later tiles to simulate progressive streaming
      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async (_provider, _zoom, _tx, ty) => {
        // Delay last row tiles so they remain unloaded during first batch upload
        if (ty === 2883) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        const tileCanvas = new MockCanvas(256, 256);
        const ctx = tileCanvas.getContext('2d')!;
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(0, 0, 256, 256);
        return tileCanvas as any;
      });

      const satTex = await TextureProvider.fetchSatelliteTexture(
        testTileGrid16,
        (partialTex, loaded, total) => {
          if (loaded < total) {
            intermediateCanvasSeen = true;
            const canvas = partialTex.image as any;
            const ctx = canvas.getContext('2d')!;
            // Inspect pixel in bottom-right cell (tx: 1323, ty: 2883 => pixel at 900, 900)
            const pixel = ctx.getImageData(900, 900, 1, 1).data;
            // It MUST NOT be transparent black (0, 0, 0, 0)
            if (pixel[3] > 0 && (pixel[0] > 0 || pixel[1] > 0 || pixel[2] > 0)) {
              unloadedCellPixelsValid = true;
            }
          }
        },
        undefined,
        false,
        fallbackCanvas as any
      );

      expect(satTex).not.toBeNull();
      expect(intermediateCanvasSeen).toBe(true);
      expect(unloadedCellPixelsValid).toBe(true);

      satTex?.dispose();
    });

    it('failed satellite tiles retain fallback imagery and never display permanent black holes', async () => {
      const fallbackCanvas = new MockCanvas(512, 512);
      const fbCtx = fallbackCanvas.getContext('2d')!;
      fbCtx.fillStyle = '#fbbf24'; // amber fallback
      fbCtx.fillRect(0, 0, 512, 512);

      // Make tile (1322, 2883) permanently fail
      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async (_provider, _zoom, tx, ty) => {
        if (tx === 1322 && ty === 2883) {
          throw new Error('Tile network error 503');
        }
        const tileCanvas = new MockCanvas(256, 256);
        const ctx = tileCanvas.getContext('2d')!;
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(0, 0, 256, 256);
        return tileCanvas as any;
      });

      const satTex = await TextureProvider.fetchSatelliteTexture(
        testTileGrid,
        undefined,
        undefined,
        false,
        fallbackCanvas as any
      );

      expect(satTex).not.toBeNull();
      const canvas = satTex!.image as any;
      const ctx = canvas.getContext('2d')!;

      // Top-left tile (1322, 2883) failed: inspect pixel at (50, 50)
      const failedPixel = ctx.getImageData(50, 50, 1, 1).data;
      // Must have fallback color and NOT be black (0,0,0,0)
      expect(failedPixel[3]).toBe(255); // Alpha 255
      expect(failedPixel[0]).toBeGreaterThan(0); // Red > 0 (amber)
      expect(failedPixel[1]).toBeGreaterThan(0); // Green > 0

      satTex?.dispose();
    });
  });

  describe('Test E: Shared Texture Ownership & Disposal Safety', () => {
    it('disposing a LocalTerrainChunk does NOT dispose the base terrain texture or collapse its canvas', () => {
      const baseCanvas = new MockCanvas(1024, 1024);
      const baseTexture = new THREE.CanvasTexture(baseCanvas as any);
      const disposeSpy = vi.spyOn(baseTexture, 'dispose');

      const grid = createMockGridWithInvalidTile(0);
      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler: () => 500,
        mapTexture: baseTexture,
        tileGrid: testTileGrid,
      });

      expect(chunk.material.map).toBe(baseTexture);

      // Evict / dispose the local chunk
      chunk.dispose();

      // Base terrain texture must REMAIN active and intact!
      expect(disposeSpy).not.toHaveBeenCalled();
      expect(baseCanvas.width).toBe(1024);
      expect(baseCanvas.height).toBe(1024);

      // Now properly dispose baseTexture by owner
      baseTexture.dispose();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Test F & G: Tabletop vs. First-Person ViewMode Policy', () => {
    function setupStreamer(initialMode: 'diorama' | 'first-person') {
      const terrainGroup = new THREE.Group();
      const terrainMat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
      const terrainMesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
      terrainGroup.add(terrainMesh);

      const activeChunks: LocalTerrainChunk[] = [];
      const dummyTerrainResult = {
        group: terrainGroup,
        terrainMesh,
        skirtMesh: new THREE.Mesh(),
        demGrid: createMockGridWithInvalidTile(0),
        bounds: testBounds,
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1500,
        terrainQuality: 'dem' as const,
        tileGrid: testTileGrid,
        elevationSampler: () => 2000,
        sampleDEMY: () => 2000,
        sampleRenderedSurfaceY: () => 500,
        setTextureStyle: async () => {},
        setVerticalExaggeration: () => {},
        attachLocalChunk: (c: LocalTerrainChunk) => {
          activeChunks.push(c);
        },
        detachLocalChunk: (c?: LocalTerrainChunk) => {
          if (!c) return;
          const idx = activeChunks.indexOf(c);
          if (idx !== -1) activeChunks.splice(idx, 1);
          c.dispose();
        },
        get localChunk() {
          return activeChunks.find((c) => c.mesh.visible) || null;
        },
        get localChunks() {
          return activeChunks;
        },
        dispose: () => {},
      };

      vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue(null);

      const streamer = new LocalTerrainStreamer({
        terrainResult: dummyTerrainResult,
        routeGeometry: dummyRouteGeometry,
        demGrid: dummyTerrainResult.demGrid!,
        qualityProfile: QualityProfileManager.getProfile('quest-high'),
        chunkRadiusM: 800,
        maxChunks: 3,
        evalThresholdM: 10,
        initialViewMode: initialMode,
      });

      return { streamer, activeChunks };
    }

    it('in tabletop diorama mode, all local chunks remain invisible and base terrain is authoritative', () => {
      const { streamer } = setupStreamer('diorama');

      // Update across different route progress stations
      streamer.update(0.0);
      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(1);
      // In diorama mode, NO local chunk may be visible (no gray-blue square following hiker!)
      const visibleChunks = streamer.activeChunks.filter((c) => c.mesh.visible);
      expect(visibleChunks.length).toBe(0);
      expect(streamer.activeVisibleChunk).toBeNull();

      streamer.update(0.5);
      const visibleAfterMove = streamer.activeChunks.filter((c) => c.mesh.visible);
      expect(visibleAfterMove.length).toBe(0);
      expect(streamer.activeVisibleChunk).toBeNull();

      streamer.dispose();
    });

    it('switching to first-person mode activates validated station 0; switching back hides it', () => {
      const { streamer } = setupStreamer('diorama');

      streamer.update(0.0);
      expect(streamer.activeVisibleChunk).toBeNull();

      // Enter first-person mode
      streamer.setViewMode('first-person');
      expect(streamer.activeVisibleChunk).not.toBeNull();
      expect(streamer.activeVisibleChunk!.mesh.visible).toBe(true);

      // Remaining background chunks must be invisible
      const otherChunks = streamer.activeChunks.filter((c) => c !== streamer.activeVisibleChunk);
      for (const other of otherChunks) {
        expect(other.mesh.visible).toBe(false);
      }

      // Return to diorama mode
      streamer.setViewMode('diorama');
      expect(streamer.activeVisibleChunk).toBeNull();
      for (const chunk of streamer.activeChunks) {
        expect(chunk.mesh.visible).toBe(false);
      }

      streamer.dispose();
    });
  });

  describe('Test H: DEM Quality Rejection Threshold (< 70%)', () => {
    it('fetchLocalElevationGrid rejects grid if valid tile ratio is below 70%', async () => {
      // Mock decodeTileGrid returning a grid with only 50% valid tiles
      vi.spyOn(ElevationTileService as any, 'decodeTileGrid').mockResolvedValue({
        width: 512,
        height: 512,
        zoom: 15,
        tileXMin: 10,
        tileXMax: 11,
        tileYMin: 10,
        tileYMax: 11,
        numTilesX: 2,
        numTilesY: 2,
        data: new Float32Array(512 * 512),
        tileValidity: new Uint8Array([1, 0, 1, 0]),
        minElevation: 1000,
        maxElevation: 2000,
        isRealDEM: true,
        quality: {
          validTileRatio: 0.50, // 50% < 70% threshold
          totalTiles: 4,
          validTiles: 2,
          zoom: 15,
        },
      });

      const grid = await ElevationTileService.fetchLocalElevationGrid(
        testBounds.centerLat,
        testBounds.centerLon,
        800,
        15
      );

      // Must be rejected (returns null) so low-quality grids are not promoted
      expect(grid).toBeNull();
    });
  });
});
