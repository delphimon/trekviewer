import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  ImageryPatch,
} from '../src/terrain/ImageryLODManager.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';

describe('Stage W5: Three-Tier Retention & Distance/Importance-Based Warm Eviction', () => {
  const testBounds: GeoBounds = {
    minLat: 46.8,
    maxLat: 46.9,
    minLon: -121.8,
    maxLon: -121.7,
    centerLat: 46.85,
    centerLon: -121.75,
    minEle: 1400,
    maxEle: 4392,
    widthMeters: 8000,
    depthMeters: 11000,
    elevationSpan: 2992,
  };

  let manager: ImageryLODManager;
  let mockRoute: RouteGeometry;

  beforeEach(() => {
    // 1000m route Northward
    const points: GPXPoint[] = [];
    for (let i = 0; i <= 10; i++) {
      points.push({
        lat: 46.85 + (i * 0.001),
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
      name: 'Test Trail W5',
      points,
      totalDistance: 1000,
      elevationGain: 0,
      elevationLoss: 0,
      minElevation: 1500,
      maxElevation: 1500,
      movingTime: 1000,
      totalPlaybackSeconds: 1000,
      avgSpeed: 3.6,
      maxSpeed: 5.0,
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

  function createMockPatch(
    key: string,
    x: number,
    y: number,
    zoom: number,
    lastUsed: number,
    centerDist: number = 1.0
  ): ImageryPatch {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    const texture = new THREE.Texture();
    const patch: ImageryPatch = {
      key,
      x,
      y,
      zoom,
      mesh,
      texture,
      lastUsed,
      centerDist,
      creationTime: lastUsed,
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

  describe('Multi-Factor Importance Scoring', () => {
    it('scores active tiles higher than inactive corridor tiles, which score higher than distant cold tiles', () => {
      const now = 100000;
      // Hiker is at progress 0.0 (lat 46.85, lon -121.75)
      const hikerTile = latLonToTile(46.85, -121.75, 19);
      const activeKey = `satellite:19:${hikerTile.x}:${hikerTile.y}`;
      const activeKeys = new Set<string>([activeKey]);

      const nearPatch = createMockPatch(activeKey, hikerTile.x, hikerTile.y, 19, now, 0.1);

      // Inactive tile near corridor (150m ahead: ~0.00135 deg lat)
      const corridorTile = latLonToTile(46.85 + 150 / 111320, -121.75, 19);
      const corridorKey = `satellite:19:${corridorTile.x}:${corridorTile.y}`;
      const corridorPatch = createMockPatch(corridorKey, corridorTile.x, corridorTile.y, 19, now - 5000, 0.2);

      // Inactive distant cold tile (5000m away: ~0.045 deg lat)
      const distantTile = latLonToTile(46.85 + 5000 / 111320, -121.75, 19);
      const distantKey = `satellite:19:${distantTile.x}:${distantTile.y}`;
      const distantColdPatch = createMockPatch(distantKey, distantTile.x, distantTile.y, 19, now - 25000, 5.0);

      const activeScore = manager.calculatePatchImportanceScore(nearPatch, activeKeys, now);
      const corridorScore = manager.calculatePatchImportanceScore(corridorPatch, activeKeys, now);
      const distantScore = manager.calculatePatchImportanceScore(distantColdPatch, activeKeys, now);

      // Active score should have +10000 bonus
      expect(activeScore).toBeGreaterThan(10000);
      // Corridor score should have corridor bonus (+3000) plus distance and recency
      expect(corridorScore).toBeGreaterThan(3000);
      // Distant cold score should be much lower than corridor
      expect(corridorScore).toBeGreaterThan(distantScore);
      // Distant score has no corridor bonus and lower recency
      expect(distantScore).toBeLessThan(corridorScore);

      nearPatch.dispose();
      corridorPatch.dispose();
      distantColdPatch.dispose();
    });

    it('rewards recency: fresh inactive tiles score higher than older inactive tiles at the same location', () => {
      const now = 100000;
      const activeKeys = new Set<string>();
      const tile = latLonToTile(46.85 + 150 / 111320, -121.75, 19);
      const key = `satellite:19:${tile.x}:${tile.y}`;

      const freshPatch = createMockPatch(key, tile.x, tile.y, 19, now - 1000, 0.5);
      const agedPatch = createMockPatch(key, tile.x, tile.y, 19, now - 18000, 0.5);

      const freshScore = manager.calculatePatchImportanceScore(freshPatch, activeKeys, now);
      const agedScore = manager.calculatePatchImportanceScore(agedPatch, activeKeys, now);

      expect(freshScore).toBeGreaterThan(agedScore);

      freshPatch.dispose();
      agedPatch.dispose();
    });

    it('scores tabletop patches based on distance to diorama focus in diorama mode', () => {
      const tabletopManager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 1500,
        viewMode: 'diorama',
        enableInXR: true,
        enableFadeIn: false,
      });

      const now = 100000;
      const activeKeys = new Set<string>();

      // Patch near diorama center (centerDist = 0.2m)
      const nearFocusPatch = createMockPatch('satellite:19:100:100', 100, 100, 19, now - 5000, 0.2);
      // Patch far on periphery (centerDist = 2.0m)
      const farPatch = createMockPatch('satellite:19:100:200', 100, 200, 19, now - 5000, 2.0);

      const nearScore = tabletopManager.calculatePatchImportanceScore(nearFocusPatch, activeKeys, now);
      const farScore = tabletopManager.calculatePatchImportanceScore(farPatch, activeKeys, now);

      expect(nearScore).toBeGreaterThan(farScore);

      nearFocusPatch.dispose();
      farPatch.dispose();
      tabletopManager.dispose();
    });
  });

  describe('Warm Retention & Memory-Pressure Eviction', () => {
    it('retains warm non-active tiles in memory while total count is under budget (maxPatches)', () => {
      const patchesMap = (manager as any).patches as Map<string, ImageryPatch>;
      const activeKeys = new Set<string>();

      const now = performance.now();
      const baseTile = latLonToTile(46.85, -121.75, 19);
      // Add 10 non-active patches (budget is 64 or 48)
      for (let i = 0; i < 10; i++) {
        const key = `satellite:19:${baseTile.x}:${baseTile.y + i}`;
        // lastUsed is 10 seconds ago (well within warmRetentionMs 30s)
        const p = createMockPatch(key, baseTile.x, baseTile.y + i, 19, now - 10000, 0.2 + i * 0.1);
        patchesMap.set(key, p);
      }

      expect(patchesMap.size).toBe(10);

      // Call prunePatches with no active keys
      (manager as any).prunePatches(activeKeys);

      // All 10 warm patches must remain retained because budget is not exceeded
      expect(patchesMap.size).toBe(10);
    });

    it('evicts lowest-scoring tiles first when maxPatches budget is exceeded', () => {
      const patchesMap = (manager as any).patches as Map<string, ImageryPatch>;
      (manager as any).maxPatches = 5;

      const now = performance.now();
      const hikerTile = latLonToTile(46.85, -121.75, 19);
      const activeKey = `satellite:19:${hikerTile.x}:${hikerTile.y}`;
      const activeKeys = new Set<string>([activeKey]);

      // Active patch (highest score)
      const pActive = createMockPatch(activeKey, hikerTile.x, hikerTile.y, 19, now, 0.05);
      patchesMap.set(pActive.key, pActive);

      // 3 corridor warm patches (medium-high score, within 300m)
      const c1Tile = latLonToTile(46.85 + 50 / 111320, -121.75, 19);
      const c2Tile = latLonToTile(46.85 + 100 / 111320, -121.75, 19);
      const c3Tile = latLonToTile(46.85 + 150 / 111320, -121.75, 19);
      const pCorridor1 = createMockPatch(`satellite:19:${c1Tile.x}:${c1Tile.y}`, c1Tile.x, c1Tile.y, 19, now - 2000, 0.1);
      const pCorridor2 = createMockPatch(`satellite:19:${c2Tile.x}:${c2Tile.y}`, c2Tile.x, c2Tile.y, 19, now - 3000, 0.15);
      const pCorridor3 = createMockPatch(`satellite:19:${c3Tile.x}:${c3Tile.y}`, c3Tile.x, c3Tile.y, 19, now - 4000, 0.2);
      patchesMap.set(pCorridor1.key, pCorridor1);
      patchesMap.set(pCorridor2.key, pCorridor2);
      patchesMap.set(pCorridor3.key, pCorridor3);

      // 1 medium distance patch (600m away, still on trail)
      const midTile = latLonToTile(46.85 + 600 / 111320, -121.75, 19);
      const pMid = createMockPatch(`satellite:19:${midTile.x}:${midTile.y}`, midTile.x, midTile.y, 19, now - 15000, 1.0);
      patchesMap.set(pMid.key, pMid);

      // 2 distant cold patches (lowest scores: 6000m and 8000m away)
      const d1Tile = latLonToTile(46.85 + 6000 / 111320, -121.75, 19);
      const d2Tile = latLonToTile(46.85 + 8000 / 111320, -121.75, 19);
      const pDistantCold1 = createMockPatch(`satellite:19:${d1Tile.x}:${d1Tile.y}`, d1Tile.x, d1Tile.y, 19, now - 25000, 5.0);
      const pDistantCold2 = createMockPatch(`satellite:19:${d2Tile.x}:${d2Tile.y}`, d2Tile.x, d2Tile.y, 19, now - 28000, 8.0);
      patchesMap.set(pDistantCold1.key, pDistantCold1);
      patchesMap.set(pDistantCold2.key, pDistantCold2);

      expect(patchesMap.size).toBe(7); // Exceeds maxPatches (5) by 2

      // Prune should reduce size down to maxPatches (5)
      (manager as any).prunePatches(activeKeys);

      expect(patchesMap.size).toBe(5);

      // The two distant cold patches should have been evicted first
      expect(patchesMap.has(pDistantCold1.key)).toBe(false);
      expect(patchesMap.has(pDistantCold2.key)).toBe(false);

      // Active and corridor patches must still be present
      expect(patchesMap.has(pActive.key)).toBe(true);
      expect(patchesMap.has(pCorridor1.key)).toBe(true);
      expect(patchesMap.has(pCorridor2.key)).toBe(true);
      expect(patchesMap.has(pCorridor3.key)).toBe(true);
    });
  });
});
