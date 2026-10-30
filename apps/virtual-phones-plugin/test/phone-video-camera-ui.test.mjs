import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Real production UI/Chromium, explicitly mocked object and phone APIs.
// Decoder/Android content and encrypted storage require independent runs.
test('video UI is ROM-gated, uploads exact bytes, explains loop/end and never captures hardware',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://phone-video.test';
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1100,height:820}}),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
  const phoneId=randomUUID(),objectId=randomUUID(),uploadId=randomUUID();let enabled=false,state='stopped',sourceId=null,loop=false;
  const data=Buffer.from('synthetic-mp4-upload-bytes'),sha256=createHash('sha256').update(data).digest('hex');
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8'),dialog=html.match(/<dialog id="phone-camera-dialog"[\s\S]*?<\/dialog>/)[0];
  await page.addInitScript(()=>{
    Object.defineProperty(document,'cookie',{get:()=>'__Host-teamaibox-csrf=synthetic-only'});
    window.captures=0;navigator.mediaDevices.getUserMedia=()=>{window.captures++;throw Error('hardware capture forbidden');};
  });
  const snapshot=()=>({object:'virtual_phone.camera',phoneId,generation:1,state,sourceKind:'video',loop,
    ...(sourceId?{sourceId}:{}),capabilities:{image:true,browser:true,video:enabled},...(state==='active'?{inputState:'receiving'}:{})});
  await page.route(origin+'/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/plugins/official.virtual-phones/app.css"><link rel="stylesheet" href="/plugins/official.virtual-phones/phone-camera.css"></head><body><button id="open">Camera</button><button id="indicator" hidden></button>${dialog}<script type="module">import {createPhoneCamera} from '/plugins/official.virtual-phones/phone-camera.mjs';window.ui=createPhoneCamera({element:document.querySelector('dialog'),getPhone:()=>({id:'${phoneId}',generation:1,state:'running'}),indicator:document.querySelector('#indicator')});document.querySelector('#open').onclick=()=>ui.open();</script></body></html>`});
    if(path.startsWith('/plugins/'))return route.fulfill({response:await route.fetch({url:local+path})});
    calls.push({method,path});if(method!=='GET')assert.equal(request.headers()['x-csrf-token'],'synthetic-only');
    if(path===`/api/v1/virtual-phones/${phoneId}/camera`){
      if(method==='POST'){
        const value=request.postDataJSON();assert.deepEqual(value.source,{kind:'video',continueWithoutViewer:true,loop:true,
          file:{objectId,objectVersion:1,name:'相机.mp4',sizeBytes:data.length,sha256}});
        sourceId=value.requestId;loop=value.source.loop;state='active';
      }
      if(method==='DELETE'){assert.equal(request.postDataJSON().sourceId,sourceId);state='stopped';}
      return reply(snapshot());
    }
    if(path==='/api/v1/objects/multipart'){
      const value=request.postDataJSON();assert.equal(value.size,data.length);assert.equal(value.sha256,sha256);assert.equal(value.capability,'virtual_phone');
      return reply({upload:{uploadId}});
    }
    if(path.endsWith('/parts/1')){assert.deepEqual(request.postDataBuffer(),data);return reply({stored:true});}
    if(path===`/api/v1/objects/multipart/${uploadId}`)return reply({object:{objectId,version:1,size:data.length,integrity:{digest:sha256}}});
    throw Error('unexpected route');
  });
  await page.goto(origin+'/test');await page.locator('#open').click();await page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  assert.equal(await page.locator('#phone-camera-tab-video').isVisible(),false);
  enabled=true;await page.locator('#phone-camera-refresh').click();await page.locator('#phone-camera-tab-video').click();
  assert.match(await page.locator('#phone-camera-image-panel').innerText(),/H.264/);
  assert.doesNotMatch(await page.locator('#phone-camera-image-panel').innerText(),/64 MiB|10 分钟|1080p/);
  assert.equal(await page.locator('#phone-camera-loop').isChecked(),false);
  await page.locator('#phone-camera-input').setInputFiles({name:'相机.mp4',mimeType:'video/mp4',buffer:data});
  assert.equal(await page.locator('#phone-camera-start').isEnabled(),false);
  await page.locator('#phone-camera-consent').check();await page.locator('#phone-camera-loop').check();await page.locator('#phone-camera-start').click();
  await page.getByText('正在播放视频',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('#phone-camera-stop').disabled);
  assert.equal(await page.locator('#indicator').innerText(),'摄像头 · 视频');assert.equal(await page.locator('#phone-camera-loop').isChecked(),true);
  assert.equal(await page.locator('#phone-camera-tab-image').isEnabled(),false);
  const starts=()=>calls.filter(c=>c.method==='POST'&&c.path.endsWith('/camera')).length;
  assert.equal(starts(),1);await page.locator('#phone-camera-close').click();await page.locator('#open').click();
  await page.getByText('正在播放视频',{exact:true}).waitFor();assert.equal(await page.locator('#phone-camera-loop').isChecked(),true);assert.equal(starts(),1);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  const directory=await mkdtemp(join(tmpdir(),'phone-video-camera-ui-')),screenshot=join(directory,'video-camera.png');await page.screenshot({path:screenshot});t.diagnostic('UI screenshot: '+screenshot);
  await page.locator('#phone-camera-stop').click();await page.getByText('摄像头输入已关闭',{exact:true}).waitFor();
  await page.locator('#phone-camera-tab-image').click();assert.equal(await page.locator('#phone-camera-loop-label').isVisible(),false);
  assert.equal(await page.locator('#phone-camera-input').getAttribute('accept'),'image/jpeg,image/png,image/webp');
  await page.reload();await page.locator('#open').click();await page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  assert.equal(starts(),1);assert.equal(await page.evaluate(()=>captures),0);assert.deepEqual(errors,[]);
});
