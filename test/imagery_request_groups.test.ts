import { afterEach, expect, it, vi } from 'vitest';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { PublicImageryProvider, USGSReferenceProvider } from '../src/terrain/providers/PublicImageryProvider.ts';
import { EsriWorldImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';

const provider = new PublicImageryProvider();
const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 6000, depthMeters: 9000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
const image = {} as HTMLImageElement;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup() {
  const loads: { x: number; y: number; resolve: (image: HTMLImageElement) => void; reject: (error: Error) => void }[] = [];
  vi.spyOn(ImageryLODManager, 'loadPatchImage').mockImplementation((_zoom, x, y) => new Promise((resolve, reject) => loads.push({ x, y, resolve, reject })));
  const manager: any = new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0, maxConcurrency: 6 });
  const mount = vi.spyOn(manager, 'createAndMountPatch').mockImplementation(() => {});
  return { manager, loads, mount };
}
function candidates(offset = 0) {
  return Array.from({ length: 6 }, (_, group) => Array.from({ length: 16 }, (_, i) => ({
    x: 84000 + offset + group * 4 + i % 4, y: 184000 + Math.floor(i / 4), zoom: 19, dist: 10 + group * 16 + i,
  }))).flat();
}
afterEach(() => vi.restoreAllMocks());

it('identifies shared exports without grouping unrelated zooms, global tiles or ordinary providers', () => {
  expect(provider.getTileRequestGroup(19, 84000, 184000)).toBe(provider.getTileRequestGroup(19, 84003, 184003));
  expect(provider.getTileRequestGroup(19, 84004, 184000)).not.toBe(provider.getTileRequestGroup(19, 84000, 184000));
  expect(provider.getTileRequestGroup(18, 42000, 92000)).not.toBe(provider.getTileRequestGroup(19, 84000, 184000));
  expect(provider.getTileRequestGroup(16, 10500, 23000)).toBeUndefined();
  expect(provider.getTileRequestGroup(15, 17248, 11545)).toBeUndefined();
  expect(new USGSReferenceProvider().getTileRequestGroup(19, 84000, 184000)).toBe(new USGSReferenceProvider().getTileRequestGroup(19, 84003, 184003));
});

it('uses bounded distinct exports instead of spending every slot on crops of the first slow export', async () => {
  const { manager, loads, mount } = setup();
  try {
    manager.reconcileDesiredTiles(candidates(), provider, 19);
    expect(loads.map(l => l.x)).toEqual([84000, 84004, 84008, 84012]);
    expect(manager.activeRequestCount).toBe(TileImageCache.MAX_SHARED_RASTERS);
    expect(manager.activeRequestCount).toBeLessThanOrEqual(manager.maxConcurrency);
    // Completing one source admits its next priority crop without duplicating
    // the other three outstanding exports or starving the queue.
    loads[0].resolve(image); await flush();
    expect(mount).toHaveBeenCalledTimes(1); expect(loads[4].x).toBe(84001);
    expect(manager.activeRequestCount).toBe(4);
    expect(new Set([...manager.pendingRequests.values()].map((p: any) => p.requestGroup)).size).toBe(4);
  } finally { manager.dispose(); }
});

it('waits for a shared export then finishes all selected crops without waiting for another evaluation', async () => {
  const { manager, loads, mount } = setup();
  try {
    manager.reconcileDesiredTiles(candidates().slice(0, 2), provider, 19);
    expect(loads).toHaveLength(1);
    loads[0].resolve(image); await flush(); expect(loads).toHaveLength(2);
    loads[1].resolve(image); await flush();
    expect(mount).toHaveBeenCalledTimes(2); expect(manager.activeRequestCount).toBe(0); expect(manager.requestQueue).toHaveLength(0);
  } finally { manager.dispose(); }
});

it('preserves the existing ordered six-slot behavior for providers without shared exports', () => {
  const { manager, loads } = setup();
  try {
    manager.reconcileDesiredTiles(candidates(), new EsriWorldImageryProvider(), 19);
    expect(loads).toHaveLength(6); expect(loads.map(l => [l.x, l.y])).toEqual(candidates().slice(0, 6).map(c => [c.x, c.y]));
  } finally { manager.dispose(); }
});

it('reserves source-cache capacity for both aerial and label exports in Hybrid', () => {
  const { manager, loads } = setup();
  try {
    manager.currentTextureStyle = 'hybrid';
    manager.reconcileDesiredTiles(candidates(), provider, 19);
    expect(loads.map(l => l.x)).toEqual([84000, 84004]);
    expect(manager.activeRequestCount * 2).toBe(TileImageCache.MAX_SHARED_RASTERS);
  } finally { manager.dispose(); }
});

it('releases cancelled groups immediately and ignores late completions from the old footprint', async () => {
  const { manager, loads, mount } = setup();
  try {
    manager.reconcileDesiredTiles(candidates(), provider, 19);
    manager.reconcileDesiredTiles(candidates(400), provider, 19);
    expect(loads).toHaveLength(8); expect(manager.activeRequestCount).toBe(4);
    loads[0].resolve(image); loads[1].reject(new Error('old request aborted')); await flush();
    expect(manager.activeRequestCount).toBe(4); expect(mount).not.toHaveBeenCalled(); expect(manager.failedRequests.size).toBe(0);
    loads[4].resolve(image); await flush();
    expect(loads[8].x).toBe(84401); expect(mount).toHaveBeenCalledTimes(1);
  } finally { manager.dispose(); }
});

it('releases a failed source group, keeps its bounded retry and continues other selected work', async () => {
  const { manager, loads } = setup();
  try {
    manager.reconcileDesiredTiles(candidates(), provider, 19);
    loads[0].reject(new Error('source unavailable')); await flush();
    expect(loads[4].x).toBe(84001); expect(manager.activeRequestCount).toBe(4); expect(manager.failedRequests.size).toBe(1);
    expect(manager.nextRetryTime).toBeGreaterThan(performance.now());
  } finally { manager.dispose(); }
});
