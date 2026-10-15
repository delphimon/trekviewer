import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
registerHooks({load(url,context,next){
 if(url.endsWith('.json'))return {format:'module',source:`export default ${fs.readFileSync(new URL(url),'utf8')};`,shortCircuit:true};
 return next(url,context);
}});
const baseline='a7b06c2623c7850d5e3673c847f18504184f00ce';
let old=stripTypeScriptTypes(execFileSync('git',['show',`${baseline}:src/terrain/ImageryLODManager.ts`],{encoding:'utf8',maxBuffer:2*1024*1024}),{mode:'transform'});
old=old.replace(/from '([^']+)'/g,(_,specifier)=>`from '${pathToFileURL(path.resolve(specifier==='three'?'node_modules/three/build/three.module.js':path.resolve('src/terrain',specifier))).href}'`);
const {ImageryLODManager:Previous}=await import('data:text/javascript;base64,'+Buffer.from(old).toString('base64'));
const {ImageryLODManager:Current}=await import(pathToFileURL(path.resolve('src/terrain/ImageryLODManager.ts')));
const {computeBroadDetailTiles}=await import(pathToFileURL(path.resolve('src/terrain/BroadDetailSelection.ts')));
const bounds={minLat:46.8,maxLat:46.9,minLon:-121.8,maxLon:-121.7,centerLat:46.85,centerLon:-121.75,widthMeters:7600,depthMeters:11100,minEle:0,maxEle:1000,elevationSpan:1000};
const stats=s=>{s.sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length*.5)],p95Ms:s[Math.floor(s.length*.95)],samples:s.length};};
const results=[];
for(const budget of [512,768]){
 const center={lat:46.85,lon:-121.75};
 const anchors=[.004,.008,.012,.016].flatMap(lat=>[-.025,-.02,-.015,-.01,-.005,0,.005,.01,.015,.02,.025].map(lon=>({lat:center.lat+lat,lon:center.lon+lon})));
 const initial=computeBroadDetailTiles(center,19,budget-32,bounds,anchors);
 const next=computeBroadDetailTiles(center,19,budget-32,bounds,anchors.map(p=>({...p,lat:2*center.lat-p.lat})));
 const key=c=>`satellite:${c.zoom}:${c.x}:${c.y}`;
 const before=new Previous({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,enableFadeIn:false,maxPatches:budget});
 const after=new Current({terrainGeoBounds:bounds,terrainBaseElevation:0,elevationSampler:()=>0,enableFadeIn:false,maxPatches:budget});
 try {
  for(const manager of [before,after]){
   manager.desiredTileKeys=new Set(initial.map(key));
   for(const tile of initial)manager.patches.set(key(tile),{...tile,key:key(tile),mesh:{visible:false},isFading:false,dispose(){}});
   manager.updatePatchVisibility();
  }
  const tracked=[...after.patches].filter(([,p])=>p.zoom===19&&p.mesh.visible).map(([k])=>k);
  assert(tracked.length>0);
  for(const manager of [before,after]){manager.desiredTileKeys=new Set(next.map(key));manager.updatePatchVisibility();}
  const lost=manager=>tracked.filter(k=>!manager.patches.get(k).mesh.visible).length;
  assert(lost(before)>0);assert.equal(lost(after),0);
  const measure=manager=>{const start=performance.now();for(let i=0;i<10;i++)manager.updatePatchVisibility();return (performance.now()-start)/10;};
  const previous=[],current=[];
  for(let sample=0;sample<140;sample++){
   let a,b;if(sample%2){b=measure(after);a=measure(before);}else{a=measure(before);b=measure(after);}
   if(sample>=40){previous.push(a);current.push(b);}
  }
  results.push({budget,residentTiles:initial.length,trackedFineTiles:tracked.length,previousLostFineTiles:lost(before),currentLostFineTiles:lost(after),previous:stats(previous),current:stats(current),cachedRelations:after.tileRelations.size});
 }finally{before.dispose();after.dispose();}
}
const out=path.resolve('.review-cache/continuity');fs.mkdirSync(out,{recursive:true});
const result={baseline,runtime:process.version,condition:'Isolated CPU visibility only, inert meshes, real broad tile selections changing view anchors with all replacement downloads delayed. No rendering/network/Quest timing. Alternating version order; 40 warmup and 100 measured batches of ten passes.',results};
fs.writeFileSync(path.join(out,'benchmark.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
