import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { EsriWorldImageryProvider, USGSTopoProvider } from '../src/terrain/providers/ImageryProvider.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage M: Adaptive High-Resolution Map Imagery LOD', () => {
  let origImage: any;

  beforeEach(() => {
    origImage = (globalThis as any).Image;
    TileImageCache.clear();

    // Mock HTMLImageElement for headless testing
    (globalThis as any).Image = class MockImage {
      public src: string = '';
      public crossOrigin: string = '';
      public onload: (() => void) | null = null;
      public onerror: ((e: any) => void) | null = null;
      public width: number = 256;
      public height: number = 256;

      constructor() {
        setTimeout(() => {
          if (this.onload) this.onload();
        }, 10);
      }
    };
  });

  afterEach(() => {
    (globalThis as any).Image = origImage;
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  const mockBounds: GeoBounds = {
    minLat: 46.80,
    maxLat: 46.90,
    minLon: -121.80,
    maxLon: -121.70,
    centerLat: 46.85,
    centerLon: -121.75,
    minEle: 1500,
    maxEle: 4392,
    elevationSpan: 2892,
    widthMeters: 8000,
    depthMeters: 8000,
  };

  const mockElevationSampler = (x: number, z: number) => 2000 + Math.sin(x * 0.001) * 200;

  describe('Texel Density & Target Zoom Selection', () => {
    it('increases target zoom as diorama scale increases (scaling up mountain refines imagery)', () => {
      const centerLat = 46.85;
      const cameraDist = 1.5; // 1.5m away from tabletop
      const providerMax = 19;
      // Real-world scale for 8000m mountain: 0.85m tabletop = 0.85 / 8000
      const baseScale = 0.85 / 8000;

      // Overview scale (0.85m diorama)
      const zoomSmall = ImageryLODManager.calculateTargetZoom(cameraDist, baseScale, centerLat, 60, 1080, providerMax);
      // Enlarged scale (2.5m diorama: ~3x scale)
      const zoomLarge = ImageryLODManager.calculateTargetZoom(cameraDist, baseScale * 3.0, centerLat, 60, 1080, providerMax);
      // Close inspection / huge zoom (6.8m diorama: ~8x scale)
      const zoomDeep = ImageryLODManager.calculateTargetZoom(cameraDist, baseScale * 8.0, centerLat, 60, 1080, providerMax);

      assert(zoomLarge > zoomSmall, `Enlarged diorama must target higher zoom (got ${zoomLarge} vs ${zoomSmall})`);
      assert(zoomDeep > zoomLarge, `Close inspection must target higher zoom (got ${zoomDeep} vs ${zoomLarge})`);
    });

    it('never exceeds the provider maximum zoom', () => {
      const centerLat = 46.85;
      const topoMax = 16; // USGSTopo maxZoom is 16

      // Extremely large diorama (1:1 first person mode or huge magnification)
      const zoom = ImageryLODManager.calculateTargetZoom(0.2, 1.0, centerLat, 60, 1080, topoMax);
      assert.strictEqual(zoom, topoMax, `Target zoom must be clamped to provider max (got ${zoom})`);
    });

    it('applies zoom hysteresis to avoid rapid oscillation near boundaries', () => {
      const centerLat = 46.85;
      const cameraDist = 1.5;
      const baseScale = 0.85 / 8000;
      const initialZoom = ImageryLODManager.calculateTargetZoom(cameraDist, baseScale * 3.0, centerLat, 60, 1080, 19);

      // Minor drift (+5% scale) should stay at initialZoom via hysteresis
      const zoomDriftMinor = ImageryLODManager.calculateTargetZoom(cameraDist, baseScale * 3.05, centerLat, 60, 1080, 19, initialZoom);
      assert.strictEqual(zoomDriftMinor, initialZoom, 'Minor scale drift must maintain current zoom via hysteresis');
    });
  });

  describe('In-Flight Tile Request Deduplication', () => {
    it('deduplicates concurrent requests for the exact same tile into a single network load', async () => {
      const provider = new EsriWorldImageryProvider();

      // Launch 5 simultaneous requests for the exact same tile
      const p1 = TileImageCache.loadTile(provider, 15, 5240, 11450);
      const p2 = TileImageCache.loadTile(provider, 15, 5240, 11450);
      const p3 = TileImageCache.loadTile(provider, 15, 5240, 11450);
      const p4 = TileImageCache.loadTile(provider, 15, 5240, 11450);
      const p5 = TileImageCache.loadTile(provider, 15, 5240, 11450);

      // Verify in-flight count is 1, not 5
      assert.strictEqual(TileImageCache.getInFlightCount(), 1, 'In-flight map must deduplicate concurrent tile requests');

      const results = await Promise.all([p1, p2, p3, p4, p5]);

      // All 5 promises should resolve with the same cached image
      assert.strictEqual(results.length, 5);
      assert.strictEqual(results[0], results[1]);
      assert.strictEqual(results[0], results[4]);

      // In-flight map cleans up after settling
      assert.strictEqual(TileImageCache.getInFlightCount(), 0, 'In-flight map must clear upon settlement');
    });
  });

  describe('Subsystem Isolation & Transform Immutability Invariant', () => {
    it('LOD manager NEVER mutates dioramaRoot position, rotation, or scale', () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1500,
        elevationSampler: mockElevationSampler,
        verticalExaggeration: 1.5,
        textureStyle: 'satellite',
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.5, 2.0);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0.12, 0.85, -0.75);
      dioramaRoot.rotation.set(0.05, 0.45, 0);
      dioramaRoot.scale.set(1.8, 1.8, 1.8);

      const origPos = dioramaRoot.position.clone();
      const origRot = dioramaRoot.rotation.clone();
      const origScale = dioramaRoot.scale.clone();

      // Run multiple updates with simulated camera inspection
      for (let i = 0; i < 15; i++) {
        camera.position.x += 0.01;
        lod.update(camera, dioramaRoot, false);
      }

      // Assert dioramaRoot transform was strictly NOT mutated
      assert.deepStrictEqual(
        dioramaRoot.position.toArray(),
        origPos.toArray(),
        'dioramaRoot position must remain untouched by ImageryLODManager'
      );
      assert.deepStrictEqual(
        [dioramaRoot.rotation.x, dioramaRoot.rotation.y, dioramaRoot.rotation.z],
        [origRot.x, origRot.y, origRot.z],
        'dioramaRoot rotation must remain untouched by ImageryLODManager'
      );
      assert.deepStrictEqual(
        dioramaRoot.scale.toArray(),
        origScale.toArray(),
        'dioramaRoot scale must remain untouched by ImageryLODManager'
      );

      lod.dispose();
    });
  });

  describe('Patch Budget & Stationary Convergence', () => {
    it('enforces maximum patch budget and evicts furthest patches', async () => {
      const maxPatches = 6;
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1500,
        elevationSampler: mockElevationSampler,
        maxPatches,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.0, 1.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(3.0, 3.0, 3.0); // Scale up to trigger patches

      lod.update(camera, dioramaRoot, false);

      // Wait for mock tile image loads to settle
      await new Promise((r) => setTimeout(r, 60));

      const diag = lod.getDiagnostics();
      assert(
        diag.activePatchesCount <= maxPatches,
        `Active patches count (${diag.activePatchesCount}) must not exceed maxPatches budget (${maxPatches})`
      );

      lod.dispose();
    });

    it('converges to 0 new patches when stationary', async () => {
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1500,
        elevationSampler: mockElevationSampler,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.2, 1.8);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();

      // 1. First evaluation triggers tile requests
      lod.update(camera, dioramaRoot, false);

      // Wait for image loads to resolve
      await new Promise((r) => setTimeout(r, 150));

      const initialCreated = lod.getDiagnostics().patchesCreatedTotal;
      assert(initialCreated > 0, 'Initial evaluation should create patches');

      // 2. Subsequent updates while stationary over several seconds
      for (let i = 0; i < 10; i++) {
        mockTime += 300; // Advance time past eval interval
        lod.update(camera, dioramaRoot, false);
      }

      // Wait again
      await new Promise((r) => setTimeout(r, 50));

      const finalCreated = lod.getDiagnostics().patchesCreatedTotal;
      assert.strictEqual(
        finalCreated,
        initialCreated,
        'Stationary view must converge and create 0 additional patches'
      );

      lod.dispose();
    });

    it('texture style changes cleanly invalidate and replace existing patches', async () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1500,
        elevationSampler: mockElevationSampler,
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.0, 1.5);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();
      lod.update(camera, dioramaRoot, false);

      await new Promise((r) => setTimeout(r, 50));
      assert(lod.getDiagnostics().activePatchesCount > 0, 'Should have satellite patches mounted');

      // Switch style to topo
      await lod.setTextureStyle('topo');

      // Old satellite patches must be immediately purged
      assert.strictEqual(
        lod.getDiagnostics().activePatchesCount,
        0,
        'All old style patches must be purged immediately on style change'
      );

      lod.dispose();
    });
  });
});
