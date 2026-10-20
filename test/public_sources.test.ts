import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as Lerc from 'lerc';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { PublicImageryProvider, NAIP_SERVICE, NAIP_PLUS_SERVICE, USGS_IMAGERY_SERVICE, USGSReferenceProvider, tileMercatorBounds } from '../src/terrain/providers/PublicImageryProvider.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
import { USGSTopoProvider } from '../src/terrain/providers/ImageryProvider.ts';
import { elevationRasterRequest, fetchBestAvailableElevation, clearBestElevationFailures, hasUSGSElevationCoverage } from '../src/terrain/BestAvailableElevation.ts';
import { decodeLercElevation } from '../src/terrain/LercElevation.ts';
import { ElevationTileService, type ElevationGrid } from '../src/terrain/ElevationTiles.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import fixture from './fixtures/elevation/rainier-3dep.json';
import { PersistentResourceCache } from '../src/terrain/PersistentResourceCache.ts';

vi.mock('../src/terrain/TerrainJobs.ts', () => ({ runTerrainJob: (_job: unknown, fallback: () => unknown) => fallback() }));
const fixtureBytes = () => {
  const bytes = readFileSync('test/fixtures/elevation/rainier-3dep.lerc');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  await Lerc.load({ locateFile: () => require.resolve('lerc/lerc-wasm.wasm') });
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); TextureProvider.resetForTesting();
  ElevationTileService.setBestAvailableEnabled(false); clearBestElevationFailures();
  TileImageCache.clear(); TileImageCache.setLimits(1024, 256 * 1024 * 1024);
});

describe('no-paid-license source policy', () => {
  it('uses public sources even if an auto-mode token is present; commercial providers require explicit opt-in', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await TextureProvider.setSatelliteProvider('auto', 'otherwise-valid-token-123456');
    expect(TextureProvider.getActiveSatelliteProvider()).toBeInstanceOf(PublicImageryProvider);
    expect(fetch).not.toHaveBeenCalled();
    expect(TextureProvider.getReferenceOverlayProvider()).toBeInstanceOf(USGSReferenceProvider);
    expect(TextureProvider.getAttributionForStyle('hybrid')).toContain('CC BY-NC-SA 4.0');
  });

  it('requests lossless natural-colour imagery at exact XYZ bounds without upscaled overview fallback for fine tiles', () => {
    const provider = new PublicImageryProvider();
    const tile = latLonToTile(46.852, -121.76, 19);
    const urls = provider.getTileUrls(19, tile.x, tile.y);
    expect(urls).toHaveLength(3);
    const url = new URL(urls[0]); expect(urls[0]).toContain(NAIP_PLUS_SERVICE);
    expect(urls[1]).toContain('imagery.geoplatform.gov');
    expect(urls[2]).toContain(NAIP_SERVICE);
    expect(url.searchParams.get('format')).toBe('png32');
    expect(JSON.parse(url.searchParams.get('renderingRule')!)).toEqual({ rasterFunction: 'NaturalColor' });
    expect(url.searchParams.get('bbox')!.split(',').map(Number)).toEqual(tileMercatorBounds(17, Math.floor(tile.x / 4), Math.floor(tile.y / 4)));
    expect(url.searchParams.get('size')).toBe('1024,1024');
    expect(provider.getTileImageRegion(19, tile.x, tile.y)).toEqual({ x: tile.x % 4 * 256, y: tile.y % 4 * 256, width: 256, height: 256 });
    const overview = latLonToTile(46.852, -121.76, 15);
    expect(provider.getTileUrls(15, overview.x, overview.y)[0]).toContain(USGS_IMAGERY_SERVICE);
  });

  it('uses 10 m global Sentinel imagery with row/column ordering and an appropriate zoom cap outside CONUS', () => {
    const provider = new PublicImageryProvider();
    const tile = latLonToTile(27.98, 86.92, 15);
    expect(provider.getMaxZoomForLocation(27.98, 86.92)).toBe(15);
    expect(provider.getTileUrls(15, tile.x, tile.y)).toEqual([
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/15/${tile.y}/${tile.x}.jpg`,
    ]);
    expect(provider.getTileUrls(19, tile.x * 16, tile.y * 16)).toEqual([]);
    expect(provider.attribution).toContain('EOX IT Services GmbH');
    expect(provider.attribution).toContain('2025');
  });

  it('does not fall through from public topo or labels to a separately licensed commercial service', () => {
    expect(new USGSTopoProvider().getTileUrls(15, 5384, 11540)).toHaveLength(1);
    const urls = new USGSReferenceProvider().getTileUrls(19, 86200, 184000);
    expect(urls.every(url => new URL(url).hostname.endsWith('.nationalmap.gov'))).toBe(true);
  });

  it('rejects transparent / partial NAIP coverage and releases the validation canvas', () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }) }) };
    vi.stubGlobal('document', { createElement: () => canvas });
    expect(new PublicImageryProvider().isTileUsable({} as HTMLImageElement, NAIP_SERVICE)).toBe(false);
    expect(canvas.width).toBe(1); expect(canvas.height).toBe(1);
  });

  it('shares one exact-resolution raster across sixteen tiles and counts both source and crop memory', async () => {
    const draws: unknown[][] = [];
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, dataset: {}, getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }) }) });
    const image = { width: 1024, height: 1024 } as HTMLImageElement;
    const load = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockResolvedValue(image);
    const provider = { id: 'grouped-test', displayName: 'test', attribution: 'test', maxZoom: 19, getTileUrls: () => ['https://example.test/raster.png'],
      getTileImageRegion: (_z: number, x: number, y: number) => ({ x: x % 4 * 256, y: y % 4 * 256, width: 256, height: 256 }) };
    const images = await Promise.all(Array.from({ length: 16 }, (_, i) => TileImageCache.loadTile(provider, 19, i % 4, Math.floor(i / 4))));
    expect(load).toHaveBeenCalledTimes(1); expect(new Set(images).size).toBe(16);
    expect(draws).toHaveLength(16);
    for (let i = 0; i < 16; i++) expect(draws[i]).toEqual([image, i % 4 * 256, Math.floor(i / 4) * 256, 256, 256, 0, 0, 256, 256]);
    expect(TileImageCache.getStats().decodedBytes).toBe(8 * 1024 * 1024);
    TileImageCache.setLimits(2, 2 * 256 * 256 * 4);
    expect(TileImageCache.size()).toBe(2);
    expect(TileImageCache.getEstimatedDecodedBytes()).toBe(2 * 256 * 256 * 4);
    // Eviction releases ownership without shrinking images still used by a texture.
    expect(images.every(img => img.width === 256 && img.height === 256)).toBe(true);
  });

  it('backs off failed shared rasters across different tile keys and never restores them after a cache clear', async () => {
    const provider = { id: 'grouped-failure', displayName: 'test', attribution: '', maxZoom: 19, getTileUrls: () => ['https://example.test/failure.png'],
      getTileImageRegion: () => ({ x: 0, y: 0, width: 256, height: 256 }) };
    const load = vi.spyOn(TileImageCache as any, 'loadImageWithTimeout').mockRejectedValue(new Error('temporary source failure'));
    await expect(TileImageCache.loadTile(provider, 19, 1, 1)).rejects.toThrow();
    await expect(TileImageCache.loadTile(provider, 19, 2, 1)).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
    let reject!: (e: Error) => void;
    load.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    TileImageCache.clear(); const pending = TileImageCache.loadTile(provider, 19, 3, 1);
    TileImageCache.clear(); reject(new Error('stale failure'));
    await expect(pending).rejects.toThrow();
    expect((TileImageCache as any).rasterFailures.size).toBe(0);
    expect(TileImageCache.getEstimatedDecodedBytes()).toBe(0);
  });
});

describe('best available public-domain elevation', () => {
  it('requests raw F32 heights, zero-loss LERC and the service Best mosaic, bounded independently of area', () => {
    const request = elevationRasterRequest(fixture.bounds, 1, 64);
    // Keep the original capture's URL intact: its bytes were recorded before
    // the explicit footprint-preservation parameter was added.
    expect(request).toEqual({ ...fixture.request, url: fixture.request.url + '&adjustAspectRatio=false' });
    const url = new URL(request.url);
    expect(url.searchParams.get('compressionTolerance')).toBe('0');
    expect(url.searchParams.get('adjustAspectRatio')).toBe('false');
    expect(JSON.parse(url.searchParams.get('renderingRule')!)).toEqual({ rasterFunction: 'None' });
    expect(JSON.parse(url.searchParams.get('mosaicRule')!).sortField).toBe('Best');
    const huge = elevationRasterRequest({ minLat: 25, maxLat: 49, minLon: -124, maxLon: -67 }, 1);
    expect(huge.width * huge.height).toBeLessThanOrEqual(1024 * 1024);
    expect(() => elevationRasterRequest(fixture.bounds, 1, 100000)).toThrow(RangeError);
    expect(hasUSGSElevationCoverage(fixture.bounds)).toBe(true);
    expect(hasUSGSElevationCoverage({ minLat: 46, maxLat: 47, minLon: 9, maxLon: 10 })).toBe(false);
  });

  it('decodes a real lossless summit raster with its full floating-point range and rejects dimensions before allocation', async () => {
    const input = { buffer: fixtureBytes(), width: fixture.request.width, height: fixture.request.height };
    const decoded = await decodeLercElevation(input);
    expect(decoded.validCount).toBe(input.width * input.height);
    expect(decoded.min).toBe(fixture.info.minValue); expect(decoded.max).toBe(fixture.info.maxValue);
    expect(decoded.min).toBeGreaterThan(4300); // A height raster, not an 8-bit shaded image.
    expect(fixture.info.maxZerror).toBe(0);
    await expect(decodeLercElevation({ ...input, width: 2049, height: 2049 })).rejects.toThrow(RangeError);
    await expect(decodeLercElevation({ ...input, width: input.width - 1 })).rejects.toThrow(RangeError);
  });

  it('publishes complete real coverage with truthful sampling metadata and keeps aborted requests out of fallback', async () => {
    const fetch = vi.fn(async () => new Response(fixtureBytes())); vi.stubGlobal('fetch', fetch);
    const grid = await fetchBestAvailableElevation(fixture.bounds, 1);
    expect(grid?.source).toContain('USGS 3DEP'); expect(grid?.rasterBounds).toEqual(fixture.request.rasterBounds);
    expect(grid?.sampleSpacingMeters).toBeCloseTo(1, 1);
    expect(grid?.data.length).toBe(fixture.request.width * fixture.request.height);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(fetchBestAvailableElevation(fixture.bounds, 1, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honours LERC NoData masks instead of treating masked heights as genuine terrain', async () => {
    const original = Lerc.decode(fixtureBytes());
    vi.spyOn(Lerc, 'decode').mockReturnValue({ ...original, mask: new Uint8Array(original.width * original.height) });
    const decoded = await decodeLercElevation({ buffer: fixtureBytes(), width: original.width, height: original.height });
    expect(decoded.validCount).toBe(0); expect(decoded.data.every(Number.isNaN)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixtureBytes())));
    expect(await fetchBestAvailableElevation(fixture.bounds, 1)).toBeNull();
  });

  it('reuses exact persisted LERC bytes and refetches a corrupt cached raster before publishing', async () => {
    const fetch = vi.fn(async () => new Response(fixtureBytes())); vi.stubGlobal('fetch', fetch);
    const read = vi.spyOn(PersistentResourceCache, 'read').mockResolvedValueOnce(new Blob([fixtureBytes()]));
    const grid = await fetchBestAvailableElevation(fixture.bounds, 1);
    expect(fetch).not.toHaveBeenCalled();
    expect(grid?.data.length).toBe(fixture.request.width * fixture.request.height);
    const remove = vi.spyOn(PersistentResourceCache, 'remove').mockResolvedValue();
    const write = vi.spyOn(PersistentResourceCache, 'write');
    read.mockResolvedValueOnce(new Blob(['invalid lerc'])).mockResolvedValue(null);
    const recovered = await fetchBestAvailableElevation(fixture.bounds, 1);
    expect(remove).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce();
    expect(recovered?.data).toEqual(grid?.data);
  });

  it('backs off failed or malformed responses and skips US-only requests for overseas tracks', async () => {
    const fetch = vi.fn(async () => new Response('<html>upstream unavailable</html>')); vi.stubGlobal('fetch', fetch);
    expect(await fetchBestAvailableElevation(fixture.bounds, 1)).toBeNull();
    expect(await fetchBestAvailableElevation(fixture.bounds, 1)).toBeNull();
    expect(await fetchBestAvailableElevation({ minLat: 46, maxLat: 47, minLon: 9, maxLon: 10 }, 1)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches corrected footprints under a new cache key while retaining legacy cached bytes', async () => {
    const originalURL = fixture.request.url;
    const read = vi.spyOn(PersistentResourceCache, 'read').mockImplementation(async url =>
      url === originalURL ? new Blob([fixtureBytes()]) : null);
    const remove = vi.spyOn(PersistentResourceCache, 'remove');
    const write = vi.spyOn(PersistentResourceCache, 'write');
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(fixtureBytes())); vi.stubGlobal('fetch', fetch);
    const grid = await fetchBestAvailableElevation(fixture.bounds, 1);
    expect(grid?.isRealDEM).toBe(true);
    expect(read).toHaveBeenCalledExactlyOnceWith(originalURL + '&adjustAspectRatio=false');
    expect(fetch.mock.calls[0]?.[0]).toBe(originalURL + '&adjustAspectRatio=false');
    expect(write.mock.calls[0]?.[0]).toBe(originalURL + '&adjustAspectRatio=false');
    expect(remove).not.toHaveBeenCalled();
  });

  it('samples floating-point rasters using sample centres and preserves legacy XYZ sampling', () => {
    const rasterBounds = fixture.request.rasterBounds;
    const grid: ElevationGrid = { width: 3, height: 3, data: new Float32Array([0, 1, 2, 10, 11, 12, 20, 21, 22]),
      tileXMin: 0, tileXMax: 0, tileYMin: 0, tileYMax: 0, numTilesX: 1, numTilesY: 1, zoom: 0,
      tileValidity: new Uint8Array([1]), minElevation: 0, maxElevation: 22, isRealDEM: true, rasterBounds };
    const x = (rasterBounds.west + rasterBounds.east) / 2, y = (rasterBounds.north + rasterBounds.south) / 2;
    const lon = x * 180 / (Math.PI * 6378137), lat = Math.atan(Math.sinh(y / 6378137)) * 180 / Math.PI;
    const sample = ElevationTileService.sampleElevation(grid, lat, lon);
    expect(sample.isValid).toBe(true); expect(sample.elevation).toBeCloseTo(11, 6);
    expect(ElevationTileService.sampleElevation(grid, 0, 0).isValid).toBe(false);
  });
});
