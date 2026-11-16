import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { PersistentResourceCache } from '../src/terrain/PersistentResourceCache.ts';
import type { ImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

// Quest profile: decoding shared 1024 px export rasters on the main thread (an <img> re-decoded
// for every crop) and reading back GPU-backed crop canvases held first-person loading at ~15 Hz.
const RASTER = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox=0';
const provider: ImageryProvider = {
  id: 'raster-decode', displayName: 'test', attribution: '', maxZoom: 19,
  getTileUrls: () => [RASTER],
  getTileImageRegion: (_z, x, y) => ({ x: (x % 4) * 256, y: (y % 4) * 256, width: 256, height: 256 }),
  getTileRequestGroup: () => 'one-raster',
};
const draw = vi.fn();
const contextOptions: unknown[] = [];

beforeEach(() => {
  TileImageCache.clear();
  draw.mockReset(); contextOptions.length = 0;
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, dataset: {}, getContext: (_type: string, options?: unknown) => {
    contextOptions.push(options); return { drawImage: draw };
  } }) });
});
afterEach(() => { TileImageCache.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('decodes a shared raster blob once with createImageBitmap and crops tiles into CPU-backed canvases', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  const bitmap = { width: 1024, height: 1024 };
  vi.spyOn(PersistentResourceCache, 'isEnabled').mockReturnValue(true);
  const read = vi.spyOn(PersistentResourceCache, 'read').mockResolvedValue(blob);
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal('createImageBitmap', decode);

  await TileImageCache.loadTile(provider, 19, 0, 0);
  await TileImageCache.loadTile(provider, 19, 1, 0);

  expect(read).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledTimes(1);
  expect(decode).toHaveBeenCalledWith(blob);
  expect(draw.mock.calls.map(c => c[0])).toEqual([bitmap, bitmap]);
  expect(draw.mock.calls[1].slice(1, 5)).toEqual([256, 0, 256, 256]);
  expect(contextOptions).toEqual([{ willReadFrequently: true }, { willReadFrequently: true }]);
});

it('drops a cached raster that fails to decode and fetches it again', async () => {
  const stale = new Blob(['bad']), fresh = new Blob(['png']);
  vi.spyOn(PersistentResourceCache, 'isEnabled').mockReturnValue(true);
  vi.spyOn(PersistentResourceCache, 'read').mockResolvedValue(stale);
  const remove = vi.spyOn(PersistentResourceCache, 'remove').mockResolvedValue();
  vi.spyOn(PersistentResourceCache, 'write').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fresh)));
  const decode = vi.fn().mockRejectedValueOnce(new Error('corrupt')).mockResolvedValue({ width: 1024, height: 1024 });
  vi.stubGlobal('createImageBitmap', decode);

  await TileImageCache.loadTile(provider, 19, 0, 0);

  expect(remove).toHaveBeenCalledWith(RASTER, stale);
  expect(decode).toHaveBeenCalledTimes(2);
  expect(draw).toHaveBeenCalledTimes(1);
});
