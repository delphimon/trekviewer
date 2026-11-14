import { afterEach, expect, it, vi } from 'vitest';
import { CesiumBingImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('sends the ion token in an Authorization header, never in the endpoint URL', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('api.cesium.com')) return { ok: true, json: async () => ({ options: { key: 'bing-key' } }) };
    return { ok: true, json: async () => ({ resourceSets: [{ resources: [{ imageUrl: 'https://ecn.{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg', imageUrlSubdomains: ['t0'] }] }] }) };
  }));
  const provider = new CesiumBingImageryProvider('test-ion-token');
  expect(await provider.init()).toBe(true);
  const ion = calls.find(call => call.url.includes('api.cesium.com'))!;
  expect(ion.url).not.toContain('test-ion-token');
  expect(ion.url).not.toContain('access_token');
  expect(new Headers(ion.init?.headers).get('Authorization')).toBe('Bearer test-ion-token');
});
