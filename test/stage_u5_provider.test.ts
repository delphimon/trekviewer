import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { CesiumBingImageryProvider, EsriWorldImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

describe('Stage U5: Provider Diagnostics, Explicit Awaited Init, and Truthful Sources', () => {
  let origFetch: any;
  let origImage: any;
  let origProcessEnv: any;

  beforeEach(() => {
    origFetch = (globalThis as any).fetch;
    origImage = (globalThis as any).Image;
    origProcessEnv = { ...(globalThis as any).process?.env };

    TileImageCache.clear();
    TextureProvider.resetForTesting();
  });

  afterEach(() => {
    (globalThis as any).fetch = origFetch;
    (globalThis as any).Image = origImage;
    if ((globalThis as any).process) {
      (globalThis as any).process.env = origProcessEnv;
    }
    TileImageCache.clear();
    TextureProvider.resetForTesting();
    vi.restoreAllMocks();
  });

  describe('Section 64: Provider Initialization Test (Delayed metadata initialization gate)', () => {
    it('gates route imagery fetching until provider initialization settles and uses only chosen provider', async () => {
      // 1. Mock delayed Cesium metadata response
      let resolveCesiumAsset: (value: any) => void;
      const cesiumAssetPromise = new Promise((resolve) => {
        resolveCesiumAsset = resolve;
      });

      const requestedTileUrls: string[] = [];

      (globalThis as any).fetch = vi.fn(async (url: string) => {
        if (url.includes('api.cesium.com')) {
          await cesiumAssetPromise;
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

      // Mock Image loader to record tile requests
      (globalThis as any).Image = class {
        src = '';
        crossOrigin = '';
        onload: any = null;
        onerror: any = null;
        naturalWidth = 256;
        naturalHeight = 256;
        width = 256;
        height = 256;
        constructor() {
          setTimeout(() => {
            if (this.src) {
              requestedTileUrls.push(this.src);
              if (this.onload) this.onload();
            }
          }, 5);
        }
      };

      // Set environment to request Cesium Bing with a valid token
      (globalThis as any).process.env.VITE_SATELLITE_PROVIDER = 'cesium-bing';
      (globalThis as any).process.env.VITE_CESIUM_ION_TOKEN = 'test-valid-cesium-token-12345';

      // 2. Start provider initialization
      const initPromise = TextureProvider.initializeFromEnvironment();

      // Assert that before initialization settles, initialized is false and 0 tile requests have started
      const preState = TextureProvider.getProviderInitState();
      expect(preState.initialized).toBe(false);
      expect(preState.requestedProvider).toBe('cesium-bing');
      expect(requestedTileUrls.length).toBe(0);

      // 3. Resolve the delayed Cesium asset response
      resolveCesiumAsset!({ ok: true });
      const initSuccess = await initPromise;
      expect(initSuccess).toBe(true);

      // 4. Assert settled state
      const postState = TextureProvider.getProviderInitState();
      expect(postState.initialized).toBe(true);
      expect(postState.activeProvider).toBe('cesium-bing');
      expect(postState.fallbackReason).toBeUndefined();
      expect(postState.displayName).toContain('Bing Aerial');

      // 5. Fetch a satellite tile and verify it uses ONLY Bing URLs
      const provider = TextureProvider.getActiveSatelliteProvider();
      await TileImageCache.loadTile(provider, 15, 100, 200);

      expect(requestedTileUrls.length).toBeGreaterThan(0);
      for (const url of requestedTileUrls) {
        expect(url).toContain('virtualearth.net');
        expect(url).not.toContain('arcgisonline.com');
      }
    });
  });

  describe('Section 65: Provider Failure Test (Global fallback without mixed Bing/Esri layer)', () => {
    it('falls back to Esri globally before route loading when Cesium fails, preventing mixed layers', async () => {
      const requestedTileUrls: string[] = [];

      // 1. Mock Cesium fetch error (e.g. 500 server error)
      (globalThis as any).fetch = vi.fn(async (url: string) => {
        if (url.includes('api.cesium.com') || url.includes('virtualearth.net')) {
          return { ok: false, status: 500 } as any;
        }
        return { ok: false } as any;
      });

      (globalThis as any).Image = class {
        src = '';
        crossOrigin = '';
        onload: any = null;
        onerror: any = null;
        naturalWidth = 256;
        naturalHeight = 256;
        width = 256;
        height = 256;
        constructor() {
          setTimeout(() => {
            if (this.src) {
              requestedTileUrls.push(this.src);
              if (this.onload) this.onload();
            }
          }, 5);
        }
      };

      (globalThis as any).process.env.VITE_SATELLITE_PROVIDER = 'cesium-bing';
      (globalThis as any).process.env.VITE_CESIUM_ION_TOKEN = 'test-token-failing-12345';

      const success = await TextureProvider.initializeFromEnvironment();
      expect(success).toBe(false);

      const state = TextureProvider.getProviderInitState();
      expect(state.initialized).toBe(true);
      expect(state.requestedProvider).toBe('cesium-bing');
      expect(state.activeProvider).toBe('esri-satellite');
      expect(state.fallbackReason).toBe('Cesium unavailable');

      // 2. Fetch several tiles from the active satellite provider
      const provider = TextureProvider.getActiveSatelliteProvider();
      expect(provider.id).toBe('esri-satellite');

      await TileImageCache.loadTile(provider, 14, 50, 60);
      await TileImageCache.loadTile(provider, 14, 51, 60);
      await TileImageCache.loadTile(provider, 14, 52, 60);

      // 3. Verify all tile requests went strictly to Esri, 0 requests went to Bing
      expect(requestedTileUrls.length).toBe(3);
      for (const url of requestedTileUrls) {
        expect(url).toContain('server.arcgisonline.com');
        expect(url).not.toContain('virtualearth.net');
      }

      // Verify UI attribution reflects honest fallback
      const satAttr = TextureProvider.getAttributionForStyle('satellite');
      expect(satAttr).toBe('Esri World Imagery • up to Z19 (fallback: Cesium unavailable)');
    });
  });

  describe('Sections 50, 51, 71: Truthful Cache Keys & No Per-Tile Cross-Provider Fallback', () => {
    it('CesiumBingImageryProvider returns ONLY Bing URLs and never falls back to Esri per-tile', async () => {
      const provider = new CesiumBingImageryProvider('test-token');
      // Set mock metadata
      (provider as any).metadata = {
        urlTemplate: 'https://ecn.{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=1',
        subdomains: ['t0', 't1', 't2', 't3'],
      };

      const urls = provider.getTileUrls(15, 1322, 2883);
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain('virtualearth.net');
      expect(urls[0]).not.toContain('arcgisonline.com');

      // If metadata is null, returns empty array (zero Esri fallback)
      (provider as any).metadata = null;
      const emptyUrls = provider.getTileUrls(15, 1322, 2883);
      expect(emptyUrls).toEqual([]);
    });

    it('TileImageCache records failureCount and never caches Esri tiles under cesium-bing keys', async () => {
      const provider = new CesiumBingImageryProvider('test-token');
      (provider as any).metadata = {
        urlTemplate: 'https://ecn.{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=1',
        subdomains: ['t0'],
      };

      // Mock Image to simulate network 404 failure
      (globalThis as any).Image = class {
        src = '';
        crossOrigin = '';
        onload: any = null;
        onerror: any = null;
        constructor() {
          setTimeout(() => {
            if (this.onerror) {
              this.onerror(new Error('HTTP 404 Not Found'));
            }
          }, 5);
        }
      };

      const tileKey = TileImageCache.getTileKey(provider.id, 15, 10, 20);
      expect(tileKey).toBe('cesium-bing:15:10:20');

      await expect(TileImageCache.loadTile(provider, 15, 10, 20, 200)).rejects.toThrow();

      // Ensure cache is not populated with fraudulent data
      expect(TileImageCache.has(tileKey)).toBe(false);
      expect(TileImageCache.getFailureCount()).toBe(1);
      expect(TileImageCache.getStats().failureCount).toBe(1);
    });
  });

  describe('Sections 49 & 52: Full State Matrix & UI Attribution', () => {
    it('returns honest state and attribution for explicit esri', async () => {
      await TextureProvider.setSatelliteProvider('esri');
      const state = TextureProvider.getProviderInitState();
      expect(state.requestedProvider).toBe('esri');
      expect(state.activeProvider).toBe('esri-satellite');
      expect(state.fallbackReason).toBeUndefined();
      expect(state.initialized).toBe(true);

      expect(TextureProvider.getAttributionForStyle('satellite')).toBe('Esri World Imagery • up to Z19');
      expect(TextureProvider.getAttributionForStyle('topo')).toBe('USGS Topographic Map • up to Z16');
      expect(TextureProvider.getAttributionForStyle('hybrid')).toContain('Esri World Imagery • up to Z19 | Labels:');
    });

    it('returns honest state and attribution for auto mode without token', async () => {
      (globalThis as any).process.env.VITE_SATELLITE_PROVIDER = 'auto';
      delete (globalThis as any).process.env.VITE_CESIUM_ION_TOKEN;

      await TextureProvider.initializeFromEnvironment();
      const state = TextureProvider.getProviderInitState();
      expect(state.requestedProvider).toBe('auto');
      expect(state.activeProvider).toBe('esri-satellite');
      expect(state.fallbackReason).toBeUndefined();
      expect(TextureProvider.getAttributionForStyle('satellite')).toBe('Esri World Imagery • up to Z19');
    });

    it('returns honest state and attribution for cesium-bing with missing token', async () => {
      (globalThis as any).process.env.VITE_SATELLITE_PROVIDER = 'cesium-bing';
      delete (globalThis as any).process.env.VITE_CESIUM_ION_TOKEN;

      const success = await TextureProvider.initializeFromEnvironment();
      expect(success).toBe(false);

      const state = TextureProvider.getProviderInitState();
      expect(state.requestedProvider).toBe('cesium-bing');
      expect(state.activeProvider).toBe('esri-satellite');
      expect(state.fallbackReason).toBe('Missing or invalid Cesium ion token');
      expect(TextureProvider.getAttributionForStyle('satellite')).toBe(
        'Esri World Imagery • up to Z19 (fallback: Missing or invalid Cesium ion token)'
      );
    });
  });
});
