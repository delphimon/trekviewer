// Run from repo root with Node's --experimental-transform-types flag. This is
// a private, bounded availability/crop probe, not a native quality benchmark.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PublicImageryProvider} from '../../src/terrain/providers/PublicImageryProvider.ts';
import {EsriWorldImageryProvider} from '../../src/terrain/providers/ImageryProvider.ts';
import {latLonToTile} from '../../src/gpx/Coordinates.ts';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.TREK_PLAYWRIGHT_MODULE ?? 'C:/Users/andre/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out=path.resolve(process.env.TREK_IMAGERY_COMPARE_OUT ?? '.review-cache/source-comparison');fs.mkdirSync(out,{recursive:true});
const audit=JSON.parse(fs.readFileSync('docs/review-2026-10-17/source-audit/audit.json','utf8'));
const sample=audit.routes.find(r=>r.id.includes('olympus')).sample;
const tile=latLonToTile(sample.lat,sample.lon,19),pub=new PublicImageryProvider(),esri=new EsriWorldImageryProvider();
const requests=pub.getTileUrls(19,tile.x,tile.y).map((url,i)=>({label:['USGS NAIP Plus','GeoPlatform NAIP Plus','USGS NAIP'][i],url,region:pub.getTileImageRegion(19,tile.x,tile.y)}));
requests.push({label:'Earlier Esri path (account eligibility unverified)',url:esri.getTileUrls(19,tile.x,tile.y)[0]});
const browser=await chromium.launch({executablePath:process.env.TREK_EDGE_EXECUTABLE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
const page=await browser.newPage({viewport:{width:1200,height:900}});
await page.goto('https://trekviewer.surge.sh/data-sources.html');
const results=await page.evaluate(async requests=>{
  document.body.replaceChildren();document.body.style='background:#111;color:white;font:16px sans-serif;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px;';
  return Promise.all(requests.map(async req=>{
    const div=document.createElement('div'),label=document.createElement('p'),canvas=document.createElement('canvas');label.textContent=req.label;div.append(label,canvas);document.body.append(div);canvas.width=canvas.height=256;canvas.style='width:384px;height:384px;';
    const start=performance.now();try{
      const res=await fetch(req.url,{signal:AbortSignal.timeout(12000),credentials:'omit'});if(!res.ok)throw Error(`HTTP ${res.status}`);const blob=await res.blob();const image=await createImageBitmap(blob);const ctx=canvas.getContext('2d');
      if(req.region){const r=req.region;ctx.drawImage(image,r.x,r.y,r.width,r.height,0,0,256,256);}else ctx.drawImage(image,0,0);
      const pixels=ctx.getImageData(0,0,256,256).data;let transparent=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]<255)transparent++;
      label.textContent+=` — ${image.width}×${image.height}; crop 256×256`;
      return {...req,status:'decoded',width:image.width,height:image.height,bytes:blob.size,ms:performance.now()-start,transparentPixels:transparent};
    }catch(error){label.textContent+=` — ${String(error)}`;return{...req,status:'failed',ms:performance.now()-start,error:String(error)}}
  }));
},requests);
const result={retrieved:new Date().toISOString(),condition:'One private desktop browser crop per service at identical Olympus highest recorded GPX coordinate and Z19. No claim of whole-route coverage or provider eligibility.',sample,tile,results};
fs.writeFileSync(path.join(out,'imagery.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
