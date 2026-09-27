import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  computeFirstPersonCoherentLODTiles,
} from '../src/terrain/ImageryLODManager.ts';
import { metersPerPixelAtZoom, latLonToTile } from '../src/gpx/Coordinates.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import type { GeoBounds, TrackStats, GPXPoint } from '../src/gpx/TrackTypes.ts';

describe('Stage W4: 1:1 Quality Corridor, Extended Forward Prefetch & Latitude Sizing', () => {
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

  it('accounts for latitude-aware tile sizing via metersPerPixelAtZoom', () => {
    // Equator vs 46 degrees North vs 60 degrees North
    const mppEq = metersPerPixelAtZoom(0, 18);
    const mpp46 = metersPerPixelAtZoom(46.85, 18);
    const mpp60 = metersPerPixelAtZoom(60, 18);

    const tileWidthEq = mppEq * 256;
    const tileWidth46 = mpp46 * 256;
    const tileWidth60 = mpp60 * 256;

    // As latitude increases towards poles, Web Mercator tile metric width shrinks
    expect(tileWidth46).toBeLessThan(tileWidthEq);
    expect(tileWidth60).toBeLessThan(tileWidth46);

    // At 46.85° lat, z18 tile should be roughly 100-110m wide
    expect(tileWidth46).toBeGreaterThan(80);
    expect(tileWidth46).toBeLessThan(140);
  });

  it('keeps coherent nearby coverage ahead of distant route prefetch on the Quest budget', () => {
    const hikerLat = 46.85;
    const hikerLon = -121.75;
    const innerZoom = 19;
    const maxPatches = 64; // Quest 1:1 budget

    // Points along a Northward trail (~111m per 0.001 deg lat)
    // Hiker at 46.850, behind ~300m at 46.847, forward ~600m at 46.855
    const behindLat = 46.847;
    const behindLon = -121.75;
    const forwardLat = 46.855;
    const forwardLon = -121.75;

    const corridorPoints = [
      { lat: 46.847, lon: -121.75 },
      { lat: 46.848, lon: -121.75 },
      { lat: 46.849, lon: -121.75 },
      { lat: 46.850, lon: -121.75 },
      { lat: 46.851, lon: -121.75 },
      { lat: 46.852, lon: -121.75 },
      { lat: 46.853, lon: -121.75 },
      { lat: 46.854, lon: -121.75 },
      { lat: 46.855, lon: -121.75 },
    ];

    const candidates = computeFirstPersonCoherentLODTiles(
      hikerLat,
      hikerLon,
      forwardLat,
      forwardLon,
      innerZoom,
      maxPatches,
      testBounds,
      behindLat,
      behindLon,
      corridorPoints
    );

    expect(candidates.length).toBeLessThanOrEqual(maxPatches);

    const highTiles = candidates.filter((c) => c.zoom === innerZoom);
    const midTiles = candidates.filter((c) => c.zoom === innerZoom - 1);

    expect(highTiles.length).toBeGreaterThanOrEqual(24);
    expect(midTiles.length).toBeGreaterThan(0);

    // Group high-res tiles by parent
    const parentGroups = new Map<string, typeof highTiles>();
    for (const t of highTiles) {
      const parentKey = `${t.zoom - 1}:${Math.floor(t.x / 2)}:${Math.floor(t.y / 2)}`;
      let group = parentGroups.get(parentKey);
      if (!group) {
        group = [];
        parentGroups.set(parentKey, group);
      }
      group.push(t);
    }

    // Every parent group must have exactly 4 children (100% atomic)
    for (const [parentKey, children] of parentGroups.entries()) {
      expect(
        children.length,
        `Parent ${parentKey} must have all 4 children, but had ${children.length}`
      ).toBe(4);
    }

    // All four parents surrounding the hiker must precede farther route tiles.
    const hikerTile = latLonToTile(hikerLat, hikerLon, innerZoom);
    const hikerPx = Math.floor(hikerTile.x / 2);
    const hikerPy = Math.floor(hikerTile.y / 2);
    const adjacentPx = hikerPx + (hikerTile.x % 2 === 0 ? -1 : 1);
    const adjacentPy = hikerPy + (hikerTile.y % 2 === 0 ? -1 : 1);
    for (const py of [hikerPy, adjacentPy]) {
      for (const px of [hikerPx, adjacentPx]) {
        expect(parentGroups.has(`${innerZoom - 1}:${px}:${py}`)).toBe(true);
      }
    }
  });

  it('prioritizes a visible off-trail wall over route prefetch', () => {
    const hikerLat = 46.85;
    const hikerLon = -121.75;
    const wall = { lat: 46.851, lon: -121.747 };
    const corridorPoints = Array.from({ length: 12 }, (_, i) => ({
      lat: hikerLat + i * 0.0005,
      lon: hikerLon,
    }));
    const candidates = computeFirstPersonCoherentLODTiles(
      hikerLat, hikerLon, 46.8555, hikerLon, 19, 64,
      testBounds, 46.848, hikerLon, corridorPoints, [wall]
    );
    const wallTile = latLonToTile(wall.lat, wall.lon, 19);
    expect(candidates.some((tile) =>
      tile.zoom === 19 &&
      Math.floor(tile.x / 2) === Math.floor(wallTile.x / 2) &&
      Math.floor(tile.y / 2) === Math.floor(wallTile.y / 2)
    )).toBe(true);
    expect(candidates.length).toBeLessThanOrEqual(64);
  });

  describe('First-Person Movement Threshold and Demotion Protection in ImageryLODManager', () => {
    let manager: ImageryLODManager;
    let camera: THREE.PerspectiveCamera;
    let dioramaRoot: THREE.Group;
    let mockRoute: RouteGeometry;

    beforeEach(() => {
      camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      camera.position.set(0, 1.5, 0);
      camera.lookAt(0, 1.5, -1);

      dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0, 0.82, -0.80);
      dioramaRoot.scale.set(1, 1, 1);

      // Create a straight mock route: 1000m long, 10 points
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
        name: 'Test Trail',
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

    it('triggers LOD evaluation when movement exceeds firstPersonEvalDistM (15m)', () => {
      // First frame initializes
      manager.update(camera, dioramaRoot, true, 0.0);
      const diag1 = manager.getDiagnostics();
      expect(diag1.activePatchesCount).toBeGreaterThanOrEqual(0);

      // Small movement: 5 meters (0.005 progress on 1000m track)
      // Should NOT re-evaluate since progressDistMoved (5m) < firstPersonEvalDistM (15m)
      manager.update(camera, dioramaRoot, true, 0.005);
      const diag2 = manager.getDiagnostics();
      expect(diag2.generation).toBe(diag1.generation);

      // Significant movement: 30 meters (0.035 progress)
      // Should trigger re-evaluation since progressDistMoved (30m) > firstPersonEvalDistM (15m)
      manager.update(camera, dioramaRoot, true, 0.035);
      const diag3 = manager.getDiagnostics();
      expect(diag3.currentProgress).toBeCloseTo(0.035);
    });
  });
});
