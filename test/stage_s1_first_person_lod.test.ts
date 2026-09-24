import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { RouteGeometry } from '../src/visualization/RouteGeometry.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';
import * as fs from 'fs';
import * as path from 'path';

describe('Stage S1: 1:1 First-Person Imagery Profile & Directional Prefetch Suite', () => {
  let origImage: any;
  let origDocument: any;
  let mockCtx: any;

  beforeEach(() => {
    origImage = (globalThis as any).Image;
    origDocument = (globalThis as any).document;
    TileImageCache.clear();

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

    (globalThis as any).Image = class MockImage {
      public src: string = '';
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public width: number = 256;
      public height: number = 256;
      constructor() {
        setTimeout(() => {
          if (this.onload) this.onload();
        }, 5);
      }
    };
  });

  afterEach(() => {
    (globalThis as any).Image = origImage;
    (globalThis as any).document = origDocument;
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  const rainierXml = fs.readFileSync(path.resolve('public/routes/MountRainierViaEmmons.gpx'), 'utf8');
  const track = GPXParser.parse(rainierXml, 'Mount Rainier');
  const routeGeometry = new RouteGeometry(track, track.bounds.minEle, () => 2000);

  describe('1:1 Trail Mode Imagery Profile & Zone Allocation (Section 11)', () => {
    it('centers high-resolution patch tile generation on hiker route position in first-person mode', async () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        routeGeometry,
        track,
        viewMode: 'first-person',
        verticalExaggeration: 1.0,
      });

      // Hiker at progress = 0.2
      lod.setRouteProgress(0.2);
      const tel = routeGeometry.getTelemetryAtProgress(0.2);
      const expectedCenterTile = latLonToTile(tel.currentPoint.lat, tel.currentPoint.lon, 18);

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      camera.position.set(tel.position.x, tel.position.y + 1.8, tel.position.z);
      camera.lookAt(tel.position.x + tel.tangent.x * 20, tel.position.y + 1.8, tel.position.z + tel.tangent.z * 20);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(1, 1, 1);

      lod.update(camera, dioramaRoot, false, 0.2);

      // Wait for patches to mount
      await new Promise((r) => setTimeout(r, 150));

      const diag = lod.getDiagnostics();
      expect(diag.viewMode).toBe('first-person');
      expect(diag.targetZoom).toBeGreaterThanOrEqual(18);
      expect(diag.activePatchesCount).toBeGreaterThan(0);

      // Verify that the hiker center tile or neighboring tile is mounted
      const patchGroup = lod.group;
      let foundClosePatch = false;
      patchGroup.traverse((child) => {
        if (child.name.includes(`${expectedCenterTile.x}`) || child.name.includes(`${expectedCenterTile.x - 1}`) || child.name.includes(`${expectedCenterTile.x + 1}`)) {
          foundClosePatch = true;
        }
      });
      expect(foundClosePatch).toBe(true);

      lod.dispose();
    });

    it('enforces natural 1x scale conforming patch heights in first-person mode', async () => {
      const fixedGroundY = 150.0;
      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => fixedGroundY,
        routeGeometry,
        track,
        viewMode: 'first-person',
        verticalExaggeration: 1.0, // 1:1 scale
      });

      lod.setRouteProgress(0.1);
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      camera.position.set(0, 100, 0);
      const dioramaRoot = new THREE.Group();

      lod.update(camera, dioramaRoot, false, 0.1);
      await new Promise((r) => setTimeout(r, 150));

      const patchGroup = lod.group;
      const firstPatch = patchGroup.children[0] as THREE.Mesh;
      expect(firstPatch).toBeDefined();

      const posAttr = firstPatch.geometry.attributes.position;
      // In 1:1 mode with verticalExaggeration = 1.0, y = groundLocalY * 1.0 + 0.04 = 150.04
      for (let i = 0; i < posAttr.count; i++) {
        expect(posAttr.getY(i)).toBeCloseTo(150.04, 2);
      }

      lod.dispose();
    });
  });

  describe('Directional Forward Prefetch & Reevaluation Threshold (Section 12)', () => {
    it('prefetches tiles ahead along the trail direction (~250m ahead)', async () => {
      const loadTileSpy = vi.spyOn(TileImageCache, 'loadTile');

      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        routeGeometry,
        track,
        viewMode: 'first-person',
        verticalExaggeration: 1.0,
      });

      lod.setRouteProgress(0.3);
      const telCurrent = routeGeometry.getTelemetryAtProgress(0.3);
      const currentDist = telCurrent.currentPoint.distanceFromStart;
      const telForward = routeGeometry.getTelemetryAtDistance(currentDist + 250);

      const forwardTile = latLonToTile(telForward.currentPoint.lat, telForward.currentPoint.lon, 18);

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      camera.position.set(telCurrent.position.x, telCurrent.position.y + 1.8, telCurrent.position.z);
      const dioramaRoot = new THREE.Group();

      lod.update(camera, dioramaRoot, false, 0.3);

      await new Promise((r) => setTimeout(r, 150));

      // Verify that forward tile was among requested tiles
      const requestedTileCoords = loadTileSpy.mock.calls.map((call) => ({
        zoom: call[1],
        x: call[2],
        y: call[3],
      }));

      const hasForwardTile = requestedTileCoords.some(
        (t) => t.zoom === 18 && Math.abs(t.x - forwardTile.x) <= 1 && Math.abs(t.y - forwardTile.y) <= 1
      );
      expect(hasForwardTile).toBe(true);

      lod.dispose();
    });

    it('suppresses reevaluation when user moves less than 50m along the route without view turn', async () => {
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        routeGeometry,
        track,
        viewMode: 'first-person',
        verticalExaggeration: 1.0,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      camera.position.set(0, 100, 0);
      camera.lookAt(0, 100, -100);
      const dioramaRoot = new THREE.Group();

      // Initial evaluation at progress 0.1
      lod.update(camera, dioramaRoot, false, 0.1);
      await new Promise((r) => setTimeout(r, 150));

      const initialCreated = lod.getDiagnostics().patchesCreatedTotal;
      expect(initialCreated).toBeGreaterThan(0);

      // Advance progress by tiny fraction (< 10 meters)
      // totalDistance is ~14,000m, so 0.0005 progress is ~7m
      mockTime += 400; // Past EVAL_INTERVAL_MS
      lod.update(camera, dioramaRoot, false, 0.1005);
      await new Promise((r) => setTimeout(r, 60));

      // Must NOT have created new patches (reevaluation suppressed under 50m threshold)
      expect(lod.getDiagnostics().patchesCreatedTotal).toBe(initialCreated);

      // Now move progress by >100m (e.g. +0.02 progress = ~280m)
      mockTime += 400;
      lod.update(camera, dioramaRoot, false, 0.12);
      await new Promise((r) => setTimeout(r, 150));

      // Should have triggered reevaluation
      expect(lod.getDiagnostics().currentProgress).toBe(0.12);

      lod.dispose();
    });
  });

  describe('View Mode Transitions (Diorama <-> First-Person)', () => {
    it('cleanly transitions between diorama and first-person mode and clears superseded patches', async () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        routeGeometry,
        track,
        viewMode: 'diorama',
        verticalExaggeration: 1.5,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
      camera.position.set(0, 1.2, 1.8);
      camera.lookAt(0, 0, 0);
      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);

      // 1. Diorama update
      lod.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 150));

      expect(lod.getDiagnostics().viewMode).toBe('diorama');
      expect(lod.getDiagnostics().activePatchesCount).toBeGreaterThan(0);

      // 2. Switch to first-person mode
      lod.setViewMode('first-person');
      expect(lod.getDiagnostics().viewMode).toBe('first-person');
      expect(lod.getDiagnostics().activePatchesCount).toBe(0); // Old patches cleared immediately

      // 3. First-person update at progress 0.5
      dioramaRoot.scale.set(1, 1, 1);
      lod.update(camera, dioramaRoot, false, 0.5);
      await new Promise((r) => setTimeout(r, 150));

      expect(lod.getDiagnostics().activePatchesCount).toBeGreaterThan(0);
      expect(lod.getDiagnostics().targetZoom).toBeGreaterThanOrEqual(18);

      // 4. Switch back to diorama mode
      lod.setViewMode('diorama');
      expect(lod.getDiagnostics().viewMode).toBe('diorama');
      expect(lod.getDiagnostics().activePatchesCount).toBe(0);

      lod.dispose();
    });
  });
});
