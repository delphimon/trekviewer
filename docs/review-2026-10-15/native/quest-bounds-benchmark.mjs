import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {createPromotedPatchGeometry}=await import(pathToFileURL(path.resolve('src/terrain/SurfacePromotion.ts')));
const tabs=await(await fetch('http://127.0.0.1:9231/json/list')).json();
const tab=tabs.find(t=>t.type==='page'&&t.url?.startsWith('https://trekviewer.surge.sh/'));
if(!tab)throw Error('No TrekViewer tab');
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
const expression=`(async()=>{
 const app=window.__trekViewerApp;if(!app)return {skipped:'No profiling handle'};
 if(app.sceneManager.renderer.xr.isPresenting)return {skipped:'Benchmark requires exiting XR; no active immersive view is interrupted'};
 const sources=[...app.activeTrek.imageryLOD.patches.values()].map(p=>p.mesh.geometry).filter(g=>g.type==='BufferGeometry'&&g.boundingBox&&g.boundingSphere&&g.attributes.position.count>0).sort((a,b)=>b.attributes.position.count-a.attributes.position.count).slice(0,24);
 if(!sources.length)return {skipped:'No prepared surface patches available'};
 const source=sources[0];
 let attributePrototype=Object.getPrototypeOf(source.attributes.position);
 while(!Object.hasOwn(attributePrototype,'setXYZ'))attributePrototype=Object.getPrototypeOf(attributePrototype);
 const THREE={BufferGeometry:source.constructor,BufferAttribute:attributePrototype.constructor,Box3:source.boundingBox.constructor,Vector3:source.boundingBox.min.constructor,Sphere:source.boundingSphere.constructor};
 const current=${createPromotedPatchGeometry.toString()};
 const previous=data=>{
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(data.normals,3));geometry.setAttribute('uv',new THREE.BufferAttribute(data.uvs,2));geometry.setIndex(new THREE.BufferAttribute(data.indices,1));
  geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;
 };
 const inputs=sources.map(g=>({key:'benchmark',positions:g.attributes.position.array,normals:g.attributes.normal.array,uvs:g.attributes.uv.array,indices:g.index.array,...structuredClone({boundsMin:g.boundingBox.min.toArray(),boundsMax:g.boundingBox.max.toArray(),sphereCenter:g.boundingSphere.center.toArray(),sphereRadius:g.boundingSphere.radius})}));
 for(const data of inputs){const a=previous(data),b=current(data);if(!a.boundingBox.equals(b.boundingBox)||!a.boundingSphere.equals(b.boundingSphere))throw Error('Bounds differ');if(a.attributes.position.array!==data.positions||b.attributes.position.array!==data.positions||a.index.array!==data.indices||b.index.array!==data.indices)throw Error('Benchmark must use BufferAttribute without copying or changing array types');a.dispose();b.dispose();}
 const measure=fn=>{const start=performance.now();for(const data of inputs){const geometry=fn(data);geometry.dispose();}return performance.now()-start;};
 const a=[],b=[];
 for(let i=0;i<60;i++){
  if(app.sceneManager.renderer.xr.isPresenting)return {skipped:'XR started; benchmark stopped',completedPairs:i};
  let before,after;if(i%2){after=measure(current);before=measure(previous);}else{before=measure(previous);after=measure(current);}
  if(i>=15){a.push(before);b.push(after);}await new Promise(r=>setTimeout(r,0));
 }
 const stats=x=>{x.sort((a,b)=>a-b);return {medianMs:x[Math.floor(x.length*.5)],p95Ms:x[Math.floor(x.length*.95)],samples:x.length};};
 return {condition:'Actual Quest 3 JavaScript, outside XR, production geometry publisher vs previous rescan path using current live patch arrays. Exact current helper injected from source. No rendered frames or GPU timings measured.',userAgent:navigator.userAgent,patches:inputs.length,vertices:inputs.reduce((n,d)=>n+d.positions.length/3,0),identicalBounds:true,previous:stats(a),current:stats(b),visibility:document.visibilityState};
})()`;
try{
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Benchmark timeout')),90000);ws.addEventListener('message',({data})=>{const r=JSON.parse(data);if(r.id===1){clearTimeout(timer);resolve(r);}});ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});
 fs.mkdirSync('.review-cache/quest-native',{recursive:true});
 fs.writeFileSync('.review-cache/quest-native/bounds-benchmark.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 if(result.error||result.result?.exceptionDetails)process.exitCode=1;
}finally{ws.close();}
