import { afterEach, expect, it, vi } from 'vitest';
import { PersistentResourceCache, persistentResourceAllowed, readBoundedBlob } from '../src/terrain/PersistentResourceCache.ts';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); PersistentResourceCache.setEnabled(true); });
const raster = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=1,2,3,4';

it('persists only reviewed source paths and excludes keys, commercial services and lookalike URLs', () => {
  expect(persistentResourceAllowed(raster)).toBe(true);
  expect(persistentResourceAllowed('https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?f=image')).toBe(true);
  expect(persistentResourceAllowed('https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?f=image')).toBe(true);
  expect(persistentResourceAllowed('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/12/2/3')).toBe(true);
  expect(persistentResourceAllowed('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/15/1/2.jpg')).toBe(true);
  expect(persistentResourceAllowed('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/1/2.png')).toBe(true);
  for (const url of [raster + '&token=private', raster + '&API_Key=private', raster.replace('https:', 'http:'),
    raster.replace('.gov/', '.gov.example.test/'), raster.replace('/exportImage?', '/query?'),
    'https://api.maptiler.com/tiles/satellite/1/2/3.jpg?key=private', 'https://user:private@elevation.nationalmap.gov/']) expect(persistentResourceAllowed(url)).toBe(false);
});

it('preserves exact binary bytes and rejects HTTP errors and declared oversize responses', async () => {
  const bytes = new Uint8Array([0, 255, 16, 0, 128]);
  const result = await readBoundedBlob(new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }), 5);
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
  expect(result.type).toBe('application/octet-stream');
  await expect(readBoundedBlob(new Response(bytes, { headers: { 'content-length': '6' } }), 5)).rejects.toThrow('too large');
  await expect(readBoundedBlob(new Response('error', { status: 503 }), 50)).rejects.toThrow('unavailable');
});

it('cancels chunked bodies that cross the actual byte limit without trusting missing headers', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); }, cancel });
  await expect(readBoundedBlob(new Response(body), 7)).rejects.toThrow('too large');
  expect(cancel).toHaveBeenCalledOnce();
});

it('falls through when storage is absent or denied and honors the device opt-out', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(PersistentResourceCache.read(raster)).resolves.toBeNull();
  PersistentResourceCache.write(raster, new Blob(['data'])); await PersistentResourceCache.flush();
  vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Denied', 'SecurityError'); } });
  await expect(PersistentResourceCache.read(raster)).resolves.toBeNull();
  PersistentResourceCache.setEnabled(false);
  expect(PersistentResourceCache.getStats().enabled).toBe(false);
  await expect(PersistentResourceCache.read(raster)).resolves.toBeNull();
});
