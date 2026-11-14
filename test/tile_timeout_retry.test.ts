import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { OfflineStore } from '../src/offline/OfflineStore.ts';
import { PersistentResourceCache } from '../src/terrain/PersistentResourceCache.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

const url = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox=1,2,3,4&size=256,256';
const provider: ImageryProvider = { id: 'timeout-test', displayName: 'test', attribution: '', maxZoom: 19, getTileUrls: () => [url] };

beforeEach(() => {
  vi.useFakeTimers();
  TileImageCache.clear();
  vi.stubGlobal('Image', class {});
  vi.spyOn(OfflineStore, 'available').mockReturnValue(true);
  vi.spyOn(PersistentResourceCache, 'read').mockResolvedValue(null);
  // A request that never answers; it only ends when its signal aborts.
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  })));
});
afterEach(() => { TileImageCache.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('negative-caches a timed-out tile for 15 s, not the 60 s used for hard failures', async () => {
  const result = TileImageCache.loadTile(provider, 15, 1, 2, 4500).catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(4600);
  expect(((await result) as Error).message).toMatch(/timeout/i);
  const delay = TileImageCache.getRetryDelayMs(provider.id, 15, 1, 2);
  expect(delay).toBeGreaterThan(14000);
  expect(delay).toBeLessThanOrEqual(15000);
});

it('keeps a caller abort an abort rather than a timeout', async () => {
  const controller = new AbortController();
  const result = TileImageCache.loadTile(provider, 15, 3, 4, 4500, controller.signal).catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  await vi.advanceTimersByTimeAsync(10);
  expect(((await result) as Error).message).not.toMatch(/timeout/i);
  expect(TileImageCache.getRetryDelayMs(provider.id, 15, 3, 4)).toBe(0);
});
