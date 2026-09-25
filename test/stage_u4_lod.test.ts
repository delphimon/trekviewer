import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  ImageryLODManager,
  getViewMetrics,
  getPatchSubdivisionSegments,
  computeCoherentLODTiles,
  getTileKey,
  getParentTileKey,
  getChildTileKeys,
  parseTileKey,
} from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { QUALITY_PROFILES } from '../src/terrain/QualityProfile.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage U4: Coherent Imagery LOD Suite', () => {
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

  const testBounds: GeoBounds = {
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

  describe('XR View Metrics Helper (Section 45)', () => {
    it('derives verticalFov and viewportHeightPx from standard PerspectiveCamera', () => {
      const camera = new THREE.PerspectiveCamera(65, 1.77, 0.1, 1000);
      camera.position.set(1, 2, 3);
      camera.lookAt(0, 0, 0);

      const metrics = getViewMetrics(camera);
      expect(metrics.worldPosition.x).toBeCloseTo(1);
      expect(metrics.worldPosition.y).toBeCloseTo(2);
      expect(metrics.worldPosition.z).toBeCloseTo(3);
      expect(metrics.verticalFov).toBeCloseTo(65, 1);
      expect(metrics.viewportHeightPx).toBeGreaterThan(0);
    });

    it('derives verticalFov from XR ArrayCamera subcamera projection matrix', () => {
      // In WebXR, renderer.xr.getCamera() returns an ArrayCamera
      const arrayCamera = new THREE.ArrayCamera();
      arrayCamera.position.set(0, 1.6, 0);

      // Create a subcamera with custom projection matrix
      // fovY = 70 degrees -> tan(35 deg) = 0.7002075 -> elements[5] = 1 / 0.7002075 ≈ 1.4281
      const subCam = new THREE.PerspectiveCamera();
      const proj = new THREE.Matrix4();
      const fovRad = (70 * Math.PI) / 180;
      proj.elements[5] = 1 / Math.tan(fovRad / 2);
      subCam.projectionMatrix.copy(proj);
      (subCam as any).viewport = { x: 0, y: 0, z: 1832, w: 1920 };

      arrayCamera.cameras = [subCam];

      const metrics = getViewMetrics(arrayCamera);
      expect(metrics.verticalFov).toBeCloseTo(70, 0.5);
      expect(metrics.viewportHeightPx).toBe(1920);
    });

    it('extracts WebXR baseLayer framebuffer height when presenting', () => {
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      const mockRenderer = {
        xr: {
          isPresenting: true,
          getSession: () => ({
            renderState: {
              baseLayer: {
                framebufferHeight: 2048,
              },
            },
          }),
        },
      } as any;

      const metrics = getViewMetrics(camera, mockRenderer);
      expect(metrics.viewportHeightPx).toBe(2048);
    });
  });

  describe('Dynamic Patch Subdivision (Section 44)', () => {
    it('scales grid segments dynamically based on imagery zoom', () => {
      // Zoom 19 and 18 are high-res tiles spanning only ~30-60m; 4x4 segments is optimal
      expect(getPatchSubdivisionSegments(19)).toBe(4);
      expect(getPatchSubdivisionSegments(18)).toBe(4);

      // Zoom 17 and 16 use 6x6 segments
      expect(getPatchSubdivisionSegments(17)).toBe(6);
      expect(getPatchSubdivisionSegments(16)).toBe(6);

      // Lower zooms (<= 15) use 8x8 segments
      expect(getPatchSubdivisionSegments(15)).toBe(8);
      expect(getPatchSubdivisionSegments(14)).toBe(8);
      expect(getPatchSubdivisionSegments(13)).toBe(8);
    });
  });

  describe('LOD Coherence and Coverage Budgeting (Sections 38, 39, 62)', () => {
    it('selects coherent nested refinement rings without checkerboard holes (Section 62)', () => {
      // Quest budget: max 24 patches
      const maxPatches = 24;
      const targetZoom = 19;

      const candidates = computeCoherentLODTiles(
        testBounds.centerLat,
        testBounds.centerLon,
        targetZoom,
        maxPatches,
        testBounds
      );

      expect(candidates.length).toBeLessThanOrEqual(maxPatches);

      const highTiles = candidates.filter((t) => t.zoom === 19);
      const midTiles = candidates.filter((t) => t.zoom === 18);

      // High-res focus: contiguous grid at z19
      expect(highTiles.length).toBeGreaterThanOrEqual(4);
      expect(highTiles.length).toBeLessThanOrEqual(9);

      // Mid-res surrounding ring: contiguous ring at z18
      expect(midTiles.length).toBeGreaterThan(0);
      expect(highTiles.length + midTiles.length).toBeLessThanOrEqual(maxPatches);

      // Verify spatial contiguity of high-res tiles: all X and Y coordinates must form a continuous range
      const xs = highTiles.map((t) => t.x);
      const ys = highTiles.map((t) => t.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);

      // Every tile in [minX, maxX] x [minY, maxY] must be present in highTiles (zero holes in bounding box)
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const found = highTiles.some((t) => t.x === x && t.y === y);
          expect(found).toBe(true);
        }
      }

      // Verify mid-res ring tiles surround the high-res parent bounding box
      const parentMinX = Math.floor(minX / 2);
      const parentMaxX = Math.floor(maxX / 2);
      const parentMinY = Math.floor(minY / 2);
      const parentMaxY = Math.floor(maxY / 2);

      // Mid-res tiles must be in the outer perimeter ring [parentMinX-1, parentMaxX+1] x [parentMinY-1, parentMaxY+1]
      for (const mid of midTiles) {
        expect(mid.x).toBeGreaterThanOrEqual(parentMinX - 1);
        expect(mid.x).toBeLessThanOrEqual(parentMaxX + 1);
        expect(mid.y).toBeGreaterThanOrEqual(parentMinY - 1);
        expect(mid.y).toBeLessThanOrEqual(parentMaxY + 1);
        // And not inside the inner parent footprint
        const isInsideInnerFootprint =
          mid.x >= parentMinX && mid.x <= parentMaxX && mid.y >= parentMinY && mid.y <= parentMaxY;
        expect(isInsideInnerFootprint).toBe(false);
      }
    });

    it('coherently shrinks ROI or lowers to zMid if budget is smaller than 21 (Section 38)', () => {
      // Budget = 12 (too small for 3x3 high + 12 mid = 21)
      const maxPatches = 12;
      const targetZoom = 19;

      const candidates = computeCoherentLODTiles(
        testBounds.centerLat,
        testBounds.centerLon,
        targetZoom,
        maxPatches,
        testBounds
      );

      expect(candidates.length).toBeLessThanOrEqual(maxPatches);
      // Verify that no random holes exist and all tiles have valid zoom
      for (const c of candidates) {
        expect([18, 19]).toContain(c.zoom);
      }
    });
  });

  describe('Explicit Parent/Child Replacement (Sections 40, 41, 63)', () => {
    it('z18 visible, z19 requested: 2/4 children ready leaves z18 as sole visible owner; 4/4 ready replaces parent (Section 63)', () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableInXR: true,
        enableFadeIn: false, // Instant swap for deterministic testing
      });

      const parentZ = 18;
      const parentX = 5293;
      const parentY = 11536;
      const style = 'satellite';
      const parentKey = getTileKey(style, parentZ, parentX, parentY);

      // 1. Mount parent patch at z18
      const dummyGeo = new THREE.BufferGeometry();
      const dummyMat = new THREE.MeshStandardMaterial();
      const dummyTexture = new THREE.Texture();
      const parentMesh = new THREE.Mesh(dummyGeo, dummyMat);

      const parentPatch = {
        key: parentKey,
        zoom: parentZ,
        x: parentX,
        y: parentY,
        mesh: parentMesh,
        texture: dummyTexture,
        lastUsed: Date.now(),
        centerDist: 0,
        creationTime: Date.now(),
        isFading: false,
        fadeDurationMs: 0,
        dispose: () => {},
      };

      (manager as any).patches.set(parentKey, parentPatch);
      (manager as any).desiredTileKeys.add(parentKey);
      manager.updatePatchVisibility();

      expect(parentMesh.visible).toBe(true);
      expect(manager.getDiagnostics().visibleCount).toBe(1);

      // 2. Request 4 z19 children under that parent
      const childKeys = getChildTileKeys(style, parentZ, parentX, parentY);
      (manager as any).desiredTileKeys = new Set(childKeys);

      // 3. Mount only 2 of the 4 children
      const child1Mesh = new THREE.Mesh(dummyGeo, dummyMat);
      const child1Parsed = parseTileKey(childKeys[0]);
      (manager as any).patches.set(childKeys[0], {
        key: childKeys[0],
        zoom: child1Parsed.zoom,
        x: child1Parsed.x,
        y: child1Parsed.y,
        mesh: child1Mesh,
        texture: dummyTexture,
        lastUsed: Date.now(),
        centerDist: 0,
        creationTime: Date.now(),
        isFading: false,
        fadeDurationMs: 0,
        dispose: () => {},
      });

      const child2Mesh = new THREE.Mesh(dummyGeo, dummyMat);
      const child2Parsed = parseTileKey(childKeys[1]);
      (manager as any).patches.set(childKeys[1], {
        key: childKeys[1],
        zoom: child2Parsed.zoom,
        x: child2Parsed.x,
        y: child2Parsed.y,
        mesh: child2Mesh,
        texture: dummyTexture,
        lastUsed: Date.now(),
        centerDist: 0,
        creationTime: Date.now(),
        isFading: false,
        fadeDurationMs: 0,
        dispose: () => {},
      });

      manager.updatePatchVisibility();

      // Assert: only 2/4 children ready -> z18 parent remains sole visible owner!
      expect(parentMesh.visible).toBe(true);
      expect(child1Mesh.visible).toBe(false);
      expect(child2Mesh.visible).toBe(false);

      const diagPartial = manager.getDiagnostics();
      expect(diagPartial.visibleByZoom.get(18)).toBe(1);
      expect(diagPartial.visibleByZoom.get(19) ?? 0).toBe(0);

      // 4. Mount remaining 2 children (4/4 ready)
      const child3Mesh = new THREE.Mesh(dummyGeo, dummyMat);
      const child3Parsed = parseTileKey(childKeys[2]);
      (manager as any).patches.set(childKeys[2], {
        key: childKeys[2],
        zoom: child3Parsed.zoom,
        x: child3Parsed.x,
        y: child3Parsed.y,
        mesh: child3Mesh,
        texture: dummyTexture,
        lastUsed: Date.now(),
        centerDist: 0,
        creationTime: Date.now(),
        isFading: false,
        fadeDurationMs: 0,
        dispose: () => {},
      });

      const child4Mesh = new THREE.Mesh(dummyGeo, dummyMat);
      const child4Parsed = parseTileKey(childKeys[3]);
      (manager as any).patches.set(childKeys[3], {
        key: childKeys[3],
        zoom: child4Parsed.zoom,
        x: child4Parsed.x,
        y: child4Parsed.y,
        mesh: child4Mesh,
        texture: dummyTexture,
        lastUsed: Date.now(),
        centerDist: 0,
        creationTime: Date.now(),
        isFading: false,
        fadeDurationMs: 0,
        dispose: () => {},
      });

      manager.updatePatchVisibility();

      // Assert: 4/4 ready -> children replace parent!
      expect(child1Mesh.visible).toBe(true);
      expect(child2Mesh.visible).toBe(true);
      expect(child3Mesh.visible).toBe(true);
      expect(child4Mesh.visible).toBe(true);
      expect(parentMesh.visible).toBe(false); // Parent hidden!

      const diagFull = manager.getDiagnostics();
      expect(diagFull.visibleByZoom.get(18) ?? 0).toBe(0);
      expect(diagFull.visibleByZoom.get(19)).toBe(4);

      manager.dispose();
    });
  });

  describe('Depth & Opacity Fade Safety (Section 42)', () => {
    it('enforces depthWrite: false during fade-in and restores depthWrite: true upon settling', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableInXR: true,
        enableFadeIn: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.5, 0.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);

      manager.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 60));

      const patches = (manager as any).patches as Map<string, any>;
      expect(patches.size).toBeGreaterThan(0);

      const patch = patches.values().next().value;
      const mat = patch.mesh.material as THREE.MeshStandardMaterial;

      // Section 42: During fade-in: transparent = true, depthWrite = false, depthTest = true
      expect(patch.isFading).toBe(true);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.depthTest).toBe(true);

      // Simulate fade completion past fadeDurationMs
      patch.creationTime = performance.now() - 300;
      manager.update(camera, dioramaRoot, false);

      // Section 42: After fade completion: transparent = false, depthWrite = true, opacity = 1.0
      expect(patch.isFading).toBe(false);
      expect(mat.transparent).toBe(false);
      expect(mat.depthWrite).toBe(true);
      expect(mat.opacity).toBe(1.0);

      manager.dispose();
    });
  });

  describe('LOD Promotion Dwell Time (Section 46)', () => {
    it('requires target zoom to remain stable for 500ms before promoting zoom level', () => {
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableInXR: true,
        qualityProfile: {
          ...QUALITY_PROFILES['desktop-high'],
          promotionDwellMs: 500,
          evalIntervalMs: 100,
        },
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 1.5, 1.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.00008, 0.00008, 0.00008);

      // Initial run: initializes target zoom immediately
      manager.update(camera, dioramaRoot, false);
      const initialZoom = manager.getDiagnostics().targetZoom;

      // Move camera closer to trigger higher desired zoom
      camera.position.set(0, 0.35, 0.35);
      camera.lookAt(0, 0, 0);

      // 300ms later (t = 1300): candidate detected, promoteCandidateSince = 1300. Still dwelling (0ms < 500ms)
      mockTime += 300;
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBe(initialZoom);
      expect(manager.getDiagnostics().calculatedDesiredZoom).toBeGreaterThan(initialZoom);

      // 300ms later (t = 1600): still dwelling (300ms < 500ms) -> targetZoom NOT promoted yet!
      mockTime += 300;
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBe(initialZoom);

      // 300ms later (t = 1900): total dwell 600ms >= 500ms -> targetZoom promotes!
      mockTime += 300;
      manager.update(camera, dioramaRoot, false);
      expect(manager.getDiagnostics().targetZoom).toBeGreaterThan(initialZoom);

      manager.dispose();
    });

    it('promotes immediately when diorama scale or position changes significantly', () => {
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableInXR: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 1.5, 1.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.00008, 0.00008, 0.00008);

      manager.update(camera, dioramaRoot, false);
      const initialZoom = manager.getDiagnostics().targetZoom;

      // User pinches to zoom in diorama scale by 3x (scale ratio > 0.15) after 300ms
      mockTime += 300;
      dioramaRoot.scale.set(0.00024, 0.00024, 0.00024);
      manager.update(camera, dioramaRoot, false);

      // Should promote immediately without waiting for 500ms dwell time!
      expect(manager.getDiagnostics().targetZoom).toBeGreaterThan(initialZoom);

      manager.dispose();
    });
  });

  describe('Coverage Diagnostics (Section 47)', () => {
    it('reports visibleByZoom, desiredZoom, readyHighResCount, and totalDesiredHighResCount', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: testBounds,
        terrainBaseElevation: 1000,
        elevationSampler: () => 2000,
        enableInXR: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.5, 0.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0002, 0.0002, 0.0002);

      manager.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 60));

      const diag = manager.getDiagnostics();
      expect(diag.visibleByZoom).toBeInstanceOf(Map);
      expect(diag.desiredZoom).toBe(diag.targetZoom);
      expect(diag.readyHighResCount).toBeGreaterThanOrEqual(0);
      expect(diag.totalDesiredHighResCount).toBeGreaterThanOrEqual(0);
      expect(diag.requestedCount).toBeGreaterThan(0);
      expect(diag.readyCount).toBeGreaterThan(0);

      manager.dispose();
    });
  });
});
