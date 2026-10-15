import { expect, it } from 'vitest';
import * as THREE from 'three';
import { ImageryLODManager, getChildTileKeys, getTileKey, getTerrainViewRays, getViewMetrics, type ImageryPatch } from '../src/terrain/ImageryLODManager.ts';

const bounds = { minLat:46.8,maxLat:46.9,minLon:-121.8,maxLon:-121.7,centerLat:46.85,centerLon:-121.75,widthMeters:7600,depthMeters:11100,minEle:0,maxEle:1000,elevationSpan:1000 };
function patch(key: string): ImageryPatch {
  const [,z,x,y] = key.split(':');
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.visible = false;
  const texture = new THREE.Texture();
  return {key,zoom:+z,x:+x,y:+y,mesh,texture,lastUsed:performance.now(),centerDist:0,creationTime:0,isFading:false,fadeDurationMs:0,
    dispose:()=>{mesh.geometry.dispose();mesh.material.dispose();texture.dispose();}};
}
function fixture() {
  const manager = new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,enableInXR:true,enableFadeIn:false});
  const state = manager as any;
  const parent = getTileKey('satellite',18,84800,184800);
  const children = getChildTileKeys('satellite',18,84800,184800);
  for (const key of [parent,...children]) state.patches.set(key,patch(key));
  state.desiredTileKeys = new Set(children);
  manager.updatePatchVisibility();
  return {manager,state,parent,children};
}

it('keeps published detail visible through repeated head-turn selections and delayed replacement',()=>{
  const {manager,state,children} = fixture();
  try {
    for (let turn=0;turn<50;turn++) {
      state.desiredTileKeys = new Set(turn%2 ? children : [getTileKey('satellite',19,170000+turn,370000)]);
      manager.updatePatchVisibility();
      expect(children.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
    }
  } finally {manager.dispose();}
});

it('preserves published imagery while the view mode clears its request selection',()=>{
  const {manager,state,children} = fixture();
  try {
    manager.setViewMode('first-person');
    expect(children.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
    manager.setViewMode('diorama');
    expect(children.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
  } finally {manager.dispose();}
});

it('does not revoke a previously published perimeter tile when more siblings become desired',()=>{
  const {manager,state,children} = fixture();
  try {
    // Simulate eviction followed by a partial perimeter selection.
    for(const key of children.slice(1)){state.patches.get(key).dispose();state.patches.delete(key);}
    state.desiredTileKeys = new Set([children[0]]);
    manager.updatePatchVisibility();
    expect(state.patches.get(children[0]).mesh.visible).toBe(true);
    state.desiredTileKeys = new Set(children);
    manager.updatePatchVisibility();
    expect(state.patches.get(children[0]).mesh.visible).toBe(true);
  } finally {manager.dispose();}
});

it('restores the coarse fallback after one child is evicted without hiding the surviving detail',()=>{
  const {manager,state,parent,children} = fixture();
  try {
    state.patches.get(children[3]).dispose();state.patches.delete(children[3]);
    manager.updatePatchVisibility();
    expect(state.patches.get(parent).mesh.visible).toBe(true);
    expect(children.slice(0,3).every(key=>state.patches.get(key).mesh.visible)).toBe(true);
    // Even if the new footprint no longer requests the original parent.
    state.desiredTileKeys = new Set([getTileKey('satellite',19,170100,370100)]);
    manager.updatePatchVisibility();
    expect(state.patches.get(parent).mesh.visible).toBe(true);
  } finally {manager.dispose();}
});

it('keeps the resident budget bounded while preserving selected tiles under pressure',()=>{
  const {manager,state,children} = fixture();
  try {
    state.maxPatches=4;
    state.prunePatches(new Set(children));
    expect(state.patches.size).toBe(4);
    expect(children.every(key=>state.patches.has(key))).toBe(true);
    expect(children.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
  } finally {manager.dispose();}
});

it('does not evict and re-request selected children when the only spare resident is a fading parent',()=>{
  const {manager,state,parent,children}=fixture();
  try {
    state.maxPatches=4;
    state.enableFadeIn=true;
    for(const key of children)state.patches.get(key).isFading=true;
    manager.updatePatchVisibility();
    expect(state.hasPendingChildren(parent)).toBe(true);
    state.prunePatches(new Set(children));
    expect(state.patches.size).toBe(4);
    expect(children.every(key=>state.patches.has(key))).toBe(true);
  } finally {manager.dispose();}
});

it('does not expire published imagery when there is spare resident capacity',()=>{
  const {manager,state,children}=fixture();
  try {
    state.desiredTileKeys.clear();state.warmRetentionMs=1;
    for(const p of state.patches.values()){p.lastUsed=-1_000_000;p.centerDist=100;}
    state.prunePatches(new Set());
    expect(children.every(key=>state.patches.has(key)&&state.patches.get(key).mesh.visible)).toBe(true);
  } finally {manager.dispose();}
});

it('hides all covered ancestors even when an intermediate patch has been evicted',()=>{
  const {manager,state,parent,children} = fixture();
  try {
    const fine = children.flatMap(key=>{
      const [,z,x,y]=key.split(':');return getChildTileKeys('satellite',+z,+x,+y);
    });
    for(const key of fine)state.patches.set(key,patch(key));
    state.desiredTileKeys=new Set(fine);manager.updatePatchVisibility();
    for(const key of children){state.patches.get(key).dispose();state.patches.delete(key);}
    manager.updatePatchVisibility();
    expect(state.patches.get(parent).mesh.visible).toBe(false);
    expect(fine.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
  } finally {manager.dispose();}
});

it('samples both asymmetric eye projections at their real world positions',()=>{
  const eyes=[-.032,.032].map((x,i)=>{
    const eye=new THREE.PerspectiveCamera(80,1.1,.1,2000);
    eye.position.set(x,1.65,2);
    eye.rotation.set(-.2,.4,.1);
    eye.projectionMatrix.elements[8]=i===0 ? -.25 : .25;
    eye.projectionMatrix.elements[9]=.15;
    eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    eye.updateWorldMatrix(true,false);
    eye.viewport=new THREE.Vector4(i*1200,0,1200,1300);
    return eye;
  });
  const camera=new THREE.ArrayCamera(eyes);
  const offsets=[[0,0],[-1,1],[1,-1]] as const;
  const rays=getTerrainViewRays(camera,offsets);
  expect(rays.length).toBe(6);
  rays.forEach((ray,i)=>{
    const eye=eyes[i%2],offset=offsets[Math.floor(i/2)];
    expect(ray.ray.origin.distanceTo(eye.position)).toBeLessThan(1e-10);
    const clip=ray.ray.at(10,new THREE.Vector3()).project(eye);
    expect(clip.x).toBeCloseTo(offset[0],10);
    expect(clip.y).toBeCloseTo(offset[1],10);
  });
  const renderer={xr:{isPresenting:true,getBaseLayer:()=>({framebufferHeight:2600})},domElement:{},getDrawingBufferSize:(v:THREE.Vector2)=>v.set(2400,2600)} as any;
  expect(getViewMetrics(camera,renderer).viewportHeightPx).toBe(1300);
});

it('does not admit unselected or incomplete new groups while keeping old published coverage',()=>{
  const {manager,state,children}=fixture();
  const newKeys=getChildTileKeys('satellite',18,85000,185000);
  try {
    state.patches.set(newKeys[0],patch(newKeys[0]));
    state.desiredTileKeys=new Set(newKeys);
    manager.updatePatchVisibility();
    expect(state.patches.get(newKeys[0]).mesh.visible).toBe(false);
    expect(children.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
    state.desiredTileKeys.clear();manager.updatePatchVisibility();
    expect(state.patches.get(newKeys[0]).mesh.visible).toBe(false);
    expect(children.every(key=>state.patches.get(key).mesh.visible)).toBe(true);
  } finally {manager.dispose();}
});

it('orders overlapping imagery from coarse to fine while keeping the trail above both',()=>{
  const manager=new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,enableFadeIn:false});
  const state=manager as any;
  try {
    const image={width:256,height:256} as HTMLCanvasElement;
    const keys=[getTileKey('satellite',18,84800,184800),getTileKey('satellite',19,169600,369600)];
    state.desiredTileKeys=new Set(keys);
    state.createAndMountPatch(keys[0],18,84800,184800,image,0,0);
    state.createAndMountPatch(keys[1],19,169600,369600,image,0,0);
    const coarse=state.patches.get(keys[0]).mesh,fine=state.patches.get(keys[1]).mesh;
    expect(fine.renderOrder).toBeGreaterThan(coarse.renderOrder);
    expect(fine.renderOrder).toBeLessThan(5);
    expect(fine.material.polygonOffsetFactor).toBeLessThan(coarse.material.polygonOffsetFactor);
    expect(fine.material.polygonOffsetFactor).toBeGreaterThan(-2);
    expect(coarse.visible&&fine.visible).toBe(true);
  } finally {manager.dispose();}
});
