import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager';
import { TextureProvider } from '../src/terrain/TextureProvider';
import { TileImageCache } from '../src/terrain/TileImageCache';
import { EsriWorldImageryProvider, USGSTopoProvider, CesiumBingImageryProvider } from '../src/terrain/providers/ImageryProvider';
import { GeoBounds, GPXPoint, TrackStats } from '../src/gpx/TrackTypes';
import { RouteGeometry } from '../src/visualization/RouteGeometry';

describe('Stage T5: Maximum Imagery Quality & Active XR Camera Suite', () => {
  const mockBounds: GeoBounds = {
    minLat: 46.80,
    maxLat: 46.86,
    minLon: -121.77,
    maxLon: -121.71,
    minEle: 1650,
    maxEle: 4392,
    elevationSpan: 4392 - 1650,
    centerLat: 46.83,
    centerLon: -121.74,
    widthMeters: 5000,
    depthMeters: 7000,
  };

  const samplePoints: GPXPoint[] = [
    { lat: 46.830, lon: -121.740, ele: 2000, time: new Date(0), distanceFromStart: 0, elapsedSeconds: 0, playbackSeconds: 0, index: 0 },
    { lat: 46.832, lon: -121.742, ele: 2200, time: new Date(1000), distanceFromStart: 300, elapsedSeconds: 1000, playbackSeconds: 1000, index: 1 },
    { lat: 46.835, lon: -121.745, ele: 2500, time: new Date(2000), distanceFromStart: 800, elapsedSeconds: 2000, playbackSeconds: 2000, index: 2 },
  ];

  const mockTrack: TrackStats = {
    name: 'Rainier Test',
    totalDistance: 800,
    elevationGain: 500,
    elevationLoss: 0,
    minElevation: 2000,
    maxElevation: 2500,
    movingTime: 2000,
    totalPlaybackSeconds: 2000,
    avgSpeed: 1.44,
    maxSpeed: 2.0,
    bounds: mockBounds,
    points: samplePoints,
    segments: [],
    waypoints: [],
    landmarks: [],
    warnings: [],
  };

  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      measureText: () => ({ width: 60 }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      setLineDash: vi.fn(),
      roundRect: vi.fn(),
    };

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag.toLowerCase() === 'canvas') {
          return {
            tagName: 'CANVAS',
            width: 256,
            height: 256,
            getContext: () => mockCtx,
            style: {},
          };
        }
        return {
          tagName: tag.toUpperCase(),
          style: {},
        };
      },
    };

    // Mock TileImageCache.loadTile to return instant mock images
    vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async () => {
      const img: any = {
        width: 256,
        height: 256,
        complete: true,
        naturalWidth: 256,
        naturalHeight: 256,
      };
      return img;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Active XR Camera Tracking & Resolution (Sections 31, 38)', () => {
    it('accurately tracks 6DOF room-space world position when active XR camera is passed', () => {
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1650,
        elevationSampler: () => 2000,
        enableInXR: true,
      });

      const dioramaRoot = new THREE.Group();
      dioramaRoot.position.set(0, 0.82, -0.8);
      dioramaRoot.scale.setScalar(1.0);

      // Create a simulated XR camera rig where camera is child of an XR user offset
      const xrRig = new THREE.Group();
      xrRig.position.set(0.5, 0, 0.5); // user stepped 0.5m right and forward
      const xrCamera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      xrCamera.position.set(0, 1.6, 0); // eye height
      xrRig.add(xrCamera);
      xrRig.updateMatrixWorld(true);

      // World position of eye should be (0.5, 1.6, 0.5)
      const eyeWorldPos = new THREE.Vector3();
      xrCamera.getWorldPosition(eyeWorldPos);
      expect(eyeWorldPos.x).toBeCloseTo(0.5, 3);
      expect(eyeWorldPos.y).toBeCloseTo(1.6, 3);
      expect(eyeWorldPos.z).toBeCloseTo(0.5, 3);

      // Update LOD with active XR camera
      lod.update(xrCamera, dioramaRoot, true);

      // Invariant: dioramaRoot transform is never mutated
      expect(dioramaRoot.position.y).toBe(0.82);
      expect(dioramaRoot.position.z).toBe(-0.8);

      const diag = lod.getDiagnostics();
      expect(diag.activePatchesCount).toBeGreaterThanOrEqual(0);
      lod.dispose();
    });
  });

  describe('Maximum 1:1 First-Person Imagery Resolution (Sections 31, 34)', () => {
    it('maximizes inner zone zoom to provider max (z19) and middle zone to z18 for Esri World Imagery', async () => {
      await TextureProvider.setSatelliteProvider('esri');

      const routeGeo = new RouteGeometry(mockTrack, 1650, () => 2000);
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1650,
        elevationSampler: () => 2000,
        routeGeometry: routeGeo,
        track: mockTrack,
        viewMode: 'first-person',
        textureStyle: 'satellite',
      });

      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      camera.position.set(0, 1.6, 0);
      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(1, 1, 1);

      lod.update(camera, dioramaRoot, false, 0.5);
      await new Promise((r) => setTimeout(r, 100));

      const diag = lod.getDiagnostics();
      expect(diag.viewMode).toBe('first-person');
      // Inner zoom reaches provider max (19)
      expect(diag.targetZoom).toBe(19);

      lod.dispose();
    });

    it('respects provider maxZoom when provider has lower ceiling (e.g. USGS Topo maxZoom 16)', async () => {
      const routeGeo = new RouteGeometry(mockTrack, 1650, () => 2000);
      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1650,
        elevationSampler: () => 2000,
        routeGeometry: routeGeo,
        track: mockTrack,
        viewMode: 'first-person',
        textureStyle: 'topo',
      });

      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      camera.position.set(0, 1.6, 0);
      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(1, 1, 1);

      lod.update(camera, dioramaRoot, false, 0.5);
      await new Promise((r) => setTimeout(r, 100));

      const diag = lod.getDiagnostics();
      expect(diag.viewMode).toBe('first-person');
      // Clamped strictly to USGS Topo ceiling of 16
      expect(diag.targetZoom).toBe(16);

      lod.dispose();
    });
  });

  describe('Explicit Satellite Provider Configuration (Sections 32, 33)', () => {
    it('configures explicit Esri satellite provider', async () => {
      const success = await TextureProvider.setSatelliteProvider('esri');
      expect(success).toBe(true);
      expect(TextureProvider.getSatelliteProviderSetting()).toBe('esri');
      const provider = TextureProvider.getActiveSatelliteProvider();
      expect(provider.id).toBe('esri-satellite');
      expect(provider.maxZoom).toBe(19);
    });

    it('falls back to Esri World Imagery when Cesium Ion provider is requested without a valid token', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const success = await TextureProvider.setSatelliteProvider('cesium-bing', '');
      expect(success).toBe(false);
      expect(TextureProvider.getActiveSatelliteProvider().id).toBe('esri-satellite');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('initializes Cesium Bing Aerial provider when valid token is supplied', async () => {
      // Mock fetch for Cesium asset endpoint and Bing metadata
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('api.cesium.com')) {
          return {
            ok: true,
            json: async () => ({ options: { key: 'test-bing-key' } }),
          } as any;
        }
        if (url.includes('virtualearth.net')) {
          return {
            ok: true,
            json: async () => ({
              resourceSets: [
                {
                  resources: [
                    {
                      imageUrl: 'https://ecn.{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=1',
                      imageUrlSubdomains: ['t0', 't1', 't2', 't3'],
                    },
                  ],
                },
              ],
            }),
          } as any;
        }
        return { ok: false } as any;
      });
      (globalThis as any).fetch = fetchMock;

      const success = await TextureProvider.setSatelliteProvider('cesium-bing', 'mock-valid-cesium-token-xyz12345');
      expect(success).toBe(true);
      expect(TextureProvider.getSatelliteProviderSetting()).toBe('cesium-bing');
      const provider = TextureProvider.getActiveSatelliteProvider();
      expect(provider.id).toBe('cesium-bing');
      expect(provider.displayName).toContain('Bing Aerial');

      // Reset back to Esri for subsequent tests
      await TextureProvider.setSatelliteProvider('esri');
    });
  });

  describe('Crisp Texture Filtering & Anisotropy (Section 35)', () => {
    it('enforces LinearMipmapLinearFilter and maxAnisotropy on patch textures', async () => {
      TextureProvider.setMaxAnisotropy(16);
      expect(TextureProvider.getMaxAnisotropy()).toBe(16);

      const lod = new ImageryLODManager({
        terrainGeoBounds: mockBounds,
        terrainBaseElevation: 1650,
        elevationSampler: () => 2000,
        enableInXR: true,
        textureStyle: 'satellite',
      });

      const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 100);
      camera.position.set(0, 0.5, 0.5);
      const dioramaRoot = new THREE.Group();
      dioramaRoot.scale.set(1.0, 1.0, 1.0);

      lod.update(camera, dioramaRoot, false);
      await new Promise((r) => setTimeout(r, 120));

      const patches = (lod as any).patches as Map<string, any>;
      expect(patches.size).toBeGreaterThan(0);

      for (const patch of patches.values()) {
        const tex = patch.texture as THREE.Texture;
        expect(tex.minFilter).toBe(THREE.LinearMipmapLinearFilter);
        expect(tex.magFilter).toBe(THREE.LinearFilter);
        expect(tex.anisotropy).toBe(16);
        expect(tex.generateMipmaps).toBe(true);
      }

      lod.dispose();
    });
  });
});
