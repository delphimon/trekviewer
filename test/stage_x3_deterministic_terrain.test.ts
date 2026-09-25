import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ElevationTileService,
  type ElevationGrid,
} from '../src/terrain/ElevationTiles.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import { TerrainGenerator, type TerrainResult } from '../src/terrain/TerrainGenerator.ts';
import { TextureProvider, type TileGridBounds } from '../src/terrain/TextureProvider.ts';
import { QualityProfileManager } from '../src/terrain/QualityProfile.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';
import { latLonToTile, localMetersToGeo } from '../src/gpx/Coordinates.ts';

describe('Stage X3: Deterministic Local Terrain Ownership & Map Imagery Material', () => {
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
    tileXMax: 1327,
    tileYMin: 2883,
    tileYMax: 2888,
    numTilesX: 6,
    numTilesY: 6,
  };

  function createMockGrid(zoom: number = 15, baseElevation: number = 2000): ElevationGrid {
    const tile = latLonToTile(testBounds.centerLat, testBounds.centerLon, zoom);
    const tileXMin = tile.x - 2;
    const tileXMax = tile.x + 2;
    const tileYMin = tile.y - 2;
    const tileYMax = tile.y + 2;
    const numTilesX = tileXMax - tileXMin + 1;
    const numTilesY = tileYMax - tileYMin + 1;
    const width = numTilesX * 256;
    const height = numTilesY * 256;
    const data = new Float32Array(width * height);
    data.fill(baseElevation);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('LocalTerrainChunk Material & UV Orthorectification', () => {
    it('initializes with non-metallic physical material properties and active map texture', () => {
      const mockTex = new THREE.Texture();
      const grid = createMockGrid();

      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler: () => 2000,
        tileGrid: testTileGrid,
        mapTexture: mockTex,
      });

      expect(chunk.material.map).toBe(mockTex);
      expect(chunk.material.roughness).toBe(0.95);
      expect(chunk.material.metalness).toBe(0.0);
      expect(chunk.material.color.getHex()).toBe(0xffffff);

      // Verify UVs match geographic projection for chunk vertices
      const posAttr = chunk.geometry.attributes.position;
      const uvAttr = chunk.geometry.attributes.uv;
      const vx = posAttr.getX(0);
      const vz = posAttr.getZ(0);
      const geo = localMetersToGeo(vx, vz, testBounds.centerLat, testBounds.centerLon);
      const expectedUV = TextureProvider.getUVForGeo(geo.lat, geo.lon, testTileGrid);

      expect(uvAttr.getX(0)).toBeCloseTo(expectedUV.u, 4);
      expect(uvAttr.getY(0)).toBeCloseTo(expectedUV.v, 4);

      chunk.dispose();
    });

    it('setMapTexture updates material map and re-evaluates UV coordinates', () => {
      const grid = createMockGrid();
      const chunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler: () => 2000,
      });

      const newTex = new THREE.Texture();
      chunk.setMapTexture(newTex, testTileGrid);

      expect(chunk.material.map).toBe(newTex);
      const uvAttr = chunk.geometry.attributes.uv;
      const posAttr = chunk.geometry.attributes.position;
      const vx = posAttr.getX(10);
      const vz = posAttr.getZ(10);
      const geo = localMetersToGeo(vx, vz, testBounds.centerLat, testBounds.centerLon);
      const expectedUV = TextureProvider.getUVForGeo(geo.lat, geo.lon, testTileGrid);

      expect(uvAttr.getX(10)).toBeCloseTo(expectedUV.u, 4);
      expect(uvAttr.getY(10)).toBeCloseTo(expectedUV.v, 4);

      chunk.dispose();
    });
  });

  describe('TerrainGenerator Local Chunk Attachment & Surface Ownership', () => {
    it('sets map texture on chunk when attached and filters invisible chunks in sampleRenderedSurfaceY', () => {
      // Mock TerrainResult manually to verify attachment and sampling logic
      const activeLocalChunks: LocalTerrainChunk[] = [];
      const testTex = new THREE.Texture();

      const attachLocalChunk = (chunk: LocalTerrainChunk) => {
        activeLocalChunks.push(chunk);
        chunk.setMapTexture(testTex, testTileGrid);
      };

      const sampleRenderedSurfaceY = (localX: number, localZ: number): number => {
        for (const chunk of activeLocalChunks) {
          if (!chunk.mesh.visible) continue;
          const s = chunk.sampleLocalSurfaceY(localX, localZ);
          if (s !== null) return s;
        }
        return 1500;
      };

      const grid = createMockGrid();
      const visibleChunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler: () => 2000,
      });
      visibleChunk.mesh.visible = true;

      const invisibleChunk = new LocalTerrainChunk({
        localGrid: grid,
        centerLat: testBounds.centerLat,
        centerLon: testBounds.centerLon,
        referenceCenterLat: testBounds.centerLat,
        referenceCenterLon: testBounds.centerLon,
        terrainBaseElevation: 1500,
        radiusMeters: 500,
        segments: 16,
        baseElevationSampler: () => 3000,
      });
      invisibleChunk.mesh.visible = false;

      attachLocalChunk(invisibleChunk);
      expect(invisibleChunk.material.map).toBe(testTex);

      attachLocalChunk(visibleChunk);
      expect(visibleChunk.material.map).toBe(testTex);

      // Invisible chunk (baseElevation 3000) should be skipped, visible chunk (baseElevation 2000) sampled
      const sampledY = sampleRenderedSurfaceY(0, 0);
      // Sample should be ~500 (2000 - 1500 baseElevation)
      expect(sampledY).toBeCloseTo(500, 0);

      visibleChunk.dispose();
      invisibleChunk.dispose();
    });
  });

  describe('LocalTerrainStreamer Single Visible Chunk Ownership', () => {
    it('enforces that only Station 0 is visible while background chunks are invisible', () => {
      const terrainGroup = new THREE.Group();
      const terrainMat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
      const terrainMesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
      terrainGroup.add(terrainMesh);

      const activeChunks: LocalTerrainChunk[] = [];
      const dummyTerrainResult: TerrainResult = {
        group: terrainGroup,
        terrainMesh,
        skirtMesh: new THREE.Mesh(),
        demGrid: createMockGrid(),
        bounds: testBounds,
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1500,
        terrainQuality: 'dem',
        tileGrid: testTileGrid,
        elevationSampler: () => 2000,
        sampleDEMY: () => 2000,
        sampleRenderedSurfaceY: () => 500,
        setTextureStyle: async () => {},
        setVerticalExaggeration: () => {},
        attachLocalChunk: (c?: LocalTerrainChunk) => {
          if (c) activeChunks.push(c);
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

      const streamer = new LocalTerrainStreamer({
        terrainResult: dummyTerrainResult,
        routeGeometry: dummyRouteGeometry,
        demGrid: dummyTerrainResult.demGrid!,
        qualityProfile: QualityProfileManager.getProfile('quest-high'),
        chunkRadiusM: 800,
        maxChunks: 3,
        evalThresholdM: 10,
      });

      vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue(null);

      // 1. Initial position at progress 0.0
      streamer.update(0.0);

      expect(streamer.activeChunks.length).toBeGreaterThanOrEqual(1);
      // Exactly one chunk must be visible: the active station chunk
      const visibleChunks = streamer.activeChunks.filter((c) => c.mesh.visible);
      expect(visibleChunks.length).toBe(1);
      expect(streamer.activeVisibleChunk).toBe(visibleChunks[0]);
      expect(streamer.activeChunks[0].mesh.visible).toBe(true);

      // Remaining managed chunks must be invisible (warm in memory)
      for (let i = 1; i < streamer.activeChunks.length; i++) {
        expect(streamer.activeChunks[i].mesh.visible).toBe(false);
      }

      // Check map texture inheritance
      expect(streamer.activeChunks[0].material.map).toBe(terrainMat.map);

      // 2. Move hiker along route (progress = 0.5)
      streamer.update(0.5);

      const visibleAfterMove = streamer.activeChunks.filter((c) => c.mesh.visible);
      expect(visibleAfterMove.length).toBe(1);
      expect(streamer.activeVisibleChunk).toBe(visibleAfterMove[0]);
      expect(streamer.activeChunks[0].mesh.visible).toBe(true);

      streamer.dispose();
      expect(streamer.activeChunks.length).toBe(0);
      expect(streamer.activeVisibleChunk).toBeNull();
    });
  });
});
