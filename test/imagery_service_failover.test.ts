import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

const image = { width: 1024, height: 1024 } as HTMLImageElement;
const draw = vi.fn();
const provider: ImageryProvider = {
  id: 'service-failover', displayName: 'test', attribution: '', maxZoom: 19,
  getTileUrls: (_z, x) => [
    `https://imagery.test/preferred/exportImage?bbox=${x}`,
    `https://imagery.test/mirror/exportImage?bbox=${x}`,
  ],
  getTileImageRegion: () => ({ x: 0, y: 0, width: 256, height: 256 }),
};
const load = (x: number, y = 0) => TileImageCache.loadTile(provider, 19, x, y);

beforeEach(() => {
  TileImageCache.clear();
  draw.mockReset();
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, dataset: {}, getContext: () => ({ drawImage: draw }) }) });
});
afterEach(() => { TileImageCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not repeat a service timeout for every geographic export and probes the preferred service after cooldown', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const network = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout')
    .mockRejectedValueOnce(new Error('Timeout loading tile')).mockResolvedValue(image);
  await load(0);
  await load(1);
  expect(network.mock.calls.map(c => c[0])).toEqual([
    provider.getTileUrls(19, 0, 0)[0], provider.getTileUrls(19, 0, 0)[1], provider.getTileUrls(19, 1, 0)[1],
  ]);
  now += 5 * 60_000 + 1;
  await load(2);
  expect(network.mock.calls.at(-1)?.[0]).toBe(provider.getTileUrls(19, 2, 0)[0]);
});

it('uses an already decoded preferred raster during an outage instead of downloading an alternate', async () => {
  const preferred = { width: 1024, height: 1024 } as HTMLImageElement;
  const network = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout')
    .mockResolvedValueOnce(preferred).mockRejectedValueOnce(new Error('Timeout')).mockResolvedValue(image);
  await load(0);
  await load(1);
  await load(0, 1);
  expect(network).toHaveBeenCalledTimes(3);
  expect(draw.mock.calls.at(-1)?.[0]).toBe(preferred);
});

it('does not classify incomplete geographic coverage as an outage of the whole service', async () => {
  const network = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockResolvedValue(image);
  const covered = { ...provider, isTileUsable: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) };
  await TileImageCache.loadTile(covered, 19, 0, 0);
  await TileImageCache.loadTile(covered, 19, 1, 0);
  expect(network.mock.calls.map(c => c[0])).toEqual([
    provider.getTileUrls(19, 0, 0)[0], provider.getTileUrls(19, 0, 0)[1], provider.getTileUrls(19, 1, 0)[0],
  ]);
});

it('still tries a cooling service when the other configured source also fails', async () => {
  const network = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout')
    .mockResolvedValue(image).mockRejectedValueOnce(new Error('Timeout'));
  await load(0);
  network.mockRejectedValueOnce(new Error('Mirror unavailable')).mockResolvedValueOnce(image);
  await load(1);
  expect(network.mock.calls.map(c => c[0])).toEqual([
    provider.getTileUrls(19, 0, 0)[0], provider.getTileUrls(19, 0, 0)[1],
    provider.getTileUrls(19, 1, 0)[1], provider.getTileUrls(19, 1, 0)[0],
  ]);
  await load(2);
  expect(network.mock.calls.at(-1)?.[0]).toBe(provider.getTileUrls(19, 2, 0)[0]);
});

it('ignores a stale service failure after cache clear', async () => {
  let fail!: (error: Error) => void;
  const network = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout')
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValue(image);
  const stale = load(0);
  TileImageCache.clear();
  fail(new Error('old timeout'));
  await stale;
  await load(1);
  expect(network.mock.calls.at(-1)?.[0]).toBe(provider.getTileUrls(19, 1, 0)[0]);
});
