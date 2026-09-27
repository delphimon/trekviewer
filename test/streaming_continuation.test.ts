import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { TileImageCache, TilePriority } from '../src/terrain/TileImageCache.ts';
import { EsriWorldImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';

const provider = new EsriWorldImageryProvider();
const bounds = {minLat:46.8,maxLat:46.9,minLon:-121.8,maxLon:-121.7,centerLat:46.85,centerLon:-121.75,widthMeters:6000,depthMeters:9000,minEle:0,maxEle:1000,elevationSpan:1000};
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (error:Error)=>void;
  const promise = new Promise<T>((r,j)=>{resolve=r;reject=j;});
  return {promise,resolve,reject};
}
const img = (src='https://example.test/tile.png') => ({src,width:256,height:256,naturalWidth:256,naturalHeight:256}) as HTMLImageElement;
const flush = async()=>{for(let i=0;i<10;i++) await Promise.resolve();};
afterEach(()=>{vi.restoreAllMocks();TileImageCache.clear();TileImageCache.setTargetDevice(false);});

it('recovers a stationary tile after the cache cooldown without retrying on every frame or movement',async()=>{
  let now=100;
  vi.spyOn(performance,'now').mockImplementation(()=>now);
  vi.spyOn(TileImageCache,'getRetryDelayMs').mockReturnValue(15000);
  const load=vi.spyOn(ImageryLODManager,'loadPatchImage').mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(img());
  const manager:any=new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0});
  const evaluate=vi.spyOn(manager,'evaluateLOD').mockImplementation(()=>{});
  const mount=vi.spyOn(manager,'createAndMountPatch').mockImplementation(()=>{});
  const camera=new THREE.PerspectiveCamera(),root=new THREE.Group();
  const candidates=[{x:1325,y:2887,zoom:14,dist:0}];
  try {
    manager.update(camera,root);
    manager.reconcileDesiredTiles(candidates,provider,14);await flush();
    for(now=200;now<=15100;now+=100){
      manager.update(camera,root);
      manager.reconcileDesiredTiles(candidates,provider,14);
    }
    expect(load).toHaveBeenCalledTimes(1);
    now=15101;manager.update(camera,root);await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(manager.failedRequests.size).toBe(0);
  } finally {manager.dispose();}
});

it.each(['style','mode','dispose','focus'] as const)('cancels delayed retries when %s changes',async(change)=>{
  let now=100;
  vi.spyOn(performance,'now').mockImplementation(()=>now);
  const load=vi.spyOn(ImageryLODManager,'loadPatchImage').mockRejectedValue(new Error('offline'));
  const manager:any=new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0});
  vi.spyOn(manager,'evaluateLOD').mockImplementation(()=>{});
  vi.spyOn(manager,'evaluateFirstPersonLOD').mockImplementation(()=>{});
  try {
    manager.reconcileDesiredTiles([{x:1325,y:2887,zoom:14,dist:0}],provider,14);await flush();
    if(change==='style')await manager.setTextureStyle('topo');
    if(change==='mode')manager.setViewMode('first-person');
    if(change==='dispose')manager.dispose();
    if(change==='focus')manager.reconcileDesiredTiles([],provider,14);
    now=100000;manager.update(new THREE.PerspectiveCamera(),new THREE.Group());await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(manager.failedRequests.size).toBe(0);
  } finally {manager.dispose();}
});

it('preserves a queued retry when reconciliation happens before a scheduler slot opens',async()=>{
  let now=100;
  vi.spyOn(performance,'now').mockImplementation(()=>now);
  const blocker=deferred<HTMLImageElement>();
  const load=vi.spyOn(ImageryLODManager,'loadPatchImage')
    .mockRejectedValueOnce(new Error('temporary')).mockReturnValueOnce(blocker.promise).mockResolvedValue(img());
  const manager:any=new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,maxConcurrency:1});
  const mount=vi.spyOn(manager,'createAndMountPatch').mockImplementation(()=>{});
  const candidates=[{x:1325,y:2887,zoom:14,dist:0},{x:1326,y:2887,zoom:14,dist:1}];
  try {
    manager.reconcileDesiredTiles(candidates,provider,14);await flush();
    expect(load).toHaveBeenCalledTimes(2);
    now=1100;manager.retryFailedTiles(now);
    manager.reconcileDesiredTiles(candidates,provider,14);
    blocker.resolve(img());await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(mount).toHaveBeenCalledTimes(2);
  } finally {manager.dispose();}
});

it('reuses scheduler slots immediately after cancellation and ignores stale completions',async()=>{
  const loads: ReturnType<typeof deferred<HTMLImageElement>>[]=[];
  const load=vi.spyOn(ImageryLODManager,'loadPatchImage').mockImplementation(()=>{
    const request=deferred<HTMLImageElement>();loads.push(request);return request.promise;
  });
  const manager:any=new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,maxConcurrency:1});
  manager.maxConcurrency=1;
  const mount=vi.spyOn(manager,'createAndMountPatch').mockImplementation(()=>{});
  try {
    for(let x=100;x<104;x++) {
      manager.reconcileDesiredTiles([{x,y:100,zoom:19,dist:10}],provider,19);
      expect(load).toHaveBeenCalledTimes(x-99);
      expect(manager.getDiagnostics().inFlightRequests).toBe(1);
    }
    // Older requests may finish after a new request occupies their slot.
    loads[0].resolve(img());loads[1].reject(new Error('aborted'));loads[2].resolve(img());
    await flush();
    expect(manager.getDiagnostics().inFlightRequests).toBe(1);
    expect(mount).not.toHaveBeenCalled();
    loads[3].resolve(img());await flush();
    expect(manager.getDiagnostics().inFlightRequests).toBe(0);
    expect(mount).toHaveBeenCalledTimes(1);
  } finally {manager.dispose();}
});

it('retains decoded images borrowed by live GPU textures after cache eviction or clear',()=>{
  TileImageCache.setLimits(1,1024*1024);
  const first=img(),second=img('https://example.test/second.png');
  const texture=new THREE.Texture(first);
  TileImageCache.set('first',first);TileImageCache.set('second',second);
  expect(TileImageCache.has('first')).toBe(false);
  expect(texture.image.src).toBe('https://example.test/tile.png');
  TileImageCache.clear();expect(second.src).toBe('https://example.test/second.png');
  expect(TileImageCache.getEstimatedDecodedBytes()).toBe(0);texture.dispose();
});

it.each(['resolve','reject'] as const)('isolates cache generations when old requests %s after clear',async(completion)=>{
  const old=deferred<HTMLImageElement>(),current=deferred<HTMLImageElement>();
  vi.spyOn(TileImageCache as any,'loadImageWithTimeout').mockReturnValueOnce(old.promise).mockReturnValue(current.promise);
  // One URL prevents unrelated fallback requests in the failure case.
  const source={...provider,id:'generation',displayName:'test',attribution:'',maxZoom:19,getTileUrls:()=>['https://example.test/tile.png']};
  const first=TileImageCache.loadTile(source,19,1,1,1000,undefined,TilePriority.HIGH).catch(()=>null);
  TileImageCache.clear();
  const second=TileImageCache.loadTile(source,19,1,1,1000,undefined,TilePriority.HIGH);
  if(completion==='resolve') old.resolve(img('old')); else old.reject(new Error('old failure'));
  await first;await flush();
  expect(TileImageCache.getInFlightCount()).toBe(1);
  expect(TileImageCache.getStats().activeRequestsByClass.high).toBe(1);
  expect(TileImageCache.size()).toBe(0);
  expect(TileImageCache.getFailureCount()).toBe(0);
  current.resolve(img('new'));await second;await flush();
  expect(TileImageCache.getInFlightCount()).toBe(0);
  expect(TileImageCache.getStats().activeRequestsByClass.high).toBe(0);
  expect(TileImageCache.get(TileImageCache.getTileKey(source.id,19,1,1))?.src).toBe('new');
});

it('finishes the current style status without an old style completion overwriting it',async()=>{
  const canvas={width:1,height:1} as any;
  vi.spyOn(TextureProvider,'generateTopoTexture').mockReturnValue(new THREE.CanvasTexture(canvas));
  vi.spyOn(TextureProvider,'fetchSatelliteTexture').mockResolvedValue(new THREE.CanvasTexture(canvas));
  const topo=deferred<THREE.CanvasTexture|null>();
  vi.spyOn(TextureProvider,'fetchTopoTexture').mockReturnValue(topo.promise);
  vi.spyOn(ElevationTileService,'sampleElevation').mockReturnValue({isValid:true,elevation:100});
  const progress=vi.fn();
  const grid:any={zoom:12,isRealDEM:true,tileValidity:new Uint8Array([1]),minElevation:0,maxElevation:200};
  const terrain=await TerrainGenerator.generate({bounds,points:[{lat:46.85,lon:-121.75,ele:200}],minElevation:0} as any,
    progress,undefined,1,false,{demGrid:grid,terrainGeoBounds:bounds,elevationSamplerForGeo:()=>100});
  await flush();
  const oldStyle=terrain.setTextureStyle('topo');
  expect(progress.mock.lastCall?.[0]).toContain('Fetching USGS');
  await terrain.setTextureStyle('satellite');
  expect(progress.mock.lastCall).toEqual(['Aerial view active.',1]);
  progress.mockClear();topo.resolve(new THREE.CanvasTexture(canvas));await oldStyle;
  expect(progress).not.toHaveBeenCalled();terrain.dispose();
});
