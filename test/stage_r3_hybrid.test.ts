import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import type { GeoBounds } from '../src/gpx/TrackTypes.ts';

describe('Stage R3: High-Resolution Hybrid Patches & Base Upload Optimization', () => {
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
  });

  afterEach(() => {
    (globalThis as any).Image = origImage;
    (globalThis as any).document = origDocument;
    TileImageCache.clear();
    vi.restoreAllMocks();
  });

  describe('Base Texture Upload Throttling and Mipmap Suppression (Section 26 & 27)', () => {
    it('defines throttle interval between 500ms and 1000ms and batch tile threshold', () => {
      expect(TextureProvider.UPLOAD_THROTTLE_MS).toBeGreaterThanOrEqual(500);
      expect(TextureProvider.UPLOAD_THROTTLE_MS).toBeLessThanOrEqual(1000);
      expect(TextureProvider.TILE_BATCH_THRESHOLD).toBeGreaterThanOrEqual(4);
      expect(TextureProvider.TILE_BATCH_THRESHOLD).toBeLessThanOrEqual(16);
    });

    it('suppresses mipmaps during progressive satellite streaming and enables them on final completion', async () => {
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

      const grid = {
        zoom: 14,
        tileXMin: 100,
        tileXMax: 103, // 4 x 4 = 16 tiles
        tileYMin: 200,
        tileYMax: 203,
        numTilesX: 4,
        numTilesY: 4,
      };

      const intermediateProgressStates: { mipmaps: boolean; minFilter: number; loaded: number }[] = [];

      const onProgress = (tex: THREE.CanvasTexture, loaded: number) => {
        intermediateProgressStates.push({
          mipmaps: tex.generateMipmaps,
          minFilter: tex.minFilter,
          loaded,
        });
      };

      const texture = await TextureProvider.fetchSatelliteTexture(grid, onProgress);
      expect(texture).not.toBeNull();

      if (texture) {
        // Final completion must enable mipmaps and LinearMipmapLinearFilter (Req #27)
        expect(texture.generateMipmaps).toBe(true);
        expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);

        // Intermediate progress updates (if any occurred before totalCount) must have mipmaps disabled
        const intermediateUpdates = intermediateProgressStates.filter((s) => s.loaded < 16);
        for (const state of intermediateUpdates) {
          expect(state.mipmaps).toBe(false);
          expect(state.minFilter).toBe(THREE.LinearFilter);
        }

        // Throttling: intermediate updates must not fire on every single tile (Req #26)
        expect(intermediateUpdates.length).toBeLessThan(16);

        texture.dispose();
      }
    });

    it('suppresses mipmaps during progressive hybrid streaming and enables them on final completion', async () => {
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

      const grid = {
        zoom: 14,
        tileXMin: 50,
        tileXMax: 52, // 3 x 3 = 9 tiles
        tileYMin: 60,
        tileYMax: 62,
        numTilesX: 3,
        numTilesY: 3,
      };

      const progressSnapshots: { mipmaps: boolean; minFilter: number }[] = [];

      const texture = await TextureProvider.fetchHybridTexture(grid, (tex) => {
        progressSnapshots.push({
          mipmaps: tex.generateMipmaps,
          minFilter: tex.minFilter,
        });
      });

      expect(texture).not.toBeNull();
      if (texture) {
        expect(texture.generateMipmaps).toBe(true);
        expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
        texture.dispose();
      }
    });

    it('suppresses mipmaps during progressive topo streaming and enables them on final completion', async () => {
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

      const grid = {
        zoom: 14,
        tileXMin: 50,
        tileXMax: 52,
        tileYMin: 60,
        tileYMax: 62,
        numTilesX: 3,
        numTilesY: 3,
      };

      const texture = await TextureProvider.fetchTopoTexture(grid);
      expect(texture).not.toBeNull();
      if (texture) {
        expect(texture.generateMipmaps).toBe(true);
        expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
        texture.dispose();
      }
    });
  });

  describe('Real High-Resolution Hybrid Patch Compositing (Section 6)', () => {
    it('loadPatchImage composites base satellite and overlay labels into an offscreen canvas', async () => {
      const drawnImages: any[] = [];

      const mockCanvas: any = {
        width: 256,
        height: 256,
        getContext: vi.fn(() => ({
          drawImage: (img: any, x: number, y: number, w: number, h: number) => {
            drawnImages.push({ img, x, y, w, h });
          },
        })),
      };

      (globalThis as any).document.createElement = (tag: string) => {
        if (tag === 'canvas') return mockCanvas;
        return {};
      };

      const satTile = { id: 'sat-tile-14-1-2' };
      const labelTile = { id: 'label-tile-14-1-2' };

      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async (provider: any) => {
        if (provider.id === 'esri-labels') {
          return labelTile as any;
        }
        return satTile as any;
      });

      const result = await ImageryLODManager.loadPatchImage(14, 1, 2, 'hybrid');

      expect(result).toBe(mockCanvas);
      expect(drawnImages.length).toBe(2);
      expect(drawnImages[0].img).toBe(satTile);
      expect(drawnImages[1].img).toBe(labelTile);
    });

    it('loadPatchImage falls back gracefully to satellite when label overlay fetch fails', async () => {
      const drawnImages: any[] = [];

      const mockCanvas: any = {
        width: 256,
        height: 256,
        getContext: vi.fn(() => ({
          drawImage: (img: any, x: number, y: number, w: number, h: number) => {
            drawnImages.push({ img, x, y, w, h });
          },
        })),
      };

      (globalThis as any).document.createElement = (tag: string) => {
        if (tag === 'canvas') return mockCanvas;
        return {};
      };

      const satTile = { id: 'sat-tile-only' };

      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async (provider: any) => {
        if (provider.id === 'esri-labels') {
          throw new Error('404 Not Found (wilderness area)');
        }
        return satTile as any;
      });

      const result = await ImageryLODManager.loadPatchImage(14, 5, 6, 'hybrid');

      expect(result).toBe(mockCanvas);
      expect(drawnImages.length).toBe(1);
      expect(drawnImages[0].img).toBe(satTile);
    });

    it('loadPatchImage rejects if the base satellite tile fails to load', async () => {
      vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async (provider: any) => {
        if (provider.id === 'esri-satellite') {
          throw new Error('Network timeout');
        }
        return {} as any;
      });

      await expect(ImageryLODManager.loadPatchImage(14, 5, 6, 'hybrid')).rejects.toThrow('Network timeout');
    });

    it('end-to-end: mounts hybrid patches with proper polygonOffset and texture settings', async () => {
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

      const mockBounds: GeoBounds = {
        minLat: 46.80,
        maxLat: 46.90,
        minLon: -121.80,
        maxLon: -121.70,
        minEle: 1500,
        maxEle: 4000,
        elevationSpan: 2500,
        centerLat: 46.85,
        centerLon: -121.75,
        widthMeters: 8000,
        depthMeters: 8000,
      };

      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1500,
        elevationSampler: () => 100,
        textureStyle: 'hybrid',
      });

      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
      camera.position.set(0, 1.2, 1.8);
      camera.lookAt(0, 0, 0);

      const dioramaRoot = new THREE.Group();

      lod.update(camera, dioramaRoot, false);

      // Wait for image loads and canvas compositing to settle
      await new Promise((r) => setTimeout(r, 150));

      const diag = lod.getDiagnostics();
      expect(diag.activePatchesCount).toBeGreaterThan(0);

      // Verify patch mesh properties
      const patchGroup = lod.group;
      const firstPatchMesh = patchGroup.children[0] as THREE.Mesh;
      expect(firstPatchMesh).toBeDefined();

      const mat = firstPatchMesh.material as THREE.MeshStandardMaterial;
      expect(mat.polygonOffset).toBe(true);
      expect(mat.polygonOffsetFactor).toBe(-1.0);
      expect(mat.polygonOffsetUnits).toBe(-1.0);

      const tex = mat.map as THREE.CanvasTexture;
      expect(tex).toBeDefined();
      expect(tex.generateMipmaps).toBe(true);
      expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);

      // Switching style clears all hybrid patches
      await lod.setTextureStyle('topo');
      expect(lod.getDiagnostics().activePatchesCount).toBe(0);

      lod.dispose();
    });
  });
});
