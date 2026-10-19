import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.TREK_SWISS_URL ?? 'https://127.0.0.1:4200';
const out = path.resolve(process.env.TREK_SWISS_OUT ?? '.review-cache/swiss-browser'); fs.mkdirSync(out, { recursive: true });
const prefix = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/default/current/3857/';
const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="TrekViewer validation"><trk><name>Swiss imagery checkpoint</name><trkseg>${Array.from({length:16},(_,i)=>`<trkpt lat="${46.6235+i*.00008}" lon="${8.0405+i*.0001}"><ele>${1050+i*3}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;
let browser, server; const errors = [], requests = [], revisions = [];
try {
  if (!process.env.TREK_SWISS_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4200','--strictPort'], {stdio:'pipe',windowsHide:true});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Preview timeout')),15000);server.stdout.on('data',data=>{if(data.toString().includes('4200')){clearTimeout(timer);resolve();}});server.on('error',reject);});
  }
  browser=await chromium.launch({executablePath:process.env.TREK_EDGE_EXECUTABLE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--ignore-certificate-errors']});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1233,height:821}}),page=await context.newPage();
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  page.on('pageerror',error=>errors.push(String(error)));page.on('request',request=>{if(request.url().startsWith(prefix))requests.push(request.url());});
  let revisionOverride;
  await page.route('**/ch.swisstopo.swissimage-product/cacheUpdate',async route=>{
    if(revisionOverride){revisions.push(revisionOverride);return route.fulfill({contentType:'application/json',body:JSON.stringify({cache_type:'wmts_native',cache_update:revisionOverride})});}
    const response=await route.fetch();const data=await response.json();revisions.push(data.cache_update);return route.fulfill({response});
  });
  await page.route('**/USGSNAIPPlus/ImageServer/exportImage?**',route=>route.abort('timedout'));
  await page.route('**/imagery.geoplatform.gov/**',route=>route.abort('timedout'));
  const importRoute=async()=>{
    await page.waitForFunction(()=>!!window.__trekViewerApp&&!!document.getElementById('gpxUploadInput'),null,{timeout:30000});
    await page.setInputFiles('#gpxUploadInput',{name:'swiss-validation.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from(gpx)});
    await page.waitForFunction(()=>window.__trekViewerApp?.activeTrek?.track.name==='Swiss imagery checkpoint',null,{timeout:120000});
    await page.click('#btnViewToggle');
    await page.waitForFunction(()=>window.__trekViewerApp.activeTrek.imageryLOD.getDiagnostics().visibleFineBySource.swissimage>=16,null,{timeout:120000});
  };
  const snapshot=async(key)=>page.evaluate(async({key,prefix})=>{
    const app=window.__trekViewerApp,lod=app.activeTrek.imageryLOD;
    const patch=key?lod.patches.get(key):[...lod.patches.values()].find(p=>p.zoom===19&&p.mesh.visible);
    if(!patch)throw Error('Expected published Swiss patch');
    const image=patch.texture.image,c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
    const data=ctx.getImageData(0,0,256,256).data;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const url=`${prefix}${patch.zoom}/${patch.x}/${patch.y}.png`;
    await app.resourceCache.flush();const blob=await app.resourceCache.read(url);
    return {key:patch.key,url,hash,rawBytes:blob?.size??0,stats:await app.resourceCache.refreshStats(),diagnostics:lod.getDiagnostics(),elevationSource:app.activeTrek.terrainResult.demGrid.source,attribution:app.session.getState().attribution,
      build:await(await fetch('/build-info.json')).json(),glError:app.sceneManager.renderer.getContext().getError()};
  },{key,prefix});
  await page.goto(`${base}/?profile=1`,{waitUntil:'domcontentloaded'});await importRoute();
  const cold=await snapshot();assert(cold.rawBytes>0);assert(cold.attribution.includes('©swisstopo'));assert(cold.diagnostics.visibleFineBySource.swissimage>=16);assert(cold.elevationSource!=='USGS 3DEP best available (public domain)');
  await page.screenshot({path:path.join(out,'trail.png')});
  const beforeWarm=requests.length;await page.reload({waitUntil:'domcontentloaded'});await importRoute();
  await page.waitForFunction(key=>window.__trekViewerApp.activeTrek.imageryLOD.patches.get(key)?.mesh.visible,cold.key,{timeout:60000});
  const warm=await snapshot(cold.key);assert.equal(warm.hash,cold.hash);assert(warm.stats.hits>0);assert.equal(requests.slice(beforeWarm).filter(url=>url===cold.url).length,0,'HTTP cache disabled; persisted Swiss imagery reused');
  await page.click('#profile-start');await page.waitForTimeout(1300);await page.click('#profile-stop');
  await page.waitForFunction(()=>window.__trekViewerApp.profileSavedOnDevice,null,{timeout:10000});
  const profile=await page.evaluate(()=>window.__trekViewerApp.completedProfile.windows.map(w=>({sources:w.imageryVisibleFineBySource,cacheHits:w.resourceCacheHits})));
  assert(profile.length>0&&profile.every(w=>w.sources.swissimage>=16&&w.cacheHits>0));
  // Simulate a newer official mosaic revision while real tile downloads stay unchanged.
  revisionOverride='2026-10-18T00:00:00';const beforeRevision=requests.length;
  await page.reload({waitUntil:'domcontentloaded'});await importRoute();
  await page.waitForFunction(key=>window.__trekViewerApp.activeTrek.imageryLOD.patches.get(key)?.mesh.visible,cold.key,{timeout:60000});
  const updated=await snapshot(cold.key);assert.equal(updated.hash,cold.hash);assert(updated.rawBytes>0);assert(requests.slice(beforeRevision).includes(cold.url),'Mosaic revision changed: old persisted bytes must not satisfy the new request');
  const missing=await page.evaluate(async()=>{
    const app=window.__trekViewerApp,loader=app.activeTrek.imageryLOD.constructor;
    try{await loader.loadPatchImage(19,277435,182576,'satellite');return{rejected:false};}catch(error){return{rejected:true,message:String(error),diagnostics:app.activeTrek.imageryLOD.getDiagnostics()};}
  });assert(missing.rejected);assert(missing.diagnostics.visibleFineBySource.swissimage>=16);
  revisionOverride='malformed';await page.reload({waitUntil:'domcontentloaded'});await importRoute();
  await page.waitForFunction(key=>window.__trekViewerApp.activeTrek.imageryLOD.patches.get(key)?.mesh.visible,cold.key,{timeout:60000});
  const metadataFailure=await snapshot(cold.key);assert.equal(metadataFailure.rawBytes,0);assert.equal(metadataFailure.hash,cold.hash);
  for(const state of[cold,warm,updated,metadataFailure])assert.equal(state.glError,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify({condition:'Actual Edge WebGL/IndexedDB with a synthetic Swiss GPX, real AWS elevation and real SWISSIMAGE PNGs. HTTP cache disabled; metadata updates/failure are simulated for revision invalidation. Not native XR or a Swiss DEM upgrade.',cold,warm,updated,metadataFailure,profile,missing,revisions,errors},null,2));
  console.log(JSON.stringify({coldFine:cold.diagnostics.visibleFineBySource,warmHits:warm.stats.hits,hashesEqual:cold.hash===warm.hash&&cold.hash===updated.hash&&cold.hash===metadataFailure.hash,revisionRefetched:requests.slice(beforeRevision).includes(cold.url),missingRejected:missing.rejected,metadataFailureBypassedDisk:metadataFailure.rawBytes===0,revisions,errors}));
}finally{await browser?.close();server?.kill();}
