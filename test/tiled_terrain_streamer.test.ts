import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { TiledTerrainStreamer } from '../src/terrain/TiledTerrainStreamer.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { QUALITY_PROFILES, terrainDetailPolicy } from '../src/terrain/QualityProfile.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { planTerrainTiles } from '../src/terrain/TerrainTileLayout.ts';
import { localMetersToGeo } from '../src/gpx/Coordinates.ts';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const parent = { width: 3840, depth: 3840, segmentsX: 32, segmentsZ: 32 };
  const attached = new Set<LocalTerrainChunk>();
  const terrain: any = {
    baseMeshGrid: parent, terrainGeoBounds: { centerLat: 46, centerLon: -120 }, terrainBaseElevation: 0,
    terrainMesh: new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()),
    sampleBaseSurfaceY: (x: number, z: number) => 100 + x * 0.01 + z * 0.02,
    attachLocalChunk: (chunk: LocalTerrainChunk) => attached.add(chunk),
    detachLocalChunk: (chunk: LocalTerrainChunk) => { attached.delete(chunk); chunk.dispose(); },
    notifySurfaceChange: vi.fn(),
  };
  const routeGeometry: any = { getTelemetryAtProgress: () => ({ currentPoint: { lat: 46, lon: -120 } }) };
  const streamer = new TiledTerrainStreamer({ terrainResult: terrain, routeGeometry, demGrid: {} as any, qualityProfile: QUALITY_PROFILES['quest-high'] });
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ elevation: 125, isValid: true });
  return { streamer, terrain, parent, attached };
}

async function flushBuild(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); }

it('admits the current ground immediately after crossing a tile corner below the movement threshold', async () => {
  const { streamer } = fixture();
  const signals: AbortSignal[] = [];
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockImplementation((_lat, _lon, _radius, _zoom, _max, signal) =>
    new Promise((_resolve, reject) => {
      signals.push(signal!);
      signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
  const focus = (x: number, z: number) => localMetersToGeo(x, z, 46, -120);
  streamer.update(0, focus(-965, -965));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect((streamer as any).acquisitions.has('1:1')).toBe(false);
  streamer.update(0, focus(-955, -955));
  expect((streamer as any).focusTileId).toBe('1:1');
  expect((streamer as any).acquisitions.has('1:1')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(signals.filter(signal => !signal.aborted)).toHaveLength(3);
  streamer.update(0, focus(-954, -954));
  expect(fetch).toHaveBeenCalledTimes(4);
  streamer.dispose(); await flushBuild();
});

it('refreshes priority within an unchanged footprint and admits the new hiker tile without waiting for three slow requests', async () => {
  const { streamer, attached } = fixture();
  const pending: { resolve: (grid: any) => void; signal: AbortSignal }[] = [];
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockImplementation((_lat, _lon, _radius, _zoom, _max, signal) =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, signal: signal! });
      signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
  const focus = (x: number, z: number) => localMetersToGeo(x, z, 46, -120);
  streamer.update(0, focus(-1300, -1300));
  const wantedBefore = [...(streamer as any).wanted.keys()].sort();
  expect(fetch).toHaveBeenCalledTimes(3);
  streamer.update(0, focus(1300, 1300));
  expect([...(streamer as any).wanted.keys()].sort()).toEqual(wantedBefore);
  expect([...(streamer as any).wanted.keys()][0]).toBe('3:3');
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(pending.slice(0, 3).filter(entry => entry.signal.aborted)).toHaveLength(1);
  expect(pending.filter(entry => !entry.signal.aborted)).toHaveLength(3);
  expect((streamer as any).acquisitions.has('3:3')).toBe(true);
  // Moving within that tile must not repeatedly cancel useful downloads.
  streamer.update(0, focus(1400, 1400)); expect(fetch).toHaveBeenCalledTimes(4);
  pending[3].resolve({ zoom: 15, isRealDEM: true }); await flushBuild();
  streamer.update(0, focus(1400, 1400)); await flushBuild(); streamer.update(0, focus(1400, 1400));
  expect((streamer as any).chunks.has('3:3')).toBe(true); expect(attached.size).toBeGreaterThan(0);
  streamer.dispose(); await flushBuild();
});

it('retains completed DEM acquisitions when the hiker moves to another tile in the same footprint', async () => {
  const { streamer } = fixture();
  const pending: ((grid: any) => void)[] = [];
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  let promote!: (publish: () => boolean) => void;
  (streamer as any).options.prepareSurfacePromotion = vi.fn().mockReturnValueOnce(new Promise(resolve => { promote = resolve; })).mockResolvedValue(() => true);
  streamer.update(0, localMetersToGeo(-1300, -1300, 46, -120));
  pending.forEach(resolve => resolve({ zoom: 15, isRealDEM: true })); await flushBuild();
  const signals = fetch.mock.calls.map(call => call[5] as AbortSignal);
  streamer.update(0, localMetersToGeo(1300, 1300, 46, -120));
  expect(signals.every(signal => !signal.aborted)).toBe(true);
  promote(() => true); await flushBuild();
  streamer.update(0, localMetersToGeo(1300, 1300, 46, -120));
  expect((streamer as any).acquisitions.has('3:3')).toBe(true);
  streamer.dispose(); await flushBuild();
});

it('publishes completed DEM sections while the first request remains slow, then publishes that request when it arrives', async () => {
  const { streamer, attached } = fixture();
  const pending: ((grid: any) => void)[] = [];
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  const grid = { zoom: 15, isRealDEM: true } as any;
  pending[1](grid); pending[2](grid); await flushBuild(); streamer.update(0); await flushBuild();
  expect(attached.size).toBe(1);
  streamer.update(0); expect(attached.size).toBe(2);
  expect((fetch.mock.calls[0][5] as AbortSignal).aborted).toBe(false);
  pending[0](grid); await flushBuild(); streamer.update(0); await flushBuild(); streamer.update(0);
  expect(attached.size).toBe(3);
  streamer.dispose();
});

it('reuses validated terrain when new imagery invalidates a prepared publication', async () => {
  const { streamer, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  const build = vi.spyOn(LocalTerrainChunk, 'createAsync');
  const publish = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  const prepare = vi.fn(async (_chunk: LocalTerrainChunk) => publish);
  (streamer as any).options.prepareSurfacePromotion = prepare;
  streamer.update(0); await flushBuild(); streamer.update(0); await flushBuild();
  expect(attached.size).toBe(0);
  streamer.update(0);
  expect(attached.size).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1); expect(build).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(prepare.mock.calls[0][0]).toBe(prepare.mock.calls[1][0]);
  streamer.dispose();
});

it('disposes retained terrain after route replacement while imagery preparation is pending', async () => {
  const { streamer, attached } = singleTileFixture();
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  let finish!: (publish: () => boolean) => void;
  const prepare = vi.fn().mockResolvedValueOnce(() => false)
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  (streamer as any).options.prepareSurfacePromotion = prepare;
  streamer.update(0); await flushBuild();
  const candidate = (streamer as any).ready.chunk as LocalTerrainChunk;
  const dispose = vi.spyOn(candidate, 'dispose');
  streamer.update(0); streamer.dispose();
  finish(() => true); await flushBuild(); streamer.update(0);
  expect(dispose).toHaveBeenCalledTimes(1); expect(attached.size).toBe(0);
});

it.each([true, false])('reserves capacity for the completed large tile only when DEM is available (%s)', async available => {
  const { streamer, terrain } = fixture();
  const plan = planTerrainTiles({ parent: { width: 3960, depth: 960, segmentsX: 33, segmentsZ: 8 },
    focusX: 0, focusZ: 0, radiusM: 5000, targetCellM: 5, maxTiles: 8, maxVertices: 600000, parentCellsPerTile: 8 });
  const small = plan.tiles.find(tile => tile.column === 4)!;
  const large = plan.tiles.find(tile => tile.column === 0)!;
  expect(small.vertexCount).toBeLessThan(8000);
  expect(large.vertexCount).toBeGreaterThan(8000);
  (streamer as any).plannedAt = { x: 0, z: 0 };
  (streamer as any).wanted = new Map([[small.id, small], [large.id, large]]);
  (streamer as any).acquisitions = new Map([
    [small.id, { controller: new AbortController(), settled: false, result: new Promise(() => {}) }],
    [large.id, { controller: new AbortController(), settled: true, result: Promise.resolve({ grid: available ? { zoom: 15, isRealDEM: true } : null }) }],
  ]);
  for (let i = 0; i < 4; i++) (streamer as any).chunks.set(`old${i}`, {
    totalVertices: 198000, mesh: new THREE.Mesh(), dispose: vi.fn(),
    getSurfaceBounds: () => ({ minX: 20000 + i * 1000, maxX: 21000 + i * 1000, minZ: 0, maxZ: 1000 }),
  });
  const retire = vi.fn(async (_chunks: LocalTerrainChunk[]) => () => true);
  (streamer as any).options.prepareSurfaceRemoval = retire;
  streamer.update(0); await flushBuild();
  if (!available) {
    expect(retire).not.toHaveBeenCalled(); expect(streamer.activeChunks).toHaveLength(4);
    expect((streamer as any).failed.has(large.id)).toBe(true);
    streamer.dispose(); return;
  }
  expect(retire).toHaveBeenCalledTimes(1); expect(retire.mock.calls[0][0]).toHaveLength(1);
  expect(streamer.activeChunks).toHaveLength(4); // Old coverage awaits prepared retirement.
  streamer.update(0); await flushBuild(); streamer.update(0);
  expect(streamer.activeChunks.reduce((sum, chunk) => sum + chunk.totalVertices, 0)).toBeLessThanOrEqual(800000);
  expect((streamer as any).chunks.has(large.id)).toBe(true);
  expect(terrain.notifySurfaceChange).toHaveBeenCalled();
  streamer.dispose();
});

it('acquires three detailed DEM sections while a slow promotion holds the single publication lane', async () => {
  const { streamer, attached } = fixture();
  const pending: ((grid: any) => void)[] = [];
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  let promote!: (publish: () => boolean) => void;
  (streamer as any).options.prepareSurfacePromotion = vi.fn().mockReturnValueOnce(new Promise(resolve => { promote = resolve; }))
    .mockResolvedValue(() => true);
  streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  pending.forEach(resolve => resolve({ zoom: 15, isRealDEM: true })); await flushBuild();
  for (let i = 0; i < 72; i++) streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(3); expect(attached.size).toBe(0);
  promote(() => true); await flushBuild(); streamer.update(0);
  expect(attached.size).toBe(1);
  await flushBuild(); // The second grid was acquired before the first promotion.
  expect((streamer as any).ready).not.toBeNull();
  expect(attached.size).toBe(1);
  streamer.update(0); expect(attached.size).toBe(2);
  const queuedSignals = [...(streamer as any).acquisitions.values()].map(entry => entry.controller.signal as AbortSignal);
  streamer.dispose();
  expect(queuedSignals.every(signal => signal.aborted)).toBe(true);
});

it('cancels unwanted queued DEM work and continues when a new plan changes the priority order', async () => {
  const { streamer, terrain, attached } = fixture();
  const pending: ((grid: any) => void)[] = [];
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  streamer.update(0);
  const oldSignals = fetch.mock.calls.map(call => call[5] as AbortSignal);
  streamer.update(0, { lat: 48, lon: -118 });
  expect(oldSignals.every(signal => signal.aborted)).toBe(true);
  pending.forEach(resolve => resolve({ zoom: 15, isRealDEM: true })); await flushBuild();
  expect(attached.size).toBe(0); expect(terrain.notifySurfaceChange).not.toHaveBeenCalled();
  streamer.update(0); // Return to the route without waiting for a failure cooldown.
  expect(fetch).toHaveBeenCalledTimes(6);
  pending.slice(3).forEach(resolve => resolve({ zoom: 15, isRealDEM: true })); await flushBuild();
  streamer.update(0); expect(attached.size).toBe(1);
  streamer.dispose();
});

function singleTileFixture() {
  const result = fixture();
  result.terrain.baseMeshGrid = { width: 960, depth: 960, segmentsX: 8, segmentsZ: 8 };
  return result;
}

it('retains fallback terrain while retrying the preferred source, then replaces terrain and imagery atomically', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { streamer, attached } = singleTileFixture();
  const fallback = { zoom: 15, isRealDEM: true, preferredSourceRetry: true } as any;
  const native = { zoom: 0, isRealDEM: true, source: 'USGS 3DEP' } as any;
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValueOnce(fallback).mockResolvedValueOnce(fallback).mockResolvedValue(native);
  const prepare = vi.fn(async () => () => true); (streamer as any).options.prepareSurfacePromotion = prepare;
  streamer.update(0); await flushBuild(); streamer.update(0);
  expect(attached.size).toBe(1); const previous = [...attached][0];
  expect(previous.currentGrid.preferredSourceRetry).toBe(true);
  now = 59_999; streamer.update(0); await flushBuild(); expect(fetch).toHaveBeenCalledTimes(1);
  now = 60_000; streamer.update(0); await flushBuild(); streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(2); expect(attached.has(previous)).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1); // Repeated fallback does not rebuild geometry.
  now = 180_000; streamer.update(0); await flushBuild();
  expect(attached.has(previous) && previous.mesh.visible).toBe(true);
  expect(prepare).toHaveBeenLastCalledWith(expect.any(LocalTerrainChunk), previous);
  streamer.update(0);
  expect(attached.size).toBe(1); expect(attached.has(previous)).toBe(false);
  expect([...attached][0].currentGrid).toBe(native);
  expect((streamer as any).failed.size).toBe(0);
  streamer.dispose();
});

it('sleeps after all detail is published and caches stationary route focus', async () => {
  const { streamer, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  const prepare = vi.spyOn(streamer as any, 'prepareNext');
  const telemetry = vi.spyOn((streamer as any).options.routeGeometry, 'getTelemetryAtProgress');
  streamer.update(0); await flushBuild(); streamer.update(0); await flushBuild();
  expect(attached.size).toBe(1);
  prepare.mockClear();
  for (let i = 0; i < 200; i++) { streamer.update(0); await flushBuild(); }
  expect(prepare).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1); expect(telemetry).toHaveBeenCalledTimes(1);
  streamer.update(0.1);
  expect(telemetry).toHaveBeenCalledTimes(2);
  streamer.dispose();
});

it('retains base coverage and retries missing DEM after its cache cooldown, then publishes atomically', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { streamer, terrain, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValueOnce(null).mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  streamer.update(0); await flushBuild(); streamer.update(0);
  expect(attached.size).toBe(0); expect(terrain.notifySurfaceChange).not.toHaveBeenCalled();
  now = 59999;
  for (let i = 0; i < 72; i++) streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  now = 60000; streamer.update(0); await flushBuild();
  expect(fetch).toHaveBeenCalledTimes(2); expect(attached.size).toBe(0);
  streamer.update(0); expect(attached.size).toBe(1);
  expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1); expect((streamer as any).failed.size).toBe(0);
  streamer.dispose();
});

it('backs off repeated request errors to five minutes and avoids probes before the deadline', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { streamer, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockRejectedValue(new Error('network unavailable'));
  const prepare = vi.spyOn(streamer as any, 'prepareNext');
  for (const delay of [60000, 120000, 240000, 300000, 300000]) {
    streamer.update(0); await flushBuild(); streamer.update(0);
    const calls = fetch.mock.calls.length, probes = prepare.mock.calls.length;
    now += delay - 1;
    for (let frame = 0; frame < 72; frame++) streamer.update(0);
    expect(fetch.mock.calls.length).toBe(calls); expect(prepare.mock.calls.length).toBe(probes);
    now++;
  }
  expect(fetch).toHaveBeenCalledTimes(5); expect(attached.size).toBe(0);
  streamer.dispose();
});

it('forgets failures outside the wanted footprint and recovers when that focus returns', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { streamer, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValueOnce(null).mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  streamer.update(0); await flushBuild(); streamer.update(0);
  expect((streamer as any).failed.size).toBe(1);
  streamer.update(0, { lat: 47, lon: -119 }); await flushBuild();
  expect((streamer as any).failed.size).toBe(0);
  streamer.update(0); await flushBuild(); streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(2); expect(attached.size).toBe(1);
  streamer.dispose();
});

it('does not blacklist a tile when exaggeration invalidates its in-flight geometry', async () => {
  const { streamer, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  let complete!: (chunk: LocalTerrainChunk) => void;
  vi.spyOn(LocalTerrainChunk, 'createAsync').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  streamer.update(0); await flushBuild(); streamer.setVerticalExaggeration(1.5);
  const stale: any = { validate: () => ({ isValid: true }), dispose: vi.fn() };
  complete(stale); await flushBuild(); expect(stale.dispose).toHaveBeenCalledTimes(1);
  streamer.update(0); await flushBuild(); streamer.update(0);
  expect(fetch).toHaveBeenCalledTimes(2); expect(attached.size).toBe(1);
  expect(streamer.activeChunks[0].mesh.visible).toBe(true);
  streamer.dispose();
});

it('keeps invalid geometry unpublished without retrying it every minute', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { streamer, attached } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  const invalid: any = { validate: () => ({ isValid: false }), dispose: vi.fn() };
  vi.spyOn(LocalTerrainChunk, 'createAsync').mockResolvedValue(invalid);
  streamer.update(0); await flushBuild(); streamer.update(0);
  now = 600000; streamer.update(0); await flushBuild();
  expect(fetch).toHaveBeenCalledTimes(1); expect(attached.size).toBe(0); expect(invalid.dispose).toHaveBeenCalledTimes(1);
  streamer.dispose();
});

it('does not retry a failed request after the route is disposed', async () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const { streamer } = singleTileFixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue(null);
  streamer.update(0); await flushBuild(); streamer.update(0); streamer.dispose();
  now = 600000; streamer.update(0); await flushBuild(); expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps parent coverage through acquisition and publishes one validated tile per frame', async () => {
  const { streamer, terrain, attached } = fixture();
  let complete!: (grid: any) => void;
  const pending = new Promise<any>(resolve => { complete = resolve; });
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockReturnValue(pending);
  streamer.update(0);
  expect(attached.size).toBe(0); expect(terrain.notifySurfaceChange).not.toHaveBeenCalled();
  complete({ zoom: 15, isRealDEM: true }); await flushBuild();
  expect(attached.size).toBe(0);
  streamer.update(0);
  expect(attached.size).toBe(1); expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1);
  expect(streamer.activeChunks[0].mesh.visible).toBe(true);
  streamer.dispose();
});

it('bounds total refinement vertices and reuses stable terrain when focus is stationary', async () => {
  const { streamer } = fixture();
  const fetch = vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  for (let i = 0; i < 40; i++) { streamer.update(0); await flushBuild(); }
  const chunks = streamer.activeChunks;
  const policy = terrainDetailPolicy(QUALITY_PROFILES['quest-high']);
  expect(chunks.length).toBeGreaterThan(1); expect(chunks.length).toBeLessThanOrEqual(policy.maxTiles);
  expect(chunks.reduce((sum, c) => sum + c.totalVertices, 0)).toBeLessThanOrEqual(policy.maxVertices);
  const calls = fetch.mock.calls.length;
  for (let i = 0; i < 72; i++) { streamer.update(0); await flushBuild(); }
  expect(fetch.mock.calls.length).toBe(calls);
  expect(streamer.activeChunks).toEqual(chunks);
  streamer.dispose();
});

it('discards an in-flight tile after route disposal without publishing', async () => {
  const { streamer, terrain, attached } = fixture();
  let complete!: (grid: any) => void;
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockReturnValue(new Promise(resolve => { complete = resolve; }));
  streamer.update(0); streamer.dispose();
  complete({ zoom: 15, isRealDEM: true }); await flushBuild(); streamer.update(0);
  expect(attached.size).toBe(0);
  expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1); // disposal restores parent coverage
});

it('matches heights and normals across adjacent independently built terrain tiles', () => {
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ elevation: 200, isValid: true });
  const plan = planTerrainTiles({ parent: { width: 1920, depth: 960, segmentsX: 16, segmentsZ: 8 }, focusX: 0, focusZ: 0, radiusM: 3000,
    parentCellsPerTile: 8, targetCellM: 10, maxTiles: 2, maxVertices: 30_000 });
  const chunks = plan.tiles.map(layout => new LocalTerrainChunk({
    layout, localGrid: { zoom: 15, isRealDEM: true } as any, centerLat: 46, centerLon: -120,
    terrainBaseElevation: 0, baseElevationSampler: (x, z) => 100 + x * 0.1 + z * 0.2,
  }));
  const [left, right] = chunks.sort((a, b) => a.localBounds.minX - b.localBounds.minX);
  const lp = left.geometry.attributes.position, rp = right.geometry.attributes.position;
  const ln = left.geometry.attributes.normal, rn = right.geometry.attributes.normal;
  const cols = plan.tiles[0].segmentsX + 1;
  for (let row = 0; row <= plan.tiles[0].segmentsZ; row++) {
    const a = row * cols + cols - 1, b = row * cols;
    expect(lp.getY(a)).toBeCloseTo(rp.getY(b), 4);
    expect(ln.getX(a)).toBeCloseTo(rn.getX(b), 4);
    expect(ln.getZ(a)).toBeCloseTo(rn.getZ(b), 4);
  }
  chunks.forEach(chunk => chunk.dispose());
});

it('retains old coverage until a quality change prepares removal imagery, then replaces it atomically', async () => {
  const { streamer, terrain, attached } = fixture();
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  for (let i = 0; i < 15; i++) { streamer.update(0); await flushBuild(); }
  const before = [...attached]; expect(before.length).toBeGreaterThan(0);
  let complete!: (publish: () => boolean) => void;
  const prepared = new Promise<() => boolean>(resolve => { complete = resolve; });
  const prepare = vi.fn().mockReturnValue(prepared);
  (streamer as any).options.prepareSurfaceRemoval = prepare;
  terrain.notifySurfaceChange.mockClear();
  streamer.setQualityProfile(QUALITY_PROFILES['quest-balanced']);
  streamer.update(0, { lat: 46.01, lon: -119.99 }); await flushBuild();
  expect(prepare).toHaveBeenCalledTimes(1);
  const retiring: LocalTerrainChunk[] = prepare.mock.calls[0][0]; expect(retiring.length).toBeGreaterThan(0);
  expect(retiring.every(chunk => chunk.mesh.visible && attached.has(chunk))).toBe(true);
  expect(terrain.notifySurfaceChange).not.toHaveBeenCalled();
  const publish = vi.fn(() => { expect(retiring.every(chunk => chunk.mesh.visible)).toBe(true); return true; });
  complete(publish); await flushBuild(); streamer.update(0, { lat: 46.01, lon: -119.99 });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(retiring.every(chunk => !attached.has(chunk))).toBe(true);
  expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1);
  expect(terrain.notifySurfaceChange.mock.calls[0][0]).toHaveProperty('minX');
  streamer.dispose();
});

it('can change quality before the first tile without repeatedly retiring new tiles', async () => {
  const { streamer } = fixture();
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  streamer.setQualityProfile(QUALITY_PROFILES['quest-balanced']);
  for (let i = 0; i < 15; i++) { streamer.update(0); await flushBuild(); }
  expect(streamer.activeChunks.length).toBeGreaterThan(1);
  expect(streamer.activeChunks.length).toBeLessThanOrEqual(9);
  streamer.dispose();
});

it('keeps previously loaded detail visible until replacement needs its bounded resident capacity', async () => {
  const { streamer, terrain, attached } = fixture();
  terrain.baseMeshGrid = { width: 9600, depth: 9600, segmentsX: 160, segmentsZ: 160 };
  vi.spyOn(ElevationTileService, 'fetchLocalElevationGrid').mockResolvedValue({ zoom: 15, isRealDEM: true } as any);
  vi.spyOn(LocalTerrainChunk, 'createAsync').mockImplementation(async options => ({
    mesh: new THREE.Mesh(), totalVertices: (options.layout!.segmentsX + 1) * (options.layout!.segmentsZ + 1),
    setVerticalExaggeration: () => {}, setMapTexture: () => {}, validate: () => ({ isValid: true }), dispose: vi.fn(),
    getSurfaceBounds: () => options.layout!.bounds,
  }) as any);
  for (let i = 0; i < 110; i++) { streamer.update(0); await flushBuild(); }
  const old = [...attached]; expect(old.length).toBe(48);
  const remove = vi.fn(async () => () => true); (streamer as any).options.prepareSurfaceRemoval = remove;
  const focus = { lat: 46.03, lon: -119.96 };
  streamer.update(0, focus); await flushBuild();
  expect(old.every(chunk => attached.has(chunk) && chunk.mesh.visible)).toBe(true);
  expect(remove).not.toHaveBeenCalled();
  const policy = terrainDetailPolicy(QUALITY_PROFILES['quest-high']);
  for (let i = 0; i < 180; i++) {
    streamer.update(0, focus); await flushBuild();
    expect(attached.size).toBeLessThanOrEqual(policy.residentTiles);
    expect([...attached].reduce((n, chunk) => n + chunk.totalVertices, 0)).toBeLessThanOrEqual(policy.residentVertices);
  }
  expect(remove).toHaveBeenCalled();
  expect([...((streamer as any).wanted.keys())].every(key => (streamer as any).chunks.has(key))).toBe(true);
  streamer.dispose();
});
