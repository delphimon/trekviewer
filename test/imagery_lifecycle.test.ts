import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { TileImageCache } from '../src/terrain/TileImageCache.ts';
import { TerrainImagery } from '../src/terrain/TerrainImagery.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { releaseGraphicsResources } from '../src/core/GraphicsResources.ts';
import { composeImagery, MAX_COMPOSITE_TILES } from '../src/terrain/CompositeImagery.ts';
import { EsriWorldImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

const grid = { zoom: 14, tileXMin: 0, tileXMax: 3, tileYMin: 0, tileYMax: 4, numTilesX: 4, numTilesY: 5 };
const image = { width: 256, height: 256 } as HTMLImageElement;
const methods = ['fetchSatelliteTexture', 'fetchHybridTexture', 'fetchTopoTexture'] as const;
let canvases: any[];
function canvas(): HTMLCanvasElement {
  const value = { width: 1024, height: 1024, getContext: () => context };
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
  canvases.push(value);
  return value as unknown as HTMLCanvasElement;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  canvases = [];
  vi.stubGlobal('document', { createElement: vi.fn(canvas) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(methods)('%s frees an entirely failed composition without publishing fallback-only uploads', async method => {
  vi.spyOn(TileImageCache, 'loadTile').mockRejectedValue(new Error('missing tile'));
  const dispose = vi.spyOn(THREE.Texture.prototype, 'dispose');
  const progress = vi.fn(), fallback = canvas();
  expect(await TextureProvider[method](grid, progress, undefined, false, fallback as any)).toBeNull();
  expect(progress).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(canvases.at(-1)).toMatchObject({ width: 1, height: 1 });
  expect(fallback).toMatchObject({ width: 1024, height: 1024 });
});

it.each(methods)('%s stops drawing and frees its canvas when a late tile resolves after cancellation', async method => {
  const request = deferred<HTMLImageElement>();
  const load = vi.spyOn(TileImageCache, 'loadTile').mockReturnValue(request.promise);
  const progress = vi.fn(), abort = new AbortController();
  const result = TextureProvider[method](grid, progress, abort.signal);
  await flush(); expect(load).toHaveBeenCalledTimes(12);
  abort.abort(); request.resolve(image);
  expect(await result).toBeNull();
  expect(load).toHaveBeenCalledTimes(12); // no new tiles or Hybrid labels after cancellation
  expect(canvases[0].getContext().drawImage).not.toHaveBeenCalled();
  expect(canvases[0]).toMatchObject({ width: 1, height: 1 });
  expect(progress).not.toHaveBeenCalled();
});

it('does not allocate or request imagery when already canceled', async () => {
  const load = vi.spyOn(TileImageCache, 'loadTile');
  const abort = new AbortController(); abort.abort();
  expect(await TextureProvider.fetchSatelliteTexture(grid, undefined, abort.signal)).toBeNull();
  expect(canvases).toHaveLength(0); expect(load).not.toHaveBeenCalled();
});

it('rejects oversized or inconsistent grids before canvas allocation or tile requests', async () => {
  const load = vi.spyOn(TileImageCache, 'loadTile');
  for (const invalid of [
    { ...grid, tileXMax: 99, tileYMax: 99, numTilesX: 100, numTilesY: 100 },
    { ...grid, numTilesX: 100 }, { ...grid, tileXMax: Infinity }, { ...grid, zoom: -1 },
  ]) {
    await expect(composeImagery({ grid: invalid, provider: new EsriWorldImageryProvider(), timeoutMs: 4500, isXR: false, anisotropy: 4, uploadIntervalMs: 600, uploadBatchSize: 8 })).rejects.toThrow('imagery grid');
  }
  expect(canvases).toHaveLength(0); expect(load).not.toHaveBeenCalled();
});

it('keeps wide polar-route overview imagery within its tile budget and preserves Mercator coverage', () => {
  const bounds = { minLat: 81.4, maxLat: 82.4, minLon: -25, maxLon: -17, centerLat: 81.9, centerLon: -21, widthMeters: 120000, depthMeters: 120000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
  const polar = TextureProvider.getTileGridForBounds(bounds, 0.05);
  expect(polar.zoom).toBeLessThan(11);
  expect(polar.numTilesX * polar.numTilesY).toBeLessThanOrEqual(MAX_COMPOSITE_TILES);
  expect(polar.numTilesX).toBe(polar.tileXMax - polar.tileXMin + 1);
  expect(polar.numTilesY).toBe(polar.tileYMax - polar.tileYMin + 1);
  const center = TextureProvider.getUVForGeo(bounds.centerLat, bounds.centerLon, polar);
  expect(center.u).toBeGreaterThan(0); expect(center.u).toBeLessThan(1);
  expect(center.v).toBeGreaterThan(0); expect(center.v).toBeLessThan(1);
});

it('uploads only changed successful tiles and retains final mipmaps and anisotropy', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  let count = 0;
  vi.spyOn(TileImageCache, 'loadTile').mockImplementation(async () => {
    if (++count <= 8) return image;
    throw Error('missing tile');
  });
  const progress: { completed: number; mipmaps: boolean }[] = [];
  const result = await TextureProvider.fetchSatelliteTexture(grid, (texture, completed) => { progress.push({ completed, mipmaps: texture.generateMipmaps }); });
  expect(progress).toEqual([{ completed: 8, mipmaps: false }, { completed: 20, mipmaps: true }]);
  expect(result!.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  expect(result!.anisotropy).toBe(TextureProvider.getMaxAnisotropy());
  expect(result!.image).toMatchObject({ width: 1024, height: 1280 });
  result!.dispose();
});

it('shares pending and completed style requests and exposes inactive partial textures for graphics recovery', async () => {
  const partial = new THREE.CanvasTexture(canvas()), finished = deferred<THREE.CanvasTexture | null>();
  const load = vi.fn(async (_style, progress) => { progress(partial, 8, 20); return finished.promise; });
  const updates = vi.fn();
  const imagery = new TerrainImagery(load, updates);
  const first = imagery.acquire('topo', canvas() as any), second = imagery.acquire('topo', canvas() as any);
  expect(first).toBe(second); await flush(); expect(load).toHaveBeenCalledTimes(1);
  expect(imagery.peek('topo')).toBe(partial);
  expect(imagery.getGraphicsResources()).toEqual([partial]);
  releaseGraphicsResources([], undefined, imagery.getGraphicsResources());
  expect(partial.image).toMatchObject({ width: 1024, height: 1024 }); // context loss keeps CPU pixels
  finished.resolve(partial); expect(await first).toBe(partial);
  expect(imagery.acquire('topo', canvas() as any)).toBe(first);
  imagery.dispose(); expect(partial.image).toMatchObject({ width: 1, height: 1 });
});

it('aborts disposal without a route signal and releases late progressive and final results once', async () => {
  const pending = deferred<THREE.CanvasTexture | null>();
  let progress!: (texture: THREE.CanvasTexture, completed: number, total: number) => void;
  let signal!: AbortSignal;
  const imagery = new TerrainImagery(async (_style, callback, ownSignal) => { progress = callback; signal = ownSignal; return pending.promise; }, vi.fn());
  const request = imagery.acquire('hybrid', canvas() as any); await flush();
  const partial = new THREE.CanvasTexture(canvas()), late = new THREE.CanvasTexture(canvas());
  const partialDisposed = vi.fn(), lateDisposed = vi.fn();
  partial.addEventListener('dispose', partialDisposed); late.addEventListener('dispose', lateDisposed);
  progress(partial, 8, 20); imagery.dispose(); imagery.dispose();
  expect(signal.aborted).toBe(true);
  progress(late, 16, 20); pending.resolve(late);
  expect(await request).toBeNull();
  expect(partialDisposed).toHaveBeenCalledTimes(1); expect(lateDisposed).toHaveBeenCalledTimes(1);
  expect(imagery.getGraphicsResources()).toEqual([]);
  expect(partial.image).toMatchObject({ width: 1, height: 1 });
  expect(late.image).toMatchObject({ width: 1, height: 1 });
});

it('allows retry after a null result or thrown request and unlinks the parent signal', async () => {
  const parent = new AbortController(), remove = vi.spyOn(parent.signal, 'removeEventListener');
  const texture = new THREE.CanvasTexture(canvas());
  const load = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(Error('temporary')).mockResolvedValueOnce(texture);
  const imagery = new TerrainImagery(load, vi.fn(), parent.signal);
  expect(await imagery.acquire('satellite', canvas() as any)).toBeNull();
  await expect(imagery.acquire('satellite', canvas() as any)).rejects.toThrow('temporary');
  expect(await imagery.acquire('satellite', canvas() as any)).toBe(texture);
  expect(load).toHaveBeenCalledTimes(3); imagery.dispose();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('keeps committed imagery alive when its old load context is canceled for a replacement', async () => {
  const parent = new AbortController(), pending = deferred<THREE.CanvasTexture | null>();
  const texture = new THREE.CanvasTexture(canvas());
  let signal!: AbortSignal;
  const imagery = new TerrainImagery(async (_style, progress, ownSignal) => {
    signal = ownSignal; progress(texture, 8, 20); return pending.promise;
  }, vi.fn(), parent.signal);
  const request = imagery.acquire('satellite', canvas()); await flush();
  imagery.detachLoadSignal(); parent.abort();
  expect(signal.aborted).toBe(false);
  expect(texture.image).toMatchObject({ width: 1024, height: 1024 });
  pending.resolve(texture); expect(await request).toBe(texture);
  imagery.dispose(); expect(signal.aborted).toBe(true);
});

it('deduplicates initial Aerial and rapidly reselected Topo compositions while preserving the latest style', async () => {
  const sat = deferred<THREE.CanvasTexture | null>(), topo = deferred<THREE.CanvasTexture | null>();
  const satTexture = new THREE.CanvasTexture(canvas()), topoTexture = new THREE.CanvasTexture(canvas());
  const satellite = vi.spyOn(TextureProvider, 'fetchSatelliteTexture').mockReturnValue(sat.promise);
  let topoProgress!: (texture: THREE.CanvasTexture, completed: number, total: number) => void;
  let imagerySignal!: AbortSignal;
  const topographic = vi.spyOn(TextureProvider, 'fetchTopoTexture').mockImplementation((_grid, progress, signal) => { topoProgress = progress!; imagerySignal = signal!; return topo.promise; });
  vi.spyOn(TextureProvider, 'generateTopoTextureAsync').mockResolvedValue(new THREE.CanvasTexture(canvas()));
  vi.spyOn(ElevationTileService, 'sampleElevation').mockReturnValue({ isValid: true, elevation: 100 });
  const bounds = { minLat: 46.8, maxLat: 46.9, minLon: -121.8, maxLon: -121.7, centerLat: 46.85, centerLon: -121.75, widthMeters: 6000, depthMeters: 9000, minEle: 0, maxEle: 1000, elevationSpan: 1000 };
  const demGrid: any = { zoom: 12, isRealDEM: true, tileValidity: new Uint8Array([1]), minElevation: 0, maxElevation: 200 };
  const terrain = await TerrainGenerator.generate({ bounds, points: [{ lat: 46.85, lon: -121.75, ele: 200 }], minElevation: 0 } as any, undefined, undefined, 1, false, { demGrid, terrainGeoBounds: bounds, elevationSamplerForGeo: () => 100 }, 120);
  const firstTopo = terrain.setTextureStyle('topo'), aerial = terrain.setTextureStyle('satellite'), lastTopo = terrain.setTextureStyle('topo');
  await flush(); expect(satellite).toHaveBeenCalledTimes(1); expect(topographic).toHaveBeenCalledTimes(1);
  topoProgress(topoTexture, 8, 20);
  expect((terrain.terrainMesh.material as THREE.MeshStandardMaterial).map).toBe(topoTexture);
  sat.resolve(satTexture); await aerial;
  expect((terrain.terrainMesh.material as THREE.MeshStandardMaterial).map).toBe(topoTexture);
  expect(terrain.getGraphicsResources!()).toContain(topoTexture);
  topo.resolve(topoTexture); await Promise.all([firstTopo, lastTopo]);
  expect((terrain.terrainMesh.material as THREE.MeshStandardMaterial).map).toBe(topoTexture);
  terrain.dispose(); expect(imagerySignal.aborted).toBe(true);
  expect(satTexture.image).toMatchObject({ width: 1, height: 1 });
  expect(topoTexture.image).toMatchObject({ width: 1, height: 1 });
});
