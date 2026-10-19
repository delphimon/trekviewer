import { afterEach, expect, it, vi } from 'vitest';
import { PublicImageryProvider } from '../src/terrain/providers/PublicImageryProvider.ts';
import { inSwissImageryEnvelope, isSwissImageryURL, isCompleteSwissImage, SWISS_IMAGE_TILES } from '../src/terrain/providers/SwissImagery.ts';
import { imagerySourceId } from '../src/terrain/ImagerySource.ts';
import { persistentResourceAllowed } from '../src/terrain/PersistentResourceCache.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { latLonToTile } from '../src/gpx/Coordinates.ts';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); TextureProvider.resetForTesting(); });

it('uses exact Swiss XYZ PNGs for detail and retains complete global overview with no upscaled fine fallback', () => {
  const provider = new PublicImageryProvider(), tile = latLonToTile(46.624, 8.041, 19);
  expect(provider.getMaxZoomForLocation(46.624, 8.041)).toBe(19);
  expect(provider.getTileUrls(19, tile.x, tile.y)).toEqual([`${SWISS_IMAGE_TILES}19/${tile.x}/${tile.y}.png`]);
  expect(provider.getTileImageRegion(19, tile.x, tile.y)).toBeUndefined();
  expect(provider.getTileRequestGroup(19, tile.x, tile.y)).toBeUndefined();
  expect(provider.getTileUrls(20, tile.x * 2, tile.y * 2)).toEqual([]);
  const overview = latLonToTile(46.624, 8.041, 15);
  expect(provider.getTileUrls(15, overview.x, overview.y)[0]).toContain('s2cloudless-2025');
  const bounds = { minLat:46.62,maxLat:46.63,minLon:8.04,maxLon:8.05,centerLat:46.625,centerLon:8.045,widthMeters:760,depthMeters:1110,minEle:1000,maxEle:1200,elevationSpan:200 };
  expect(TextureProvider.getTileGridForBounds(bounds).zoom).toBe(15);
  expect(TextureProvider.getAttributionForStyle('satellite', bounds)).toContain('©swisstopo');
  expect(TextureProvider.getAttributionForStyle('hybrid', bounds)).toContain('Planet');
});

it('uses the published service envelope only for eligibility and preserves unrelated geographic policy', () => {
  expect(inSwissImageryEnvelope(47.85, 10.5)).toBe(true); // Neighboring country: masks establish actual coverage.
  expect(inSwissImageryEnvelope(48.5, 8)).toBe(false);
  const provider = new PublicImageryProvider();
  expect(provider.getMaxZoomForLocation(27.98, 86.92)).toBe(15);
  expect(provider.getMaxZoomForLocation(-43.6, 170.1)).toBe(15);
  expect(provider.getMaxZoomForLocation(46.85, -121.75)).toBe(19);
});

it('rejects even one masked source pixel while accepting opaque snow, and releases validation storage', () => {
  const pixels = new Uint8ClampedArray(256 * 256 * 4).fill(255);
  const read = vi.fn(() => ({ data: pixels }));
  const canvas = { width:0,height:0,getContext:()=>({drawImage(){},getImageData:read}) };
  vi.stubGlobal('document', { createElement: () => canvas });
  const opaque = { width:256,height:256 } as HTMLCanvasElement;
  expect(isCompleteSwissImage(opaque)).toBe(true);
  expect(isCompleteSwissImage(opaque)).toBe(true); expect(read).toHaveBeenCalledTimes(1);
  pixels[4 * 257 + 3] = 254;
  expect(isCompleteSwissImage({ width:256,height:256 } as HTMLCanvasElement)).toBe(false);
  expect(isCompleteSwissImage({ width:128,height:256 } as HTMLCanvasElement)).toBe(false);
  expect(canvas.width).toBe(1); expect(canvas.height).toBe(1);
});

it('classifies and admits only the reviewed current Swiss PNG endpoint, without tokens or historical snapshots', () => {
  const url = `${SWISS_IMAGE_TILES}19/273854/185205.png`;
  expect(isSwissImageryURL(url)).toBe(true); expect(persistentResourceAllowed(url)).toBe(true); expect(imagerySourceId(url)).toBe('swissimage');
  for (const invalid of [url + '?key=private', url.replace('/current/', '/2025/'), url.replace('.png', '.jpeg'), url.replace('.ch/', '.ch.example.test/')]) {
    expect(isSwissImageryURL(invalid)).toBe(false); expect(persistentResourceAllowed(invalid)).toBe(false);
  }
});

it('checks the official cache revision once per page and validates the timestamp', async () => {
  vi.resetModules();
  const module = await import('../src/terrain/providers/SwissImagery.ts');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ cache_update:'2026-10-01T12:34:56' })));
  vi.stubGlobal('fetch', fetch);
  const [a,b] = await Promise.all([module.checkSwissImageryRevision(),module.checkSwissImageryRevision()]);
  expect(a).toBe(String(Date.parse('2026-10-01T12:34:56Z'))); expect(b).toBe(a); expect(fetch).toHaveBeenCalledOnce();
  expect(module.getSwissImageryRevision()).toBe(a);
});

it('skips persisted Swiss reuse on failed or malformed revision checks while allowing network imagery', async () => {
  vi.resetModules(); const module = await import('../src/terrain/providers/SwissImagery.ts');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ cache_update:'not-a-date' }))));
  expect(await module.checkSwissImageryRevision()).toBeNull(); expect(module.getSwissImageryRevision()).toBeNull();
  const provider = new PublicImageryProvider(), tile = latLonToTile(46.624,8.041,19);
  expect(provider.getTileUrls(19,tile.x,tile.y)).toHaveLength(1);
});
