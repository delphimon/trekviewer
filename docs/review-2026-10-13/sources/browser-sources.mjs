import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=path.resolve(process.env.TREK_SOURCES_OUT??'.review-cache/sources');fs.mkdirSync(out,{recursive:true});
const coordinates='(() => {'+stripTypeScriptTypes(fs.readFileSync('src/gpx/Coordinates.ts','utf8'),{mode:'transform'}).replaceAll('export ','')+';window.sourceCoordinates={latLonToTile,localMetersToGeo};})()';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4189','--strictPort'],{stdio:'pipe',windowsHide:true});
let browser;const result={condition:'Actual desktop Edge WebGL; Quest user-agent selects Quest High budgets only. No native XR session or headset timing.',views:[]};
try {
 await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes('4189'))resolve();});server.on('error',reject);setTimeout(()=>reject(Error('preview timeout')),15000);});
 browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--ignore-certificate-errors']});
 const context=await browser.newContext({viewport:{width:1233,height:821},ignoreHTTPSErrors:true,userAgent:'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/40.0 Chrome/138.0.0.0 Mobile VR Safari/537.36'});
 const page=await context.newPage();const errors=[],warnings=[],requests={elevation:0,naipPlus:0,naip:0,geoNaip:0,overview:0,commercial:0};
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['warning','error'].includes(m.type()))warnings.push(m.text());});
 page.on('request',r=>{const u=r.url();if(u.includes('/3DEPElevation/'))requests.elevation++;else if(u.includes('/USGSNAIPPlus/'))requests.naipPlus++;else if(u.includes('/USGSNAIPImagery/'))requests.naip++;else if(u.includes('imagery.geoplatform.gov'))requests.geoNaip++;else if(u.includes('/USGSImageryOnly/'))requests.overview++;else if(/arcgisonline\.com|virtualearth\.net|api\.cesium\.com/.test(u))requests.commercial++;});
 await page.goto('https://127.0.0.1:4189/?profile=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__trekViewerApp?.activeTrek?.track.name.includes('Rainier'),null,{timeout:120000});
 await page.addScriptTag({content:coordinates});
 await page.evaluate(()=>{document.getElementById('profile-controls')?.remove();const a=window.__trekViewerApp;a.controls.enableDamping=false;a.flyoverController.setProgress(.4);a.session.setProgress(.4);});
 const startup=await page.evaluate(()=>{const a=window.__trekViewerApp;return {source:a.terrainResult.demGrid?.source,sampleSpacing:a.terrainResult.demGrid?.sampleSpacingMeters,caption:document.getElementById('desktopAttribution')?.textContent};});
 assert(/USGS 3DEP|Terrarium fallback/.test(startup.source),JSON.stringify(startup));
 await page.click('#btnViewToggle');
 const snapshot=()=>page.evaluate(()=>{
  const a=window.__trekViewerApp,lod=a.activeTrek.imageryLOD,t=a.terrainResult,camera=a.sceneManager.camera,root=a.sceneManager.dioramaRoot;
  const V=camera.position.constructor,R=lod.terrainRaycast.localRay.constructor,{latLonToTile,localMetersToGeo}=window.sourceCoordinates;
  const surfaces=t.terrainMesh.parent.children.filter(m=>m.isMesh&&m.visible&&(m===t.terrainMesh||m.name==='LocalHighResTerrainMesh'));
  root.updateWorldMatrix(true,true);camera.updateWorldMatrix(true,false);
  const forward=camera.getWorldDirection(new V()),right=new V(1,0,0).applyQuaternion(camera.quaternion),up=new V(0,1,0).applyQuaternion(camera.quaternion),half=Math.tan(camera.fov*Math.PI/360),samples=[];
  for(const y of [-.85,-.4,0,.4,.85])for(const x of [-.85,-.4,0,.4,.85]){
   const direction=forward.clone().addScaledVector(right,x*half*camera.aspect).addScaledVector(up,y*half).normalize();
   const hit=lod.terrainRaycast.closest({ray:new R(camera.position.clone(),direction),near:0,far:Infinity},surfaces);if(!hit)continue;
   const local=root.worldToLocal(hit.point.clone()),geo=localMetersToGeo(local.x,local.z,t.terrainGeoBounds.centerLat,t.terrainGeoBounds.centerLon);let patch;
   for(let z=19;z>=13;z--){const tile=latLonToTile(geo.lat,geo.lon,z);const p=lod.patches.get(`satellite:${z}:${tile.x}:${tile.y}`);if(p?.mesh.visible){patch=p;break;}}
   const chunk=t.localChunks.find(k=>{const b=k.getSurfaceBounds();return local.x>=b.minX&&local.x<=b.maxX&&local.z>=b.minZ&&local.z<=b.maxZ;});
   samples.push({x,y,imageryZoom:patch?.zoom??t.tileGrid.zoom,imageSource:(patch?.mesh.material.map.image.src??patch?.mesh.material.map.image.dataset?.sourceUrl)?.split('?')[0],source:chunk?.currentGrid.source,sourceSpacingM:chunk?.currentGrid.sampleSpacingMeters,cell:chunk?.getCellSize()});
  }
  const gl=a.sceneManager.renderer.getContext(),s=a.activeTrek.localTerrainStreamer;
  return {samples,source:t.demGrid?.source,diagnostics:lod.getDiagnostics(),nativeChunks:t.localChunks.filter(c=>c.currentGrid.rasterBounds).length,chunks:t.localChunks.length,busy:s.busy,wanted:s.wanted.size,glError:gl.getError(),vertices:t.localChunks.reduce((n,c)=>n+c.totalVertices,0),renderer:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
 });
 for(const view of ['walking','turned']){
  if(view==='turned')await page.evaluate(()=>{const a=window.__trekViewerApp,original=a.flyoverController.update;window.sourceOriginalFlyoverUpdate=original; a.flyoverController.update=function(...args){original.apply(this,args);a.sceneManager.camera.rotateY(25*Math.PI/180);};a.activeTrek.imageryLOD.evaluationDirty=true;});
  let s,settled=false;const viewStarted=Date.now(),deadline=viewStarted+600000;
  while(Date.now()<deadline){await page.waitForTimeout(5000);s=await snapshot();console.log(JSON.stringify({view,chunks:s.chunks,native:s.nativeChunks,loaded:s.samples.filter(v=>v.source?.includes('USGS 3DEP')).length,hits:s.samples.length,sharp:s.samples.filter(v=>v.imageryZoom===19).length,inFlight:s.diagnostics.inFlightRequests,queued:s.diagnostics.requestQueueLength}));if(s.samples.length&&s.samples.every(v=>v.source?.includes('USGS 3DEP')&&v.imageryZoom===19)){settled=true;break;}}
  fs.writeFileSync(path.join(out,`${view}.json`),JSON.stringify(s,null,2)+'\n');await page.screenshot({path:path.join(out,`${view}.png`)});
  assert(settled,'Public-source detail did not reach the whole visible field');assert.equal(s.glError,0);assert(s.samples.every(v=>v.cell.x<=5.001&&v.cell.z<=5.001));assert(s.nativeChunks>0);assert(s.vertices<=800000);assert(s.samples.every(v=>v.sourceSpacingM<=1.1));result.views.push({view,settledMs:Date.now()-viewStarted,...s});
 }
 await page.evaluate(()=>{window.__trekViewerApp.flyoverController.update=window.sourceOriginalFlyoverUpdate;});
 await page.setViewportSize({width:390,height:844});await page.click('#btnViewToggle');if(await page.locator('#btnSettings').getAttribute('aria-expanded')==='false')await page.click('#btnSettings');await page.click('#btnFitTerrain');await page.waitForTimeout(200);
 const mobile=await page.evaluate(()=>{const el=document.getElementById('desktopAttribution'),r=el.getBoundingClientRect();return {width:innerWidth,rect:{left:r.left,right:r.right,bottom:r.bottom},text:el.textContent};});assert(mobile.rect.right<=390&&mobile.rect.left>=0);await page.screenshot({path:path.join(out,'mobile.png')});
 assert.equal(requests.commercial,0);assert(requests.elevation>0&&requests.naipPlus>0&&requests.overview>0);assert.deepEqual(errors,[]);
 Object.assign(result,{startup,mobile,requests,errors,warnings,checksPassed:true});fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checksPassed:true,requests,errors,warnings}));
 await context.close();
}finally{await browser?.close();server.kill();}
