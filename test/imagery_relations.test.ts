import { afterEach, expect, it, vi } from 'vitest';
import { getChildTileKeys, getParentTileKey, getTileKey, ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TilePriority } from '../src/terrain/TileImageCache.ts';

const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75,
  widthMeters: 6000, depthMeters: 9000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
const make = (): any => new ImageryLODManager({ terrainGeoBounds: bounds, terrainBaseElevation: 0, elevationSampler: () => 0 });
afterEach(() => vi.restoreAllMocks());

it('calculates sibling readiness once per parent per sort and refreshes it when more tiles arrive', () => {
  const manager = make(), children = getChildTileKeys('satellite', 18, 42000, 92000);
  const update = vi.spyOn(manager, 'getOrCreateRefinementGroup');
  manager.desiredTileKeys = new Set(children);
  manager.requestQueue = children.map((key, i) => ({ key, zoom: 19, x: 84000 + i % 2, y: 184000 + Math.floor(i / 2), style: 'satellite', dist: i }));
  try {
    manager.sortRequestQueue(19); expect(update).toHaveBeenCalledTimes(1);
    for (const key of children.slice(0, 3)) manager.patches.set(key, { isFading: false, dispose() {} });
    update.mockClear(); manager.sortRequestQueue(19);
    expect(update).toHaveBeenCalledTimes(1);
    expect(manager.requestQueue.every((q: any) => q.priority === TilePriority.CRITICAL)).toBe(true);
  } finally { manager.dispose(); }
});

it('bounds cached relationships during geographic travel and recomputes evicted keys correctly', () => {
  const manager = make();
  try {
    for (let i = 0; i <= 4096; i++) manager.getTileRelations(getTileKey('satellite', 19, 84000 + i, 184000));
    expect(manager.tileRelations.size).toBe(4096);
    const first = getTileKey('satellite', 19, 84000, 184000);
    expect(manager.tileRelations.has(first)).toBe(false);
    expect(manager.getTileRelations(first)).toEqual({ parent: getParentTileKey('satellite', 19, 84000, 184000), children: getChildTileKeys('satellite', 19, 84000, 184000) });
    expect(manager.tileRelations.size).toBe(4096);
  } finally { manager.dispose(); }
});

it('keeps styles and zooms distinct and releases the cache on style changes and disposal', async () => {
  const manager = make();
  const key = getTileKey('satellite', 19, 84000, 184000);
  expect(manager.getTileRelations(key)).not.toEqual(manager.getTileRelations(getTileKey('hybrid', 19, 84000, 184000)));
  expect(manager.getTileRelations(key)).not.toEqual(manager.getTileRelations(getTileKey('satellite', 18, 84000, 184000)));
  await manager.setTextureStyle('topo'); expect(manager.tileRelations.size).toBe(0);
  manager.getTileRelations(key); manager.dispose(); expect(manager.tileRelations.size).toBe(0);
});
