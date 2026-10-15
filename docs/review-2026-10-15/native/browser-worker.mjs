import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=path.resolve('.review-cache/native-worker-browser');fs.mkdirSync(out,{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4193','--strictPort'],{stdio:'pipe',windowsHide:true});
let browser;
try {
 await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes('4193'))resolve();});server.on('error',reject);setTimeout(()=>reject(Error('preview timeout')),15000);});
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--ignore-certificate-errors']});
 const page=await browser.newPage({viewport:{width:1233,height:821},ignoreHTTPSErrors:true});const errors=[],warnings=[];
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['warning','error'].includes(m.type()))warnings.push(m.text());});
 await page.goto('https://127.0.0.1:4193/?profile=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__trekViewerApp?.activeTrek?.imageryLOD.patches.size>=8,null,{timeout:120000});
 await page.evaluate(()=>{
  const lod=window.__trekViewerApp.activeTrek.imageryLOD;
  window.nativeWorkerOriginalGeometry=new Map([...lod.patches].map(([key,p])=>[key,p.mesh.geometry.uuid]));
 });
 await page.waitForFunction(()=>{
  const a=window.__trekViewerApp,lod=a.activeTrek.imageryLOD;
  return a.terrainResult.localChunks.length>=3&&[...window.nativeWorkerOriginalGeometry].some(([key,uuid])=>lod.patches.has(key)&&lod.patches.get(key).mesh.geometry.uuid!==uuid);
 },null,{timeout:180000});
 const result=await page.evaluate(()=>{
  const a=window.__trekViewerApp,lod=a.activeTrek.imageryLOD,checked=[];
  for(const p of lod.patches.values()){
   const g=p.mesh.geometry;if(!g.attributes.position.count)continue;
   const scanned=new g.constructor();scanned.setAttribute('position',g.attributes.position);
   scanned.computeBoundingBox();scanned.computeBoundingSphere();
   checked.push({key:p.key,vertices:g.attributes.position.count,boxEqual:g.boundingBox.equals(scanned.boundingBox),sphereEqual:g.boundingSphere.equals(scanned.boundingSphere)});scanned.dispose();
  }
  const r=a.sceneManager.renderer;
  a.sceneManager.camera.aspect=1;a.sceneManager.camera.updateProjectionMatrix();
  r.xr.dispatchEvent({type:'sessionend'});
  return {condition:'Actual Edge production worker promotion with live sources; desktop rendering, no native XR.',chunks:a.terrainResult.localChunks.length,checked,restoredAspect:a.sceneManager.camera.aspect,expectedAspect:innerWidth/innerHeight,glError:r.getContext().getError()};
 });
 assert(result.checked.length>0);assert(result.checked.every(p=>p.boxEqual&&p.sphereEqual));assert.equal(result.restoredAspect,result.expectedAspect);assert.equal(result.glError,0);assert.deepEqual(errors,[]);
 Object.assign(result,{errors,warnings,checksPassed:true});
 fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');await page.screenshot({path:path.join(out,'browser.png')});console.log(JSON.stringify(result));
}finally{await browser?.close();server.kill();}
