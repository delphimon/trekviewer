import { afterEach, expect, it, vi } from 'vitest';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); TextureProvider.resetForTesting(); });

it('selects an explicit private Bing launch without copying its token into diagnostics', async () => {
  const token = 'private-fixture-token-123456';
  vi.stubGlobal('__TREK_VIEWER_PROVIDERS__', { provider: 'cesium-bing', ionToken: ` ${token} ` });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ options: { key: 'fixture-key' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resourceSets: [{ resources: [{
      imageUrl: 'https://{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg', imageUrlSubdomains: ['t0'],
    }] }] })));
  vi.stubGlobal('fetch', fetch);
  expect(TextureProvider.getEnvProviderSetting()).toBe('cesium-bing');
  expect(TextureProvider.getEnvToken()).toBe(token);
  expect(await TextureProvider.initializeFromEnvironment()).toBe(true);
  expect(TextureProvider.getProviderInitState()).toMatchObject({ requestedProvider: 'cesium-bing', activeProvider: 'cesium-bing', initialized: true });
  expect(JSON.stringify(TextureProvider.getProviderInitState())).not.toContain(token);
  // The bootstrap can be removed after initialization; the active provider
  // retains its metadata for this session without persisting credentials.
  vi.stubGlobal('__TREK_VIEWER_PROVIDERS__', undefined);
  expect(await TextureProvider.initializeFromEnvironment()).toBe(true);
  expect(TextureProvider.getActiveSatelliteProvider().id).toBe('cesium-bing');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not let an unselected runtime token opt the public default into an account provider', async () => {
  vi.stubGlobal('__TREK_VIEWER_PROVIDERS__', { ionToken: 'private-unselected-token' });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await TextureProvider.initializeFromEnvironment()).toBe(true);
  expect(TextureProvider.getActiveSatelliteProvider().id).toBe('public-naip');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([{ label: 'empty', token: '' }, { label: 'short', token: 'short' }, { label: 'oversized', token: 'x'.repeat(8193) }])('falls back safely for an invalid $label private launch token', async ({ token }) => {
  vi.stubGlobal('__TREK_VIEWER_PROVIDERS__', { provider: 'cesium-bing', ionToken: token });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await TextureProvider.initializeFromEnvironment()).toBe(false);
  expect(TextureProvider.getProviderInitState()).toMatchObject({ activeProvider: 'public-naip', fallbackReason: 'Missing or invalid Cesium ion token' });
  expect(fetch).not.toHaveBeenCalled();
});
