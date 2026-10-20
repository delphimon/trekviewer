import { afterEach, expect, it, vi } from 'vitest';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { PersistentResourceCache } from '../src/terrain/PersistentResourceCache.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

const image = { width: 1024, height: 1024 } as HTMLImageElement;
const provider: ImageryProvider = { id: 'cancellation', displayName: 'fixture', attribution: '', maxZoom: 19,
  getTileUrls: (_z, x) => [`https://imagery.test/primary/${x}`, `https://imagery.test/secondary/${x}`] };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function network() {
  const requests: { signal: AbortSignal; resolve: (image: HTMLImageElement) => void; reject: (error: Error) => void }[] = [];
  const load = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockImplementation((_url, _timeout, signal: any) =>
    new Promise((resolve, reject) => requests.push({ signal, resolve, reject })));
  return { requests, load };
}
afterEach(() => { TileImageCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps a shared tile download alive for its remaining consumer, including one without a signal', async () => {
  const { requests, load } = network(), abort = new AbortController();
  const first = TileImageCache.loadTile(provider, 19, 0, 0, 4500, abort.signal);
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = TileImageCache.loadTile(provider, 19, 0, 0);
  await flush(); expect(load).toHaveBeenCalledTimes(1);
  abort.abort(); await cancelled;
  expect(requests[0].signal.aborted).toBe(false);
  requests[0].resolve(image);
  expect(await second).toBe(image);
  expect(await TileImageCache.loadTile(provider, 19, 0, 0)).toBe(image);
  expect(load).toHaveBeenCalledTimes(1);
});

it('cancels an abandoned transfer, permits immediate retry and ignores the old completion', async () => {
  const { requests, load } = network(), abort = new AbortController();
  const first = TileImageCache.loadTile(provider, 19, 1, 0, 4500, abort.signal);
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); abort.abort(); await cancelled;
  expect(requests[0].signal.aborted).toBe(true);
  expect(TileImageCache.getInFlightCount()).toBe(0);
  const retry = TileImageCache.loadTile(provider, 19, 1, 0);
  await flush(); expect(load).toHaveBeenCalledTimes(2);
  requests[0].resolve(image); await flush();
  expect(TileImageCache.getInFlightCount()).toBe(1);
  expect(TileImageCache.size()).toBe(0);
  requests[1].resolve(image); expect(await retry).toBe(image);
  expect(TileImageCache.getFailureCount()).toBe(0);
});

it('shares an export across different tiles and cancels it only after its last tile leaves', async () => {
  const { requests, load } = network();
  const shared = { ...provider, getTileUrls: () => ['https://imagery.test/export'],
    getTileImageRegion: (_z: number, x: number) => ({ x: x * 256, y: 0, width: 256, height: 256 }) };
  const a = new AbortController(), b = new AbortController();
  const first = TileImageCache.loadTile(shared, 19, 0, 0, 4500, a.signal);
  const second = TileImageCache.loadTile(shared, 19, 1, 0, 4500, b.signal);
  const rejected = Promise.all([expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(second).rejects.toMatchObject({ name: 'AbortError' })]);
  await flush(); expect(load).toHaveBeenCalledTimes(1);
  a.abort(); expect(requests[0].signal.aborted).toBe(false);
  b.abort(); expect(requests[0].signal.aborted).toBe(true);
  await rejected;
  requests[0].reject(Error('late abort')); await flush();
  expect(TileImageCache.getFailureCount()).toBe(0);
  expect((TileImageCache as any).rasterServiceFailures.size).toBe(0);
  expect((TileImageCache as any).rasterFailures.size).toBe(0);
});

it('preserves an export needed by another tile and crops its original pixels', async () => {
  const { requests, load } = network(), draw = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, dataset: {}, getContext: () => ({ drawImage: draw }) }) });
  const shared = { ...provider, getTileUrls: () => ['https://imagery.test/export'],
    getTileImageRegion: (_z: number, x: number) => ({ x: x * 256, y: 0, width: 256, height: 256 }) };
  const abort = new AbortController();
  const first = TileImageCache.loadTile(shared, 19, 0, 0, 4500, abort.signal);
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = TileImageCache.loadTile(shared, 19, 1, 0);
  await flush(); abort.abort(); await rejected;
  expect(requests[0].signal.aborted).toBe(false);
  requests[0].resolve(image); await second;
  expect(draw).toHaveBeenCalledExactlyOnceWith(image, 256, 0, 256, 256, 0, 0, 256, 256);
  expect(load).toHaveBeenCalledTimes(1);
});

it('does not try mirrors or negative-cache an intentionally abandoned request', async () => {
  const { requests, load } = network(), abort = new AbortController();
  const request = TileImageCache.loadTile(provider, 19, 2, 0, 4500, abort.signal);
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); abort.abort(); await rejected;
  requests[0].reject(Error('old timeout')); await flush();
  expect(load).toHaveBeenCalledTimes(1);
  expect(TileImageCache.getStats()).toMatchObject({ negativeCacheSize: 0, failureCount: 0 });
});

it.each(['success', 'failure'] as const)('clearing the cache aborts transfers and ignores a stale %s', async outcome => {
  const { requests } = network();
  const pending = TileImageCache.loadTile(provider, 19, 3, 0);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await flush(); TileImageCache.clear();
  expect(requests[0].signal.aborted).toBe(true);
  if (outcome === 'success') requests[0].resolve(image);
  else requests[0].reject(Error('late network failure'));
  await rejected;
  expect(TileImageCache.getStats()).toMatchObject({ entries: 0, inFlight: 0, failureCount: 0 });
});

it('retains valid persisted bytes when their image decode is cancelled', async () => {
  vi.spyOn(PersistentResourceCache, 'read').mockResolvedValue(new Blob(['cached original bytes']));
  const remove = vi.spyOn(PersistentResourceCache, 'remove');
  vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockImplementation((_url, _timeout, signal: any) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('Image load aborted')), { once: true })));
  const abort = new AbortController();
  const request = (TileImageCache as any).loadPersistedImage('https://imagery.test/cached', 4500, abort.signal);
  const rejected = expect(request).rejects.toThrow('aborted');
  await flush(); abort.abort(); await rejected;
  expect(remove).not.toHaveBeenCalled();
});
