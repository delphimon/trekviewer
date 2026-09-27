import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildSurfacePatchGeometry } from '../src/terrain/SurfacePatchGeometry.ts';
import { LocalTerrainStreamer } from '../src/terrain/LocalTerrainStreamer.ts';
import { LocalTerrainChunk } from '../src/terrain/LocalTerrainChunk.ts';
import { ElevationTileService } from '../src/terrain/ElevationTiles.ts';
import { TerrainGenerator } from '../src/terrain/TerrainGenerator.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { ImageryLODManager } from '../src/terrain/ImageryLODManager.ts';
import { QUALITY_PROFILES } from '../src/terrain/QualityProfile.ts';
import { DesktopOverlay } from '../src/ui/DesktopOverlay.ts';
import { CesiumBingImageryProvider } from '../src/terrain/providers/ImageryProvider.ts';
import { FlyoverController } from '../src/visualization/FlyoverController.ts';

const bounds = {minLat:46.84,maxLat:46.86,minLon:-121.76,maxLon:-121.74,centerLat:46.85,centerLon:-121.75,widthMeters:1500,depthMeters:1500,minEle:0,maxEle:200,elevationSpan:200};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('promotes a delayed focus once despite 72 waiting frames', async () => {
  vi.spyOn(ElevationTileService,'sampleElevation').mockReturnValue({isValid:true,elevation:100});
  let resolve!: (grid:any)=>void;
  const pending = new Promise<any>(r=>resolve=r);
  const attached: LocalTerrainChunk[] = [];
  const terrain:any = {terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>100,
    attachLocalChunk:(c:any)=>attached.push(c),detachLocalChunk:(c:any)=>c.dispose(),notifySurfaceChange:vi.fn()};
  const streamer:any = new LocalTerrainStreamer({terrainResult:terrain,routeGeometry:{totalDistance:0} as any,demGrid:{} as any,qualityProfile:{...QUALITY_PROFILES['quest-high'],localDemSegments:8}});
  vi.spyOn(streamer,'fetchStationDEM').mockReturnValue(pending);
  for(let frame=0;frame<72;frame++) streamer.update(0,{lat:46.85,lon:-121.75});
  resolve({zoom:15,isRealDEM:true});
  await Promise.resolve(); await Promise.resolve();
  expect(attached.length).toBe(1);
  expect(terrain.notifySurfaceChange).toHaveBeenCalledTimes(1);
  streamer.dispose();
});

it.each([100, 300])('renders and samples the same refined surface at DEM height %s', async (localHeight) => {
  vi.spyOn(TextureProvider,'generateTopoTexture').mockReturnValue(new THREE.CanvasTexture({width:1,height:1} as any));
  vi.spyOn(TextureProvider,'fetchSatelliteTexture').mockResolvedValue(null);
  const base:any = {zoom:12,isRealDEM:true,tileValidity:new Uint8Array([1]),minElevation:0,maxElevation:200};
  const local:any = {...base,zoom:15};
  vi.spyOn(ElevationTileService,'sampleElevation').mockImplementation((g)=>({isValid:true,elevation:g===local?localHeight:200}));
  const terrain = await TerrainGenerator.generate({bounds,points:[{lat:46.85,lon:-121.75,ele:200}],minElevation:0} as any,undefined,undefined,1,false,{demGrid:base,terrainGeoBounds:bounds,elevationSamplerForGeo:()=>200});
  const chunk = new LocalTerrainChunk({localGrid:local,centerLat:46.85,centerLon:-121.75,terrainBaseElevation:terrain.terrainBaseElevation,radiusMeters:300,segments:8,baseMeshGrid:terrain.baseMeshGrid,baseElevationSampler:terrain.sampleBaseSurfaceY});
  terrain.attachLocalChunk!(chunk);
  terrain.group.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(new THREE.Vector3(0,1000,0),new THREE.Vector3(0,-1,0)).intersectObjects([terrain.terrainMesh,chunk.mesh]);
  expect(terrain.sampleRenderedSurfaceY!(0,0)).toBe(localHeight + 30);
  expect(hits[0].point.y).toBeCloseTo(terrain.sampleRenderedSurfaceY!(0,0), 3);
  const b = chunk.getSurfaceBounds();
  for (let i=0; i<=20; i++) {
    const x=b.minX+(b.maxX-b.minX)*i/20;
    expect(chunk.sampleLocalSurfaceY(x,b.minZ)).toBeCloseTo(terrain.sampleBaseSurfaceY!(x,b.minZ),3);
  }
  const index = terrain.terrainMesh.geometry.index;
  const patch = buildSurfacePatchGeometry(terrain.terrainMesh,b,(x,z)=>({u:x,v:z}))!;
  const patchMesh = new THREE.Mesh(patch, new THREE.MeshBasicMaterial());
  const patchHits = new THREE.Raycaster(new THREE.Vector3(0,1000,0),new THREE.Vector3(0,-1,0)).intersectObject(patchMesh);
  expect(patchHits[0].point.y).toBeCloseTo(hits[0].point.y + .04, 3);
  terrain.setVerticalExaggeration(2);
  terrain.group.updateMatrixWorld(true);
  const scaledHits = new THREE.Raycaster(new THREE.Vector3(0,2000,0),new THREE.Vector3(0,-1,0)).intersectObjects([terrain.terrainMesh,chunk.mesh]);
  expect(scaledHits[0].point.y).toBeCloseTo(terrain.sampleRenderedSurfaceY!(0,0)*2,3);
  terrain.detachLocalChunk!(chunk);
  expect(terrain.terrainMesh.geometry.index).toBe(index);
  expect(terrain.terrainMesh.geometry.drawRange.count).toBe(index!.count);
  expect(terrain.sampleRenderedSurfaceY!(0,0)).toBe(230);
  patch.dispose(); patchMesh.material.dispose();
  terrain.dispose();
});

it('reevaluates LOD for tabletop translation, rotation, and pointer-only movement', () => {
  const manager:any = new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0});
  const evaluate = vi.spyOn(manager,'evaluateLOD').mockImplementation(()=>{});
  let now=1000; vi.spyOn(performance,'now').mockImplementation(()=>now);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0,1,2); camera.lookAt(0,0,0);
  const root = new THREE.Group(); root.scale.setScalar(.001);
  manager.update(camera,root);
  root.position.x=1; root.rotation.y=1;
  manager.setActiveInteractionRay(new THREE.Ray(new THREE.Vector3(1,1,1),new THREE.Vector3(0,-1,0)));
  now+=1000; manager.update(camera,root);
  expect(evaluate).toHaveBeenCalledTimes(2);
  manager.setActiveInteractionRay(new THREE.Ray(new THREE.Vector3(2,1,1),new THREE.Vector3(0,-1,0)));
  now+=1000; manager.update(camera,root);
  expect(evaluate).toHaveBeenCalledTimes(3);
  now+=1000; manager.update(camera,root);
  expect(evaluate).toHaveBeenCalledTimes(3);
  root.rotation.y+=1;
  now+=1000; manager.update(camera,root);
  expect(evaluate).toHaveBeenCalledTimes(4);
  manager.dispose();
});

it('reevaluates texture detail after a stationary style change', async () => {
  const manager:any = new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0});
  const evaluate = vi.spyOn(manager,'evaluateLOD').mockImplementation(()=>{});
  let now=1000; vi.spyOn(performance,'now').mockImplementation(()=>now);
  const camera = new THREE.PerspectiveCamera(); const root = new THREE.Group();
  manager.update(camera,root);
  await manager.setTextureStyle('topo');
  now+=1000; manager.update(camera,root);
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(manager.desiredTileKeys.size).toBe(0);
  manager.dispose();
});

it('renders imported waypoint names as literal text', () => {
  const elements:any[]=[];
  const section:any={style:{}}; const list:any={appendChild:(e:any)=>elements.push(e)};
  vi.stubGlobal('document',{getElementById:(id:string)=>id==='landmarksSection'?section:id==='landmarksList'?list:null,createElement:()=>({children:[] as any[],appendChild(child:any){this.children.push(child)},addEventListener:()=>{}})});
  const overlay:any=Object.create(DesktopOverlay.prototype); overlay.callbacks={};
  const payload='<img src=x onerror="window.__reviewProof=1">';
  overlay.updateLandmarks({landmarks:[],waypoints:[{name:payload,lat:46.85,lon:-121.75,ele:100}]});
  expect(elements[0].innerHTML).toBeUndefined();
  expect(elements[0].children[0].textContent).toContain(payload);
});

it('bounds provider startup even when fetch never settles', async () => {
  vi.useFakeTimers(); vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));
  const provider=new CesiumBingImageryProvider('test-public-token');
  let settled=false; provider.init().then(()=>settled=true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(settled).toBe(true);
  expect(await provider.init()).toBe(false);
  expect((fetch as any).mock.calls[0][1].signal.aborted).toBe(true);
});

it('preserves user turning across paused updates and sharp route bends', () => {
  const trail:any={routeGeometry:{getTelemetryAtProgress:()=>({position:new THREE.Vector3(100,100,100)}),getRouteForwardAtProgress:()=>new THREE.Vector3(0,0,-1)}};
  const flyover=new FlyoverController(trail,{totalPlaybackSeconds:100} as any);
  flyover.setViewMode('first-person');
  const root=new THREE.Group();
  flyover.turn(1);
  flyover.update(1/72,new THREE.PerspectiveCamera(),root,true);
  expect(root.rotation.y).toBe(1);
  trail.routeGeometry.getRouteForwardAtProgress=()=>new THREE.Vector3(1,0,0);
  flyover.update(1/72,new THREE.PerspectiveCamera(),root,true);
  expect(root.rotation.y).toBe(1);
});

it.each(['mode', 'dispose', 'new-focus'])('rejects stale focus work after %s', async (change) => {
  vi.spyOn(ElevationTileService,'sampleElevation').mockReturnValue({isValid:true,elevation:100});
  let resolve!: (grid:any)=>void;
  const pending=new Promise<any>(r=>resolve=r);
  const terrain:any={terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>100,
    attachLocalChunk:vi.fn(),detachLocalChunk:vi.fn(),notifySurfaceChange:vi.fn()};
  const streamer=new LocalTerrainStreamer({terrainResult:terrain,routeGeometry:{totalDistance:0} as any,
    demGrid:{} as any,qualityProfile:{...QUALITY_PROFILES['quest-high'],localDemSegments:8}});
  vi.spyOn(streamer,'fetchStationDEM').mockReturnValueOnce(pending).mockReturnValue(new Promise(()=>{}));
  streamer.update(0,{lat:46.85,lon:-121.75});
  if(change==='mode') streamer.setViewMode('first-person');
  if(change==='dispose') streamer.dispose();
  if(change==='new-focus') streamer.update(0,{lat:46.86,lon:-121.75});
  resolve({zoom:15,isRealDEM:true});
  await Promise.resolve(); await Promise.resolve();
  expect(terrain.attachLocalChunk).not.toHaveBeenCalled();
  streamer.dispose();
});

it('imagery retains a terrain triangle ridge between patch vertices and matching normals', () => {
  const geo=new THREE.PlaneGeometry(10,10,2,2); geo.rotateX(-Math.PI/2);
  const pos=geo.attributes.position; pos.setY(4,7); geo.computeVertexNormals();
  const base=new THREE.Mesh(geo,new THREE.MeshBasicMaterial());
  const patch=buildSurfacePatchGeometry(base,{minX:-4,maxX:4,minZ:-4,maxZ:4},(x,z)=>({u:(x+4)/8,v:(z+4)/8}))!;
  const mesh=new THREE.Mesh(patch,new THREE.MeshBasicMaterial());
  for(const [x,z] of [[0,0],[1,2],[-2,1],[3,-2]]) {
    const ray=new THREE.Raycaster(new THREE.Vector3(x,100,z),new THREE.Vector3(0,-1,0));
    const terrainHit=ray.intersectObject(base)[0], overlayHit=ray.intersectObject(mesh)[0];
    expect(overlayHit.point.y).toBeCloseTo(terrainHit.point.y+.04,5);
    expect(overlayHit.normal!.distanceTo(terrainHit.normal!)).toBeLessThan(.0001);
  }
  const p=patch.attributes.position, uv=patch.attributes.uv;
  for(let i=0;i<p.count;i++) {
    expect(p.getX(i)).toBeGreaterThanOrEqual(-4); expect(p.getX(i)).toBeLessThanOrEqual(4);
    expect(uv.getX(i)).toBeGreaterThanOrEqual(0); expect(uv.getX(i)).toBeLessThanOrEqual(1);
  }
  patch.dispose(); geo.dispose(); mesh.material.dispose(); base.material.dispose();
});

it('shares interior imagery vertices at the full Quest refinement resolution', () => {
  const geo=new THREE.PlaneGeometry(2500,2500,128,128);geo.rotateX(-Math.PI/2);
  const base=new THREE.Mesh(geo,new THREE.MeshBasicMaterial());
  const start=performance.now();
  const patch=buildSurfacePatchGeometry(base,{minX:-1250,maxX:1250,minZ:-1250,maxZ:1250},(x,z)=>({u:x/2500+.5,v:z/2500+.5}))!;
  const elapsed=performance.now()-start;
  expect(patch.attributes.position.count).toBe(129*129);
  expect(patch.index!.count).toBe(128*128*6);
  if(process.env.TREK_PERF) console.log(`Full 128x128 source: ${patch.attributes.position.count} vertices, ${elapsed.toFixed(2)} ms CPU construction on this host (not Quest timing)`);
  patch.dispose();geo.dispose();base.material.dispose();
});
