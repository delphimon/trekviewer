import { it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { TrekViewerApp } from '../src/main.ts';
import { TextureProvider } from '../src/terrain/TextureProvider.ts';
import { XRManager } from '../src/core/XRManager.ts';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('keeps a dragged HUD fixed when the headset moves, and explicitly summons it',()=>{
  const camera=new THREE.PerspectiveCamera();camera.position.set(0,1.6,0);
  const app:any=Object.create(TrekViewerApp.prototype);
  app.sceneManager={camera,renderer:{xr:{isPresenting:true,getCamera:()=>camera}},dioramaRoot:new THREE.Group(),render:vi.fn()};
  app.spatialHUD={group:new THREE.Group(),setDockSide:vi.fn(),update:vi.fn()};
  app.session={getState:()=>({viewMode:'first-person'})};
  app.routeLoader={getActiveTrek:()=>null};
  app.xrManager={update:vi.fn()}; app.controls={enabled:false}; app.lastTimestamp=performance.now();
  app.dockHUD('left'); expect(app.spatialHUD.group.position.x).toBeLessThan(0);
  app.spatialHUD.group.position.set(2,1,-3);
  camera.position.set(1,1.7,0);camera.rotation.y=1;
  app.animate(performance.now());
  expect(app.spatialHUD.group.position.toArray()).toEqual([2,1,-3]);
  app.toggleHUD();expect(app.spatialHUD.group.visible).toBe(false);
  app.toggleHUD();expect(app.spatialHUD.group.visible).toBe(true);
  expect(app.spatialHUD.group.position.toArray()).not.toEqual([2,1,-3]);
});

it('does not accept direct hand pokes on a hidden HUD',()=>{
  const xr:any=Object.create(XRManager.prototype);
  xr.spatialHUD={group:new THREE.Group(),onPointerClick:vi.fn()};xr.spatialHUD.group.visible=false;
  expect(xr.checkHandHUDInteraction({},new THREE.Vector3(),true)).toBe(false);
  expect(xr.spatialHUD.onPointerClick).not.toHaveBeenCalled();
});

it('does not let a delayed default route replace an explicit import',async()=>{
  let resolve!:()=>void;const pending=new Promise<void>(r=>resolve=r);
  vi.spyOn(TextureProvider,'waitForInitialization').mockReturnValue(pending);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>[{id:'default',file:'default.gpx',name:'Default'}]}));
  const app:any=Object.create(TrekViewerApp.prototype);
  app.routeSelectionGeneration=0;app.overlay={showStatus:vi.fn(),setManifest:vi.fn()};
  app.routeLoader={loadRouteFromXml:vi.fn(),loadRouteFromUrl:vi.fn()};
  const startup=app.initRoutes();const upload=app.loadTrackFromXML('<gpx/>','Import');
  resolve();await Promise.all([startup,upload]);
  expect(app.routeLoader.loadRouteFromXml).toHaveBeenCalledWith('<gpx/>','Import');
  expect(app.routeLoader.loadRouteFromUrl).not.toHaveBeenCalled();
});
