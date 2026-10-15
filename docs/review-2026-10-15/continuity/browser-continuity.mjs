import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=path.resolve(process.env.TREK_CONTINUITY_OUT??'.review-cache/continuity/browser');fs.mkdirSync(out,{recursive:true});
const baseline='a7b06c2623c7850d5e3673c847f18504184f00ce';
const old=execFileSync('git',['show',`${baseline}:src/terrain/ImageryLODManager.ts`],{encoding:'utf8',maxBuffer:2*1024*1024});
const start=old.indexOf('  public updatePatchVisibility(): void {'),end=old.indexOf('\n  /**',start+2);
assert(start>=0&&end>start);
const baselineScript=stripTypeScriptTypes('window.continuityBaseline=({'+old.slice(start,end).replace('public ','')+'}).updatePatchVisibility;',{mode:'transform'});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4191','--strictPort'],{stdio:'pipe',windowsHide:true});
let browser,release;const gate=new Promise(resolve=>{release=resolve;});let hold=false,heldRequests=0;
const result={baseline,condition:'Actual desktop Edge WebGL with Quest High budgets and synthetic asymmetric stereo cameras driving the production XR LOD path. Desktop rendering remains monoscopic. No native XR runtime, Quest GPU or headset timing.',checks:[]};
try {
 await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes('4191'))resolve();});server.on('error',reject);setTimeout(()=>reject(Error('preview timeout')),15000);});
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--ignore-certificate-errors']});
 const context=await browser.newContext({viewport:{width:1233,height:821},ignoreHTTPSErrors:true,userAgent:'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/40.0 Chrome/138.0.0.0 Mobile VR Safari/537.36'});
 const page=await context.newPage();const errors=[],warnings=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['warning','error'].includes(m.type()))warnings.push(m.text());});
 await page.route(/\/export(?:Image)?\?/,async route=>{if(hold){heldRequests++;await gate;}await route.continue().catch(()=>{});});
 await page.goto('https://127.0.0.1:4191/?profile=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'),null,{timeout:120000});
 await page.addScriptTag({content:baselineScript});
 await page.evaluate(()=>{
  document.getElementById('profile-controls')?.remove();
  const a=window.__trekViewerApp;a.controls.enableDamping=false;a.flyoverController.setProgress(.4);a.session.setProgress(.4);
 });
 await page.click('#btnViewToggle');
 await page.evaluate(()=>{
  const a=window.__trekViewerApp,lod=a.activeTrek.imageryLOD,camera=a.sceneManager.camera;
  const stereo=camera.clone();stereo.isArrayCamera=true;stereo.cameras=[camera.clone(),camera.clone()];
  const original=lod.update,flyover=a.flyoverController.update;
  window.continuityYaw=0;window.continuityPitch=0;window.continuityStereo=stereo;
  a.flyoverController.update=function(...args){flyover.apply(this,args);camera.rotateY(window.continuityYaw);camera.rotateX(window.continuityPitch);camera.updateWorldMatrix(true,false);};
  lod.update=function(cam,root,isXR,progress,renderer,timing){
   stereo.position.copy(cam.position);stereo.quaternion.copy(cam.quaternion);stereo.updateWorldMatrix(true,false);
   stereo.cameras.forEach((eye,i)=>{
    eye.matrixWorld.copy(cam.matrixWorld);
    const offset=new cam.position.constructor(i===0?-.032:.032,0,0).applyQuaternion(cam.quaternion);
    eye.matrixWorld.elements[12]+=offset.x;eye.matrixWorld.elements[13]+=offset.y;eye.matrixWorld.elements[14]+=offset.z;
    eye.projectionMatrix.copy(cam.projectionMatrix);eye.projectionMatrix.elements[8]=i===0?-.18:.18;eye.projectionMatrix.elements[9]=.12;
    eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    eye.viewport={w:1700};
   });
   original.call(this,stereo,root,true,progress,{xr:{isPresenting:true,getBaseLayer:()=>({framebufferHeight:3400})}},timing);
  };
 });
 // Warm real public imagery before delaying subsequent exports.
 const warmDeadline=Date.now()+360000;let warmed=false;
 while(Date.now()<warmDeadline){
  const state=await page.evaluate(()=>{
   const lod=window.__trekViewerApp.activeTrek.imageryLOD;
   return {residents:lod.patches.size,fine:[...lod.patches.values()].filter(p=>p.zoom===19&&p.mesh.visible&&!p.isFading).length};
  });
  console.log(JSON.stringify({warming:state}));
  if(state.residents>=300&&state.fine>=160){warmed=true;break;}
  await page.waitForTimeout(5000);
 }
 assert(warmed,'Public imagery did not warm enough to exercise detail outside the stable core');
 await page.evaluate(()=>{
  const lod=window.__trekViewerApp.activeTrek.imageryLOD;
  window.continuityKeys=[...lod.patches.values()].filter(p=>p.zoom===19&&p.mesh.visible&&!p.isFading).map(p=>p.key);
 });
 hold=true;
 const snapshot=label=>page.evaluate(label=>{
  const a=window.__trekViewerApp,lod=a.activeTrek.imageryLOD,keys=window.continuityKeys;
  const lost=keys.filter(k=>lod.patches.has(k)&&!lod.patches.get(k).mesh.visible);
  const evicted=keys.filter(k=>!lod.patches.has(k));
  window.continuityBaseline.call(lod);
  const baselineLost=keys.filter(k=>lod.patches.has(k)&&!lod.patches.get(k).mesh.visible).length;
  lod.updatePatchVisibility();
  const gl=a.sceneManager.renderer.getContext();
  return {label,lost,baselineLost,evicted,tracked:keys.length,residents:lod.patches.size,budget:lod.maxPatches,desired:lod.desiredTileKeys.size,visible:lod.getDiagnostics().visibleCount,zoom:lod.currentTargetZoom,xrPath:lod.lastIsXR,eyeSamples:lod.firstPersonViewSampleTiles.length,vertices:a.terrainResult.localChunks.reduce((n,c)=>n+c.totalVertices,0),glError:gl.getError()};
 },label);
 for(let turn=0;turn<40;turn++){
  await page.evaluate(turn=>{
   window.continuityYaw=(turn%2?35:-35)*Math.PI/180;window.continuityPitch=(turn%3-1)*12*Math.PI/180;
   window.__trekViewerApp.activeTrek.imageryLOD.evaluationDirty=true;
  },turn);
  await page.waitForTimeout(160);
  const state=await snapshot(`head-turn-${turn}`);result.checks.push(state);
  assert.equal(state.lost.length,0,JSON.stringify(state));assert(state.xrPath);assert.equal(state.zoom,19);assert(state.residents<=state.budget);assert(state.vertices<=800000);assert.equal(state.glError,0);
 }
 // A selection reset must preserve coverage synchronously in both view modes.
 for(const mode of ['diorama','first-person']){
  const state=await page.evaluate(mode=>{
   const lod=window.__trekViewerApp.activeTrek.imageryLOD;
   const before=[...lod.patches.values()].filter(p=>p.zoom===19&&p.mesh.visible).map(p=>p.key);
   lod.setViewMode(mode);
   const lost=before.filter(k=>lod.patches.has(k)&&!lod.patches.get(k).mesh.visible);
   window.continuityBaseline.call(lod);
   const baselineLost=before.filter(k=>lod.patches.has(k)&&!lod.patches.get(k).mesh.visible).length;
   lod.updatePatchVisibility();
   return {mode,before:before.length,lost,baselineLost,residents:lod.patches.size,budget:lod.maxPatches};
  },mode);
  assert(state.before>0);assert.equal(state.lost.length,0);assert(state.baselineLost>0);assert(state.residents<=state.budget);result.checks.push(state);
 }
 const aged=await page.evaluate(()=>{
  const lod=window.__trekViewerApp.activeTrek.imageryLOD,keys=window.continuityKeys;
  for(const key of keys){const p=lod.patches.get(key);if(p){p.lastUsed=-1000000;p.centerDist=1000;}}
  lod.prunePatches(new Set());
  return {label:'aged-with-spare-capacity',lost:keys.filter(k=>!lod.patches.has(k)||!lod.patches.get(k).mesh.visible),residents:lod.patches.size,budget:lod.maxPatches};
 });
 assert.equal(aged.lost.length,0);assert(aged.residents<aged.budget);result.checks.push(aged);
 release();hold=false;
 await page.evaluate(()=>{window.continuityYaw=0;window.continuityPitch=0;window.__trekViewerApp.activeTrek.imageryLOD.evaluationDirty=true;});
 await page.waitForTimeout(1500);
 result.final=await snapshot('returned');assert.equal(result.final.lost.length,0);assert.equal(result.final.glError,0);
 await page.screenshot({path:path.join(out,'returned.png')});
 assert(heldRequests>0,'The delayed export path must actually be exercised');assert.deepEqual(errors,[]);
 Object.assign(result,{heldRequests,errors,warnings,checksPassed:true});
 fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 await context.close();
}finally{release();await browser?.close();server.kill();}
