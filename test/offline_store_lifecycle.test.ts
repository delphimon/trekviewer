import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfflineDownloads } from '../src/offline/OfflineDownloads.ts';
import { OfflineStore } from '../src/offline/OfflineStore.ts';
import type { OfflinePlan } from '../src/offline/OfflinePlan.ts';

const routeId = 'rainier-emmons';
// Packs must not share a bbox: read() also matches by geographic key across packs.
const packOffset = (pack: string) => [...pack].reduce((sum, c, i) => sum + c.charCodeAt(0) * (i + 1), 0) * 100;
const url = (pack: string, i: number) =>
  `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox=${packOffset(pack) + i},${i},${i + 1},${i + 2}&size=256,256`;

/** A minimal PNG body whose header declares 256 x 256. */
function png(tag: number): Blob {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, 256); new DataView(bytes.buffer).setUint32(20, 256);
  bytes[31] = tag;
  return new Blob([bytes], { type: 'image/png' });
}

function plan(id: string, count = 3): OfflinePlan {
  return { id, routeId, routeHash: OfflineStore.bundledHash(routeId) ?? 'test-hash', name: 'Test pack',
    version: 3, coverage: 'corridor', maxZoom: 18, estimatedBytes: 1000,
    resources: Array.from({ length: count }, (_, i) => ({ urls: [url(id, i)], kind: 'image' as const, width: 256, height: 256 })) };
}

let fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
const fetchMock = vi.fn((input: string, init: RequestInit) => fetchImpl(input, init));

beforeEach(() => {
  fetchImpl = async input => new Response(png(Number(new URL(input).searchParams.get('bbox')!.split(',')[1])));
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, task: (lock: unknown) => unknown) => task({}) },
    storage: { persist: async () => true, estimate: async () => ({ usage: 0, quota: 1e12 }) } });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 256, height: 256, close: () => {} }));
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) }) }) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('downloads a fresh pack, publishes it, and serves its sources offline', async () => {
  const p = plan('fresh');
  expect(await OfflineStore.read(p.resources[0].urls[0])).toBeNull();
  await OfflineDownloads.start(p);
  const state = await OfflineStore.state(p.id);
  expect(state).toMatchObject({ state: 'ready', completed: 3, total: 3 });
  const blob = await OfflineStore.read(p.resources[1].urls[0]);
  expect(blob?.size).toBe(32);
  expect(new Uint8Array(await blob!.arrayBuffer())[31]).toBe(1);
});

it('pauses mid-download, keeps saved sources, and resumes without fetching them again', async () => {
  const p = plan('resumed');
  fetchImpl = (input, init) => input === p.resources[1].urls[0]
    ? new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      queueMicrotask(() => OfflineDownloads.pause());
    })
    : Promise.resolve(new Response(png(0)));
  await OfflineDownloads.start(p);
  expect(await OfflineStore.state(p.id)).toMatchObject({ state: 'paused', completed: 1 });
  expect(await OfflineStore.read(p.resources[0].urls[0])).toBeNull(); // not published yet

  fetchImpl = async () => new Response(png(0));
  fetchMock.mockClear();
  await OfflineDownloads.start(p);
  expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([p.resources[1].urls[0], p.resources[2].urls[0]]);
  expect(await OfflineStore.state(p.id)).toMatchObject({ state: 'ready', completed: 3 });
  expect(await OfflineStore.read(p.resources[0].urls[0])).not.toBeNull();
});

it('removes a published pack and stops serving it', async () => {
  const p = plan('removed', 2);
  await OfflineDownloads.start(p);
  expect(await OfflineStore.read(p.resources[0].urls[0])).not.toBeNull();
  await OfflineStore.remove(p.id);
  expect(await OfflineStore.state(p.id)).toBeUndefined();
  expect(await OfflineStore.read(p.resources[0].urls[0])).toBeNull();
});

it('saves an asset directly and publishes once every planned source is present', async () => {
  const p = plan('saved', 1);
  const pack = { id: p.id, routeId, routeHash: p.routeHash, name: p.name, state: 'downloading' as const,
    total: 1, completed: 1, bytes: 32, estimatedBytes: 1000, message: '', updated: 0 };
  await OfflineStore.save(pack, p.resources[0], p.resources[0].urls[0], png(7), 'a'.repeat(64));
  expect(await OfflineStore.read(p.resources[0].urls[0])).toBeNull();
  await OfflineStore.publish(p, 1, 32);
  expect(await OfflineStore.state(p.id)).toMatchObject({ state: 'ready' });
  expect(await OfflineStore.read(p.resources[0].urls[0])).not.toBeNull();
});
