import { describe, it, expect, beforeEach } from 'vitest';
import {
  QualityProfileManager,
  QUALITY_PROFILES,
  type QualityProfile,
} from '../src/terrain/QualityProfile.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage W1: Centralized Quality Profiles & Decoded Image Cache Architecture', () => {
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

  beforeEach(() => {
    TileImageCache.clear();
  });

  describe('QualityProfileManager & Presets', () => {
    it('provides quest-high as the default profile for Meta Quest / WebXR', () => {
      const questDefault = QualityProfileManager.getDefaultProfile(true);
      expect(questDefault.name).toBe('quest-high');
      expect(questDefault.tabletopPatches).toBe(48);
      expect(questDefault.firstPersonPatches).toBe(64);
      expect(questDefault.concurrency).toBe(6);
      expect(questDefault.tileCacheEntries).toBe(240);
      expect(questDefault.tileCacheBytes).toBe(64 * 1024 * 1024);
      expect(questDefault.warmRetentionMs).toBe(30000);
      expect(questDefault.evalIntervalMs).toBe(120);
      expect(questDefault.promotionDwellMs).toBe(200);
      expect(questDefault.demotionDwellMs).toBe(3000);
      expect(questDefault.firstPersonPrefetchAheadM).toBe(650);
      expect(questDefault.firstPersonRetainBehindM).toBe(300);
      expect(questDefault.localTerrainRadiusM).toBe(1250);
    });

    it('provides desktop-high as the default profile for Desktop browsers', () => {
      const desktopDefault = QualityProfileManager.getDefaultProfile(false);
      expect(desktopDefault.name).toBe('desktop-high');
      expect(desktopDefault.tabletopPatches).toBe(80);
      expect(desktopDefault.firstPersonPatches).toBe(96);
      expect(desktopDefault.concurrency).toBe(6);
      expect(desktopDefault.tileCacheEntries).toBe(360);
      expect(desktopDefault.tileCacheBytes).toBe(96 * 1024 * 1024);
      expect(desktopDefault.warmRetentionMs).toBe(45000);
    });

    it('provides quest-balanced profile for conservative battery saving', () => {
      const balanced = QualityProfileManager.getProfile('quest-balanced');
      expect(balanced.name).toBe('quest-balanced');
      expect(balanced.tabletopPatches).toBe(28);
      expect(balanced.firstPersonPatches).toBe(36);
      expect(balanced.concurrency).toBe(4);
      expect(balanced.tileCacheEntries).toBe(160);
      expect(balanced.tileCacheBytes).toBe(40 * 1024 * 1024);
    });

    it('allows setting and retrieving the active quality profile', () => {
      QualityProfileManager.setActiveProfile('quest-high');
      expect(QualityProfileManager.getActiveProfile().name).toBe('quest-high');

      QualityProfileManager.setActiveProfile('desktop-high');
      expect(QualityProfileManager.getActiveProfile().name).toBe('desktop-high');
    });
  });

  describe('TileImageCache Quality Scaling & Hit Rate Diagnostics', () => {
    it('scales decoded image cache for Quest 3 to 240 entries / 64MB via QualityProfile', () => {
      TileImageCache.setTargetDevice(true);
      const stats = TileImageCache.getStats();
      expect(stats.maxEntries).toBe(240);
      expect(stats.maxDecodedBytes).toBe(64 * 1024 * 1024);
    });

    it('scales decoded image cache for Desktop to 360 entries / 96MB', () => {
      TileImageCache.setTargetDevice(false);
      const stats = TileImageCache.getStats();
      expect(stats.maxEntries).toBe(360);
      expect(stats.maxDecodedBytes).toBe(96 * 1024 * 1024);
    });

    it('accurately tracks cache hits, misses, and hit rate percentage in stats', () => {
      TileImageCache.clear();
      expect(TileImageCache.get('non_existent_key_1')).toBeUndefined();
      expect(TileImageCache.get('non_existent_key_2')).toBeUndefined();

      let stats = TileImageCache.getStats();
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(2);
      expect(stats.hitRate).toBe(0);

      // Simulate a cached image
      const mockImg = { width: 256, height: 256, naturalWidth: 256, naturalHeight: 256 } as any;
      TileImageCache.set('test_tile_1', mockImg);

      // Access cached item
      const hit = TileImageCache.get('test_tile_1');
      expect(hit).toBe(mockImg);

      stats = TileImageCache.getStats();
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(2);
      // 1 hit out of 3 total requests = 33.3%
      expect(stats.hitRate).toBeCloseTo(33.3, 1);
    });
  });

  describe('ImageryLODManager View-Mode Specific Budgets', () => {
    it('applies view-mode specific patch budgets under quest-high: 48 tabletop vs 64 first-person', () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1500,
        elevationSampler: () => 1800,
        viewMode: 'diorama',
      });

      // Apply Quest device profile (defaults to quest-high)
      lod.setDeviceProfile(true);

      const profile = lod.getQualityProfile();
      expect(profile.name).toBe('quest-high');

      // Tabletop diorama mode: 48 resident patches, concurrency 6
      expect((lod as any).maxPatches).toBe(48);
      expect((lod as any).maxConcurrency).toBe(6);
      expect((lod as any).warmRetentionMs).toBe(30000);

      // Switching to 1:1 first-person mode expands patch budget to 64
      lod.setViewMode('first-person');
      expect((lod as any).maxPatches).toBe(64);

      // Switching back to diorama returns budget to 48
      lod.setViewMode('diorama');
      expect((lod as any).maxPatches).toBe(48);

      lod.dispose();
    });

    it('allows explicit runtime override of QualityProfile', () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1500,
        elevationSampler: () => 1800,
      });

      lod.setQualityProfile(QUALITY_PROFILES['quest-balanced']);
      expect((lod as any).maxPatches).toBe(28);
      expect((lod as any).maxConcurrency).toBe(4);

      lod.dispose();
    });
  });
});
