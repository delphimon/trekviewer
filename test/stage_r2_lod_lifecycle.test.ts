import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  clampLatitude,
  metersPerPixelAtZoom,
  latLonToTile,
  tileToLatLon,
  tileBounds,
  WEB_MERCATOR_MAX_LAT,
} from '../src/gpx/Coordinates.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage R2: Adaptive Imagery LOD Lifecycle Suite', () => {
  beforeEach(() => {
    TileImageCache.clear();
  });

  describe('Pure Web Mercator Utilities (Section 17 & 18)', () => {
    it('clampLatitude clamps values strictly to Web Mercator limits', () => {
      expect(clampLatitude(90)).toBe(WEB_MERCATOR_MAX_LAT);
      expect(clampLatitude(-95)).toBe(-WEB_MERCATOR_MAX_LAT);
      expect(clampLatitude(46.85)).toBe(46.85);
    });

    it('metersPerPixelAtZoom calculates correct ground resolution with latitude correction', () => {
      // At zoom 0, equator: earth circumference / 256 ≈ 156,543 m/px
      const mppEquatorZ0 = metersPerPixelAtZoom(0, 0);
      expect(mppEquatorZ0).toBeCloseTo(156543, 0);

      // Higher latitude has smaller ground meters per pixel (cos(lat))
      const mppRainierZ0 = metersPerPixelAtZoom(46.85, 0);
      expect(mppRainierZ0).toBeLessThan(mppEquatorZ0);

      // Each zoom step doubles resolution (halves metersPerPixel)
      const mppZ14 = metersPerPixelAtZoom(46.85, 14);
      const mppZ15 = metersPerPixelAtZoom(46.85, 15);
      expect(mppZ14 / mppZ15).toBeCloseTo(2.0, 2);
    });

    it('latLonToTile and tileToLatLon project accurately and round-trip cleanly', () => {
      const lat = 46.852886;
      const lon = -121.760374;
      const zoom = 14;

      const tile = latLonToTile(lat, lon, zoom);
      expect(tile.x).toBeGreaterThan(0);
      expect(tile.y).toBeGreaterThan(0);

      const bounds = tileBounds(tile.x, tile.y, zoom);
      expect(bounds.minLat).toBeLessThanOrEqual(lat);
      expect(bounds.maxLat).toBeGreaterThanOrEqual(lat);
      expect(bounds.minLon).toBeLessThanOrEqual(lon);
      expect(bounds.maxLon).toBeGreaterThanOrEqual(lon);
    });

    it('neighboring tiles meet seamlessly with zero boundary gap (Requirement #18)', () => {
      const zoom = 15;
      const x = 5293;
      const y = 11536;

      const tileCenter = tileBounds(x, y, zoom);
      const tileEast = tileBounds(x + 1, y, zoom);
      const tileSouth = tileBounds(x, y + 1, zoom);

      // East edge of center tile must exactly match West edge of east tile
      expect(tileCenter.maxLon).toBeCloseTo(tileEast.minLon, 8);

      // South edge of center tile must exactly match North edge of south tile
      expect(tileCenter.minLat).toBeCloseTo(tileSouth.maxLat, 8);
    });
  });

  describe('Pure Target Zoom & Hysteresis Calculation (Section 8, 10, 19, 31)', () => {
    it('increases source imagery zoom when diorama is enlarged (Section 10)', () => {
      const cameraDist = 1.0;
      const centerLat = 46.85;

      // Small overview model on table (10km route scaled to ~0.4m tabletop: scale ≈ 0.00004)
      const zoomSmall = ImageryLODManager.calculateTargetZoom(
        cameraDist,
        0.00004,
        centerLat,
        60,
        1080,
        19
      );

      // Normal tabletop model (scale ≈ 0.00008)
      const zoomNormal = ImageryLODManager.calculateTargetZoom(
        cameraDist,
        0.00008,
        centerLat,
        60,
        1080,
        19
      );

      // Enlarged model for close inspection (4x enlargement: scale ≈ 0.00032)
      const zoomEnlarged = ImageryLODManager.calculateTargetZoom(
        cameraDist,
        0.00032,
        centerLat,
        60,
        1080,
        19
      );

      expect(zoomNormal).toBeGreaterThanOrEqual(zoomSmall);
      expect(zoomEnlarged).toBeGreaterThan(zoomNormal);
      expect(zoomEnlarged - zoomSmall).toBeGreaterThanOrEqual(2);
    });

    it('clamps strictly to provider maxZoom without exceeding it (Section 19)', () => {
      const cameraDist = 0.05; // Extremely close
      const dioramaScale = 0.01; // Huge magnification
      const centerLat = 46.85;

      const providerMaxZoom = 17;
      const targetZoom = ImageryLODManager.calculateTargetZoom(
        cameraDist,
        dioramaScale,
        centerLat,
        60,
        1080,
        providerMaxZoom
      );

      expect(targetZoom).toBe(providerMaxZoom);
    });

    it('applies hysteresis to prevent rapid zoom toggling on small camera fluctuations (Section 31)', () => {
      const centerLat = 46.85;
      const dioramaScale = 0.00008;

      // Unconstrained base zoom at 1.0m
      const baseZoom = ImageryLODManager.calculateTargetZoom(
        1.0,
        dioramaScale,
        centerLat,
        60,
        1080,
        19
      );

      // Tiny camera distance fluctuation (0.95m instead of 1.0m) with currentZoom set
      const stabilized = ImageryLODManager.calculateTargetZoom(
        0.95,
        dioramaScale,
        centerLat,
        60,
        1080,
        19,
        baseZoom
      );
      expect(stabilized).toBe(baseZoom);
    });
  });

  describe('Tile Bounds Intersection (Section 9 & 16)', () => {
    it('correctly filters tiles overlapping terrain bounds vs distant tiles', () => {
      const terrainBounds: GeoBounds = {
        minLat: 46.80,
        maxLat: 46.90,
        minLon: -121.80,
        maxLon: -121.70,
        minEle: 1000,
        maxEle: 4000,
        elevationSpan: 3000,
        centerLat: 46.85,
        centerLon: -121.75,
        widthMeters: 10000,
        depthMeters: 10000,
      };

      const centerTile = latLonToTile(46.85, -121.75, 14);
      expect(ImageryLODManager.tileIntersectsBounds(centerTile.x, centerTile.y, 14, terrainBounds)).toBe(true);

      // Tile in Europe
      const distantTile = latLonToTile(45.0, 7.0, 14);
      expect(ImageryLODManager.tileIntersectsBounds(distantTile.x, distantTile.y, 14, terrainBounds)).toBe(false);
    });
  });

  describe('TileImageCache Consumer Decoupling (Section 15)', () => {
    it('shared network request completes into cache even if the first consumer cancels', async () => {
      const mockImg = {
        width: 256,
        height: 256,
        naturalWidth: 256,
        naturalHeight: 256,
        src: '',
      } as any;

      let fetchResolve: ((img: any) => void) | null = null;
      vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockImplementation(() => {
        return new Promise((resolve) => {
          fetchResolve = resolve;
        });
      });

      const mockProvider: ImageryProvider = {
        id: 'test-provider',
        displayName: 'Test',
        maxZoom: 19,
        getTileUrls: () => ['https://example.com/tile/14/1/1.png'],
        attribution: 'Test',
      };

      const consumer1Controller = new AbortController();

      // Consumer 1 starts fetch
      const p1 = TileImageCache.loadTile(mockProvider, 14, 1, 1, 4500, consumer1Controller.signal);
      expect(TileImageCache.getInFlightCount()).toBe(1);

      // Consumer 2 piggybacks on shared fetch
      const consumer2Controller = new AbortController();
      const p2 = TileImageCache.loadTile(mockProvider, 14, 1, 1, 4500, consumer2Controller.signal);

      // Consumer 1 cancels their subscription
      consumer1Controller.abort();
      await expect(p1).rejects.toThrow('Tile load aborted');

      // Shared network fetch should STILL be in flight for consumer 2
      expect(TileImageCache.getInFlightCount()).toBe(1);

      // Network request completes
      fetchResolve!(mockImg);

      // Consumer 2 receives image successfully
      const img2 = await p2;
      expect(img2).toBe(mockImg);

      // Tile is now cached in runtime memory
      expect(TileImageCache.has(TileImageCache.getTileKey('test-provider', 14, 1, 1))).toBe(true);
      expect(TileImageCache.getInFlightCount()).toBe(0);
    });
  });

  describe('ImageryLODManager Desired-Tile Reconciliation & Scheduler (Section 14 & 30)', () => {
    it('manages request queue, limits concurrency, and provides diagnostic metrics', () => {
      const manager = new ImageryLODManager({
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
        terrainBaseElevation: 1400,
        elevationSampler: (x, z) => 800,
        maxPatches: 24,
        maxConcurrency: 4,
      });

      const diag = manager.getDiagnostics();
      expect(diag.activePatchesCount).toBe(0);
      expect(diag.inFlightRequests).toBe(0);
      expect(diag.requestQueueLength).toBe(0);

      manager.setDeviceProfile(true); // Quest profile
      expect((manager as any).maxPatches).toBe(24);
      expect((manager as any).maxConcurrency).toBe(4);

      manager.setDeviceProfile(false); // Desktop profile
      expect((manager as any).maxPatches).toBe(36);
      expect((manager as any).maxConcurrency).toBe(6);

      manager.dispose();
    });
  });
});
