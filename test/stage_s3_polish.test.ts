import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { LoadedTrek } from '../src/core/LoadedTrek.ts';
import { GPXParser } from '../src/gpx/GPXParser.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { TrailMesh } from '../src/visualization/TrailMesh.ts';
import { DioramaBase } from '../src/visualization/DioramaBase.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';
import * as fs from 'fs';
import * as path from 'path';

describe('Stage S3: Visual Polish, Crossfades, and Final Verification Suite', () => {
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

  describe('Smooth Opacity Fade-In & Alpha Overhead Suppression', () => {
    it('initializes patches with transparent: true, opacity: 0.0 when enableFadeIn: true', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: 2000,
        elevationSampler: () => 2200,
        enableInXR: true,
        enableFadeIn: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.4, 0.3);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);

      manager.update(camera, dioramaRoot, false);

      // Wait for mock tile load
      await new Promise((r) => setTimeout(r, 60));

      const patches = (manager as any).patches as Map<string, any>;
      expect(patches.size).toBeGreaterThan(0);

      const firstPatch = patches.values().next().value;
      expect(firstPatch.isFading).toBe(true);

      const mat = firstPatch.mesh.material as THREE.MeshStandardMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeLessThan(1.0);

      manager.dispose();
    });

    it('advances opacity over time and settles to transparent: false and opacity: 1.0', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: 2000,
        elevationSampler: () => 2200,
        enableInXR: true,
        enableFadeIn: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.4, 0.3);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);

      manager.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 60));

      const patches = (manager as any).patches as Map<string, any>;
      const patch = patches.values().next().value;
      const mat = patch.mesh.material as THREE.MeshStandardMaterial;

      // Simulate passage of time past fadeDurationMs (250ms on desktop)
      patch.creationTime = performance.now() - 300;
      manager.update(camera, dioramaRoot, false);

      expect(patch.isFading).toBe(false);
      expect(mat.opacity).toBe(1.0);
      expect(mat.transparent).toBe(false); // Opaque rendering restored, 0 transparency overhead!

      manager.dispose();
    });

    it('renders immediately opaque when enableFadeIn: false', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: 2000,
        elevationSampler: () => 2200,
        enableInXR: true,
        enableFadeIn: false,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.4, 0.3);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);

      manager.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 60));

      const patches = (manager as any).patches as Map<string, any>;
      const patch = patches.values().next().value;
      const mat = patch.mesh.material as THREE.MeshStandardMaterial;

      expect(patch.isFading).toBe(false);
      expect(mat.transparent).toBe(false);
      expect(mat.opacity).toBe(1.0);

      manager.dispose();
    });
  });

  describe('Debug Patch Boundary Outlines', () => {
    it('attaches DebugPatchBoundary line segments when debugPatchBounds: true', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: 2000,
        elevationSampler: () => 2200,
        debugPatchBounds: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.4, 0.3);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);

      manager.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 60));

      const patches = (manager as any).patches as Map<string, any>;
      const patch = patches.values().next().value;
      expect(patch.outlineMesh).toBeDefined();
      expect(patch.outlineMesh.name).toBe('DebugPatchBoundary');
      expect(patch.mesh.children).toContain(patch.outlineMesh);

      // Diagnostic check
      const diag = manager.getDiagnostics();
      expect(diag.debugPatchBounds).toBe(true);

      manager.dispose();
    });

    it('dynamically toggles debug patch bounds via setDebugPatchBounds', async () => {
      const manager = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: 2000,
        elevationSampler: () => 2200,
        debugPatchBounds: false,
      });

      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(0, 0.4, 0.3);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);

      manager.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 60));

      const patches = (manager as any).patches as Map<string, any>;
      const patch = patches.values().next().value;
      expect(patch.outlineMesh).toBeUndefined();

      // Enable dynamically
      manager.setDebugPatchBounds(true);
      expect(patch.outlineMesh).toBeDefined();
      expect(patch.outlineMesh.name).toBe('DebugPatchBoundary');

      // Disable dynamically
      manager.setDebugPatchBounds(false);
      expect(patch.outlineMesh).toBeUndefined();

      manager.dispose();
    });

    it('LoadedTrek forwards setDebugPatchBounds cleanly', async () => {
      const terrainResult = await TerrainGenerator.generate(track, () => 2000);
      const trailResult = TrailMesh.create(track, () => 2000, track.bounds.minEle, 1.0);
      const dioramaBase = DioramaBase.create(track.bounds);
      const flyoverController = new FlyoverController(trailResult, track);

      const loadedTrek = new LoadedTrek({
        track,
        terrainResult,
        trailResult,
        dioramaBase,
        flyoverController,
      });

      loadedTrek.setDebugPatchBounds(true);
      expect(loadedTrek.imageryLOD.getDiagnostics().debugPatchBounds).toBe(true);

      loadedTrek.setDebugPatchBounds(false);
      expect(loadedTrek.imageryLOD.getDiagnostics().debugPatchBounds).toBe(false);

      loadedTrek.dispose();
    });
  });

  describe('Diorama World-Lock Invariance Verification', () => {
    it('maintains absolute world-lock of dioramaRoot across all view modes and camera movements', async () => {
      const terrainResult = await TerrainGenerator.generate(track, () => 2000);
      const trailResult = TrailMesh.create(track, () => 2000, track.bounds.minEle, 1.0);
      const dioramaBase = DioramaBase.create(track.bounds);
      const flyoverController = new FlyoverController(trailResult, track);

      const loadedTrek = new LoadedTrek({
        track,
        terrainResult,
        trailResult,
        dioramaBase,
        flyoverController,
      });

      const scene = new THREE.Scene();
      const dioramaRoot = new THREE.Group();
      dioramaRoot.name = 'DioramaRoot';
      dioramaRoot.position.set(0, 0.82, -0.80);
      dioramaRoot.rotation.set(0, 0, 0);
      dioramaRoot.scale.set(0.0003, 0.0003, 0.0003);
      scene.add(dioramaRoot);
      dioramaRoot.add(loadedTrek.group);

      const initialPos = dioramaRoot.position.clone();
      const initialRot = dioramaRoot.rotation.clone();
      const initialScale = dioramaRoot.scale.clone();

      const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);

      // Walk in circle around diorama in room space
      for (let angle = 0; angle <= 360; angle += 45) {
        const rad = (angle * Math.PI) / 180;
        xrCamera.position.set(Math.sin(rad) * 0.8, 1.2, -0.80 + Math.cos(rad) * 0.8);
        xrCamera.lookAt(0, 0.82, -0.80);

        loadedTrek.imageryLOD.update(xrCamera, dioramaRoot, true);
        await new Promise((r) => setTimeout(r, 10));

        // Verify dioramaRoot transform was NOT mutated by imagery LOD update
        expect(dioramaRoot.position.x).toBeCloseTo(initialPos.x, 6);
        expect(dioramaRoot.position.y).toBeCloseTo(initialPos.y, 6);
        expect(dioramaRoot.position.z).toBeCloseTo(initialPos.z, 6);
        expect(dioramaRoot.rotation.y).toBeCloseTo(initialRot.y, 6);
        expect(dioramaRoot.scale.x).toBeCloseTo(initialScale.x, 6);
      }

      loadedTrek.dispose();
      scene.remove(dioramaRoot);
    });
  });
});
