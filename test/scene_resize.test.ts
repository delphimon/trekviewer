import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SceneManager } from '../src/core/SceneManager.ts';

afterEach(()=>vi.unstubAllGlobals());

it('leaves XR framebuffer sizing to the runtime and fits the latest panel size after exit',()=>{
  vi.stubGlobal('window',{innerWidth:1200,innerHeight:800});
  const camera=new THREE.PerspectiveCamera(60,1,.1,10000),projection=camera.projectionMatrix.clone();
  const setSize=vi.fn(),renderer={xr:{isPresenting:true},setSize};
  const scene=Object.assign(Object.create(SceneManager.prototype),{camera,renderer});
  scene.onWindowResize();
  expect(setSize).not.toHaveBeenCalled();
  expect(camera.projectionMatrix.equals(projection)).toBe(true);
  window.innerWidth=600;window.innerHeight=900;
  renderer.xr.isPresenting=false;
  scene.onWindowResize();
  expect(setSize).toHaveBeenCalledExactlyOnceWith(600,900);
  expect(camera.aspect).toBe(2/3);
  expect(camera.projectionMatrix.equals(projection)).toBe(false);
});
