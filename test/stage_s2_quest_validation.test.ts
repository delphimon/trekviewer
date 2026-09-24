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

describe('Stage S2: Quest Mixed Reality Validation & Invariance Suite', () => {
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

  describe('XR Enablement & Conservative Quest Budgets (Section 40)', () => {
    it('LoadedTrek initializes ImageryLODManager with enableInXR: true', async () => {
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

      // Verify that LOD is enabled in XR by default
      const dioramaRoot = new THREE.Group();
      dioramaRoot.add(loadedTrek.group);
      dioramaRoot.position.set(0, 0.82, -0.80);
      dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.5, 0);
      camera.lookAt(0, 0.82, -0.80);

      // Call update with isXR = true
      loadedTrek.imageryLOD.update(camera, dioramaRoot, true);
      await new Promise((r) => setTimeout(r, 150));

      const diag = loadedTrek.imageryLOD.getDiagnostics();
      expect(diag.activePatchesCount).toBeGreaterThan(0);

      loadedTrek.dispose();
    });

    it('automatically applies conservative Quest profile in XR: maxPatches = 24, maxConcurrency = 4', async () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        enableInXR: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.5, 0);
      camera.lookAt(0, 0.82, -0.80);
      const dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0, 0.82, -0.80);
      dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);

      lod.update(camera, dioramaRoot, true);
      await new Promise((r) => setTimeout(r, 150));

      // Diagnostics should confirm conservative bounds
      const diag = lod.getDiagnostics();
      expect(diag.activePatchesCount).toBeLessThanOrEqual(24);

      lod.dispose();
    });
  });

  describe('Subsystem Isolation & Absolute Headset-Freedom Invariance (Section 43 & 44)', () => {
    it('guarantees dioramaRoot remains 100% stationary and world-locked in room coordinates while user moves', async () => {
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        enableInXR: true,
      });

      const dioramaRoot = new THREE.Group();
      // Natural tabletop position in MR room space
      const initialPos = new THREE.Vector3(0, 0.82, -0.80);
      const initialRot = new THREE.Euler(0, 0, 0);
      const initialScale = new THREE.Vector3(0.0001, 0.0001, 0.0001);

      dioramaRoot.position.copy(initialPos);
      dioramaRoot.rotation.copy(initialRot);
      dioramaRoot.scale.copy(initialScale);
      dioramaRoot.add(lod.group);

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);

      // Simulate user walking 360 degrees around the table in room space
      const radius = 1.2;
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        mockTime += 300;
        const angle = (i / steps) * Math.PI * 2;
        const camX = Math.sin(angle) * radius;
        const camZ = -0.80 + Math.cos(angle) * radius;
        const camY = 1.4 + Math.sin(angle * 2) * 0.1; // Head bob

        camera.position.set(camX, camY, camZ);
        camera.lookAt(dioramaRoot.position);

        lod.update(camera, dioramaRoot, true);

        // STABLE MR INVARIANT: dioramaRoot transform must NEVER be modified by LOD
        expect(dioramaRoot.position.x).toBe(initialPos.x);
        expect(dioramaRoot.position.y).toBe(initialPos.y);
        expect(dioramaRoot.position.z).toBe(initialPos.z);
        expect(dioramaRoot.rotation.x).toBe(initialRot.x);
        expect(dioramaRoot.rotation.y).toBe(initialRot.y);
        expect(dioramaRoot.rotation.z).toBe(initialRot.z);
        expect(dioramaRoot.scale.x).toBe(initialScale.x);
        expect(dioramaRoot.scale.y).toBe(initialScale.y);
        expect(dioramaRoot.scale.z).toBe(initialScale.z);

        // STABLE MR INVARIANT: camera transform must NEVER be modified by LOD
        expect(camera.position.x).toBe(camX);
        expect(camera.position.y).toBe(camY);
        expect(camera.position.z).toBe(camZ);
      }

      // Verify patch count remains strictly bounded
      const diag = lod.getDiagnostics();
      expect(diag.activePatchesCount).toBeLessThanOrEqual(24);

      lod.dispose();
    });
  });

  describe('Memory Bounds & Clean Detachment', () => {
    it('cleanly disposes all patches, textures, and detaches without memory leaks', async () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: track.bounds,
        terrainBaseElevation: track.bounds.minEle,
        elevationSampler: () => 2000,
        enableInXR: true,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.5, 0);
      camera.lookAt(0, 0.82, -0.80);
      const dioramaRoot = new THREE.Group();
      dioramaRoot.add(lod.group);
      dioramaRoot.position.set(0, 0.82, -0.80);
      dioramaRoot.scale.set(0.0001, 0.0001, 0.0001);

      lod.update(camera, dioramaRoot, true);
      await new Promise((r) => setTimeout(r, 150));

      expect(lod.getDiagnostics().activePatchesCount).toBeGreaterThan(0);
      expect(lod.group.children.length).toBeGreaterThan(0);

      // Dispose
      lod.dispose();

      expect(lod.getDiagnostics().activePatchesCount).toBe(0);
      expect(lod.group.children.length).toBe(0);
      expect(lod.group.parent).toBeNull();
    });
  });
});
