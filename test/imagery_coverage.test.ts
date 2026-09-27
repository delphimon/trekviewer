import { expect, it } from 'vitest';
import * as THREE from 'three';
import { computeCoherentLODTiles, computeFirstPersonCoherentLODTiles, getChildTileKeys, getTileKey, ImageryLODManager, type ImageryPatch } from '../src/terrain/ImageryLODManager.ts';

const bounds = { minLat:46.8,maxLat:46.9,minLon:-121.8,maxLon:-121.7,centerLat:46.85,centerLon:-121.75,widthMeters:7600,depthMeters:11100,minEle:0,maxEle:1000,elevationSpan:1000 };
function patch(key:string):ImageryPatch {
  const [,z,x,y]=key.split(':');
  const mesh=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
  const texture=new THREE.Texture();
  return {key,zoom:+z,x:+x,y:+y,mesh,texture,lastUsed:0,centerDist:0,creationTime:0,isFading:false,fadeDurationMs:0,
    dispose:()=>{mesh.geometry.dispose();mesh.material.dispose();texture.dispose();}};
}
const makeManager=()=>new ImageryLODManager({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,enableFadeIn:false});

it.each(['tabletop','first-person'] as const)('reveals every selected tile when the real %s footprint finishes loading',mode=>{
  const manager=makeManager();
  const state=manager as any;
  const candidates=mode==='tabletop'
    ? computeCoherentLODTiles(46.85,-121.75,14,52,bounds)
    : computeFirstPersonCoherentLODTiles(46.85,-121.75,46.86,-121.74,14,52,bounds);
  expect(candidates.length).toBeGreaterThan(4);
  state.currentTargetZoom=14;
  for(const c of candidates){
    const key=getTileKey('satellite',c.zoom,c.x,c.y);
    state.desiredTileKeys.add(key);state.patches.set(key,patch(key));
  }
  try {
    manager.updatePatchVisibility();
    expect(manager.getDiagnostics().coveragePercent).toBe(100);
    expect(manager.getDiagnostics().visibleCount).toBe(candidates.length);
  } finally {manager.dispose();}
});

it('promotes a selected perimeter group atomically without waiting for unselected siblings',()=>{
  const manager=makeManager(),state=manager as any;
  const keys=getChildTileKeys('satellite',13,1325,2887);
  state.desiredTileKeys=new Set(keys.slice(0,2));
  state.patches.set(keys[0],patch(keys[0]));
  try {
    manager.updatePatchVisibility();
    expect(state.patches.get(keys[0]).mesh.visible).toBe(false);
    state.patches.set(keys[1],patch(keys[1]));manager.updatePatchVisibility();
    expect(manager.getDiagnostics().visibleCount).toBe(2);
  } finally {manager.dispose();}
});

it('restores desired coarse imagery and allows eviction after its children leave the footprint',()=>{
  const manager=makeManager(),state=manager as any;
  const parent=getTileKey('satellite',13,1325,2887);
  const children=getChildTileKeys('satellite',13,1325,2887);
  state.patches.set(parent,patch(parent));
  for(const key of children)state.patches.set(key,patch(key));
  state.desiredTileKeys=new Set(children);manager.updatePatchVisibility();
  expect(state.patches.get(parent).mesh.visible).toBe(false);
  try {
    state.desiredTileKeys=new Set([parent]);manager.updatePatchVisibility();
    expect(state.patches.get(parent).mesh.visible).toBe(true);
    const removed=state.patches.get(children[3]);removed.dispose();state.patches.delete(children[3]);
    manager.updatePatchVisibility();
    expect(state.hasPendingChildren(parent)).toBe(false);
  } finally {manager.dispose();}
});
