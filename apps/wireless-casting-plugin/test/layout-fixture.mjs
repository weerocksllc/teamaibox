// Real-browser regression fixture. Only generated color bars are streamed;
// this never connects to an appliance, camera, microphone or user media.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const page = `<!doctype html><meta charset="utf-8"><title>Casting video layout regression</title>
<link rel="stylesheet" href="/app.css">
<style>body{padding:16px}#fixture{max-width:100%}button{padding:12px;background:#ddd;color:#111}pre{white-space:pre-wrap}</style>
<h1>Synthetic casting layout test</h1>
<button id="run">Run orientation and width tests</button>
<button id="portrait">Show portrait</button><button id="landscape">Show landscape</button>
<div id="fixture"><div class="video-frame"><video id="video" controls playsinline muted hidden></video>
<div id="placeholder" class="video-placeholder">Not joined — no video</div></div></div>
<pre id="results">Not run</pre><script type="module" src="/fixture.js"></script>`;

const script = `const video=document.querySelector('#video'), box=document.querySelector('#fixture');
const frame=document.querySelector('.video-frame'), placeholder=document.querySelector('#placeholder');
const results=document.querySelector('#results');
let stream;
const tick=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
async function show(width,height,displayWidth){
 box.style.width=displayWidth+'px';
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 const c=canvas.getContext('2d');
 c.fillStyle='#164d78';c.fillRect(0,0,width,height);
 c.lineWidth=20;c.strokeStyle='#fff';c.strokeRect(10,10,width-20,height-20);
 c.font='bold 48px sans-serif';c.fillStyle='#fff';
 c.fillText('TOP LEFT',24,70);c.textAlign='right';c.fillText('TOP RIGHT',width-24,140);
 c.textAlign='left';c.fillText('BOTTOM LEFT',24,height-140);
 c.textAlign='right';c.fillText('BOTTOM RIGHT',width-24,height-70);
 const previous=stream;stream=canvas.captureStream(1);video.srcObject=stream;
 video.hidden=false;placeholder.hidden=true;
 await video.play();previous?.getTracks().forEach(t=>t.stop());
 await tick();
 const f=frame.getBoundingClientRect(),v=video.getBoundingClientRect(),s=getComputedStyle(video);
 const delta=Math.max(...['x','y','width','height'].map(k=>Math.abs(v[k]-f[k])));
 return {width,height,displayWidth,frameWidth:f.width,frameHeight:f.height,
  videoWidth:v.width,videoHeight:v.height,intrinsicWidth:video.videoWidth,intrinsicHeight:video.videoHeight,
  objectFit:s.objectFit,frameScrollHeight:frame.scrollHeight,
  passed:delta<1&&s.objectFit==='contain'&&video.videoWidth===width&&video.videoHeight===height};
}
document.querySelector('#run').onclick=async()=>{
 const cases=[];results.textContent='Running';
 try{
  for(const w of [770,1200,320,240]){
   for(const [x,y] of [[498,1080],[1920,1080],[1080,1920],[1080,1080],[1280,720]])cases.push(await show(x,y,w));
  }
  video.hidden=true;placeholder.hidden=false;await tick();
  cases.push({name:'leave-hides-video',passed:getComputedStyle(video).display==='none'&&placeholder.getBoundingClientRect().height>0});
  cases.push({...await show(498,1080,770),name:'rejoin-portrait'});
  results.textContent=JSON.stringify({passed:cases.every(x=>x.passed),cases},null,2);
 }catch(e){results.textContent=JSON.stringify({passed:false,error:e.name,cases},null,2);}
};
document.querySelector('#portrait').onclick=()=>show(498,1080,770);
document.querySelector('#landscape').onclick=()=>show(1920,1080,770);
window.addEventListener('pagehide',()=>stream?.getTracks().forEach(t=>t.stop()));`;

const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.url==='/app.css'){
  res.setHeader('Content-Type','text/css');
  res.end(await readFile(new URL('../src/public/app.css',import.meta.url)));return;
 }
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
 res.writeHead(404).end();
});
server.listen(8797,'127.0.0.1',()=>console.log('Synthetic fixture: http://127.0.0.1:8797'));
