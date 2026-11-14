import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfflineDownloads } from '../src/offline/OfflineDownloads.ts';
import { OfflineStore } from '../src/offline/OfflineStore.ts';
import type { OfflinePlan } from '../src/offline/OfflinePlan.ts';

const routeId = 'rainier-emmons';
const url = (i: number) =>
  `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export?bbox=${9000 + i},${i},${i + 1},${i + 2}&size=256,256`;
function png(): Blob {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, 256); new DataView(bytes.buffer).setUint32(20, 256);
  return new Blob([bytes], { type: 'image/png' });
}
function plan(count: number): OfflinePlan {
  return { id: 'update-pack', routeId, routeHash: OfflineStore.bundledHash(routeId) ?? 'test-hash', name: 'Update pack',
    version: 3, coverage: 'corridor', maxZoom: 18, estimatedBytes: 1000,
    resources: Array.from({ length: count }, (_, i) => ({ urls: [url(i)], kind: 'image' as const, width: 256, height: 256 })) };
}

let failing = false;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { if (failing) throw new TypeError('Network unreachable'); return new Response(png()); }));
  vi.stubGlobal('navigator', { locks: { request: (_n: string, _o: unknown, task: (lock: unknown) => unknown) => task({}) },
    storage: { persist: async () => true, estimate: async () => ({ usage: 0, quota: 1e12 }) } });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 256, height: 256, close: () => {} }));
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) }) }) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps a "Needs update" pack ready and readable when its update fails', async () => {
  await OfflineDownloads.start(plan(2));
  expect(await OfflineStore.state('update-pack')).toMatchObject({ state: 'ready' });

  // A newer app version expects a third source; its first fetch fails.
  const states: string[] = [];
  const putState = OfflineStore.putState.bind(OfflineStore);
  vi.spyOn(OfflineStore, 'putState').mockImplementation(async next => { states.push(next.state); return putState(next); });
  failing = true;
  await expect(OfflineDownloads.start(plan(3))).rejects.toThrow('Network unreachable');

  expect(states.every(s => s === 'ready')).toBe(true); // never rewritten to 'downloading'
  const state = await OfflineStore.state('update-pack');
  expect(state).toMatchObject({ state: 'ready', updating: false, message: 'Network unreachable' });
  const blob = await OfflineStore.read(url(0));
  expect(blob?.size).toBe(32);

  failing = false;
  await OfflineDownloads.start(plan(3));
  expect(await OfflineStore.state('update-pack')).toMatchObject({ state: 'ready', completed: 3 });
  expect((await OfflineStore.state('update-pack'))?.updating).toBeUndefined();
  expect(await OfflineStore.read(url(2))).not.toBeNull();
});
