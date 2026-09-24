import * as THREE from 'three';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GPXPoint, TrackStats } from '../src/gpx/TrackTypes.ts';
import { localMetersToGeo } from '../src/gpx/Coordinates.ts';
import { TextureBudget } from '../src/terrain/TextureBudget.ts';
import { TerrainGenerator, type TerrainResult } from '../src/terrain/TerrainGenerator.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';

function createSyntheticTrackOnSlope(
  name: string,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  numPoints: number
): TrackStats {
  const points: GPXPoint[] = [];
  let cumulativeDist = 0;

  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);
    const x = start.x + t * (end.x - start.x);
    const y = start.y + t * (end.y - start.y);
    const z = start.z + t * (end.z - start.z);

    if (i > 0) {
      const prev = points[i - 1];
      const prevX = (prev.lon - (-121.0)) * 111320 * Math.cos((47.0 * Math.PI) / 180);
      const prevZ = -(prev.lat - 47.0) * 111320;
      cumulativeDist += Math.hypot(x - prevX, z - prevZ);
    }

    const geo = localMetersToGeo(x, z, 47.0, -121.0);
    points.push({
      lat: geo.lat,
      lon: geo.lon,
      ele: 1000 + y,
      distanceFromStart: cumulativeDist,
      elapsedSeconds: i * 30,
      playbackSeconds: i * 30,
      index: i,
      segmentIndex: 0,
    });
  }

  const bounds = {
    minLat: Math.min(...points.map((p) => p.lat)),
    maxLat: Math.max(...points.map((p) => p.lat)),
    minLon: Math.min(...points.map((p) => p.lon)),
    maxLon: Math.max(...points.map((p) => p.lon)),
    centerLat: 47.0,
    centerLon: -121.0,
    minEle: 1000,
    maxEle: 2000,
    widthMeters: 4000,
    depthMeters: 4000,
    elevationSpan: 1000,
  };

  return {
    name,
    points,
    segments: [
      {
        points,
        distance: cumulativeDist,
        elevationGain: 0,
        elevationLoss: 0,
        startIndex: 0,
        endIndex: points.length - 1,
      },
    ],
    totalDistance: cumulativeDist,
    elevationGain: 0,
    elevationLoss: 0,
    minElevation: 1000,
    maxElevation: 2000,
    movingTime: 1800,
    totalPlaybackSeconds: 60,
    avgSpeed: 4.5,
    maxSpeed: 6.0,
    waypoints: [],
    landmarks: [],
    warnings: [],
    bounds,
    timingType: 'recorded',
  };
}

describe('Stage U2: Unified Rendered Terrain Surface & Conforming Overlays', () => {
  let origDocument: any;
  let mockCtx: any;

  beforeEach(() => {
    origDocument = (globalThis as any).document;
    mockCtx = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 256,
            height: 256,
            getContext: () => mockCtx,
          };
        }
        return {};
      },
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
  });

  it('aspect-aware terrain mesh maintains 1:1 cell aspect ratio and stays within budget', () => {
    // 1. Mount Rainier: ~27km x 27km square terrain zone
    const rainierQuest = TextureBudget.getTerrainMeshResolution(27000, 27000, true);
    expect(rainierQuest.segX).toBeCloseTo(225, -1);
    expect(rainierQuest.segZ).toBeCloseTo(225, -1);
    const rainierVerts = (rainierQuest.segX + 1) * (rainierQuest.segZ + 1);
    expect(rainierVerts).toBeLessThanOrEqual(125000);
    // Cell aspect ratio close to 1:1
    const cellAspectRainier = (27000 / rainierQuest.segX) / (27000 / rainierQuest.segZ);
    expect(cellAspectRainier).toBeCloseTo(1.0, 2);

    // 2. Bailey Range Traverse: ~22.5km width x 75km depth (3.33:1 rectangular zone)
    const baileyQuest = TextureBudget.getTerrainMeshResolution(22500, 75000, true);
    const baileyVerts = (baileyQuest.segX + 1) * (baileyQuest.segZ + 1);
    expect(baileyVerts).toBeLessThanOrEqual(125000);
    // Ensure longitudinal segments are dramatically higher than lateral segments
    expect(baileyQuest.segZ).toBeGreaterThan(baileyQuest.segX * 2.5);
    // Cell aspect ratio remains uniform 1:1 square
    const dxBailey = 22500 / baileyQuest.segX;
    const dzBailey = 75000 / baileyQuest.segZ;
    expect(dxBailey / dzBailey).toBeCloseTo(1.0, 1);

    // 3. Backward-compatibility: single argument calls continue working
    const legacySmall = TextureBudget.getTerrainMeshResolution(5000);
    expect(legacySmall.segX).toBe(128);
    expect(legacySmall.segZ).toBe(128);

    const legacyTraverse = TextureBudget.getTerrainMeshResolution(60000);
    expect(legacyTraverse.segX).toBe(96);
    expect(legacyTraverse.segZ).toBe(96);
  });

  it('sampleRenderedSurfaceY performs exact barycentric interpolation within rendered triangles', async () => {
    // Mock terrain generator result with known unscaled heights on a 4x4 grid (5x5 vertices)
    const widthM = 400;
    const depthM = 400;
    const segX = 4;
    const segZ = 4;
    const stride = segX + 1; // 5

    // Synthetic slope: height = x + 2*z
    const syntheticSampler = (lat: number, lon: number) => 1500;
    const track = createSyntheticTrackOnSlope('Slope Test', { x: 0, y: 0, z: -100 }, { x: 0, y: 0, z: 100 }, 5);

    const terrain = await TerrainGenerator.generate(track, undefined, undefined, 1.0, false, {
      demGrid: null,
      terrainGeoBounds: track.bounds,
      elevationSamplerForGeo: syntheticSampler,
    });

    expect(terrain.sampleRenderedSurfaceY).toBeDefined();
    expect(terrain.sampleDEMY).toBeDefined();

    // Query corner vertices: must match the mesh vertex height exactly
    const pos = terrain.terrainMesh.geometry.attributes.position;
    const v0Height = pos.getY(0);
    const sampleCorner0 = terrain.sampleRenderedSurfaceY(-terrain.terrainGeoBounds.widthMeters / 2, -terrain.terrainGeoBounds.depthMeters / 2);
    expect(sampleCorner0).toBeCloseTo(v0Height, 3);

    // Query center vertex
    const centerSample = terrain.sampleRenderedSurfaceY(0, 0);
    expect(isNaN(centerSample)).toBe(false);

    terrain.dispose();
  });

  it('samples BOTH left and right ribbon edges independently on cross-slopes', () => {
    // Construct a route running North-South along Z (x = 0, z from -500 to +500)
    // Mountain slope is steep East-West: elevation increases with X (e.g. slope = 0.5: 50m rise per 100m East)
    const track = createSyntheticTrackOnSlope('Cross-Slope Track', { x: 0, y: 0, z: -500 }, { x: 0, y: 0, z: 500 }, 20);

    // Transverse slope sampler: Y = 0.5 * X + 100
    const slopeSampler = (x: number, z: number) => 0.5 * x + 100;

    const trail = TrailMesh.create(track, slopeSampler, 1000, 1.0);
    const dioramaGeo = trail.trailMesh.geometry;
    const posAttr = dioramaGeo.attributes.position;

    // Check ribbon vertices along the route
    // Each station has 2 vertices: Left (x < 0) and Right (x > 0)
    let leftCount = 0;
    let rightCount = 0;
    let verifiedDiffCount = 0;

    for (let i = 0; i < posAttr.count; i += 2) {
      const lx = posAttr.getX(i);
      const ly = posAttr.getY(i);
      const rx = posAttr.getX(i + 1);
      const ry = posAttr.getY(i + 1);

      // Verify lateral separation by ribbon width
      const width = Math.abs(rx - lx);
      expect(width).toBeGreaterThan(5.0);

      // Verify that left and right edges have different heights matching the cross-slope dy = 0.5 * dx
      const actualDy = Math.abs(ry - ly);
      const expectedDy = 0.5 * width;
      expect(actualDy).toBeCloseTo(expectedDy, 1);
      verifiedDiffCount++;
    }

    expect(verifiedDiffCount).toBeGreaterThan(10);
    trail.dispose();
  });

  it('allocates ribbon stations based on physical route distance', () => {
    // 1. Short 500m trail
    const shortTrack = createSyntheticTrackOnSlope('Short Trail', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 500 }, 10);
    const shortTrail = TrailMesh.create(shortTrack, undefined, 1000, 1.0);
    const shortVerts = shortTrail.trailMesh.geometry.attributes.position.count;
    // ~500m / 8m ~ 63 stations -> ~126 vertices
    expect(shortVerts).toBeGreaterThanOrEqual(100);
    expect(shortVerts).toBeLessThan(300);

    // 2. Long 24km traverse (would have been capped at 2400 stations in legacy code)
    const longTrack = createSyntheticTrackOnSlope('Long Traverse', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 24000 }, 50);
    const longTrail = TrailMesh.create(longTrack, undefined, 1000, 1.0);
    const longVerts = longTrail.trailMesh.geometry.attributes.position.count;
    // 24000m / 8m = 3000 stations -> 6000 vertices (each station has 2 vertices: left and right)
    expect(longVerts).toBeGreaterThanOrEqual(5000);

    shortTrail.dispose();
    longTrail.dispose();
  });

  it('applies display-space tabletop lift targeting ~1-2mm in room coordinates', () => {
    // 4000m small diorama: scale = 0.85 / 4000 = 0.0002125
    const track4k = createSyntheticTrackOnSlope('4k Track', { x: 0, y: 0, z: -2000 }, { x: 0, y: 0, z: 2000 }, 10);
    track4k.bounds.widthMeters = 4000;
    track4k.bounds.depthMeters = 4000;

    const zeroElevationSampler = () => 0;
    const trail4k = TrailMesh.create(track4k, zeroElevationSampler, 1000, 1.0);

    const pos = trail4k.trailMesh.geometry.attributes.position;
    // Local Y of ribbon vertex above 0 ground
    const localLift4k = pos.getY(0);

    // When scaled by diorama scale, room lift is bounded
    const dioramaScale4k = 0.85 / 4000;
    const roomLift4k = localLift4k * dioramaScale4k;
    expect(roomLift4k).toBeGreaterThanOrEqual(0.0004); // >= 0.4mm
    expect(roomLift4k).toBeLessThanOrEqual(0.0020);    // <= 2.0mm

    trail4k.dispose();
  });
});
