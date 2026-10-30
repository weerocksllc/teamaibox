import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Real Chromium and production UI; API responses are explicitly synthetic.
// Actual Android pixels are qualified separately, never inferred from this UI.
test('camera dialog requires consent, streams only selected image and keeps input independent from the viewer',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://phone-camera.test';
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],calls=[],parts=[],aborted=[];
  page.on('pageerror',e=>errors.push(e.message));
  const phoneId=randomUUID(),objectId=randomUUID(),runId=randomUUID();let currentUpload,sourceId,supported=false,state='stopped',block=false,entered,release;
  const data=await readFile(new URL('../../../tools/fixtures/phone-camera-checker-v1.jpg',import.meta.url));
  const sha256=createHash('sha256').update(data).digest('hex');
  const source=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8'),dialog=source.match(/<dialog id="phone-camera-dialog"[\s\S]*?<\/dialog>/)[0];
  await page.addInitScript(()=>{window.csrf='__Host-teamaibox-csrf=fixture-only';Object.defineProperty(document,'cookie',{get:()=>window.csrf});
    navigator.mediaDevices.getUserMedia=()=>{throw Error('physical camera must not be requested');};});
  const snapshot=()=>({object:'virtual_phone.camera',phoneId,generation:1,runId,state,capabilities:{image:supported,browser:false,usb:false,video:false,udp:false},
    ...(sourceId?{sourceId,sourceKind:'image',continueWithoutViewer:true}:{}),...(state==='active'?{inputState:'receiving'}:{})});
  await page.route(origin+'/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/camera-ui-test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/plugins/official.virtual-phones/app.css"><link rel="stylesheet" href="/plugins/official.virtual-phones/phone-camera.css"></head><body><button id="open">Camera</button><button id="indicator" hidden></button>${dialog}<script type="module">import {createPhoneCamera} from '/plugins/official.virtual-phones/phone-camera.mjs';window.currentPhone={id:'${phoneId}',generation:1,state:'running'};window.cameraUI=createPhoneCamera({element:document.querySelector('dialog'),getPhone:()=>window.currentPhone,indicator:document.querySelector('#indicator')});document.querySelector('#open').onclick=()=>cameraUI.open();</script></body></html>`});
    if(!path.startsWith('/api/'))return route.fulfill({response:await route.fetch({url:local+path})});
    calls.push({path,method});if(method!=='GET')assert.equal(request.headers()['x-csrf-token'],'fixture-only');
    if(path===`/api/v1/virtual-phones/${phoneId}/camera`){
      if(method==='GET'){assert.equal(url.searchParams.get('generation'),'1');return reply(snapshot());}
      const body=request.postDataJSON();assert.equal(body.expectedGeneration,1);
      if(method==='DELETE'){assert.equal(body.sourceId,sourceId);state='stopped';return reply(snapshot());}
      assert.equal(body.source.kind,'image');assert.equal(body.source.continueWithoutViewer,true);
      assert.deepEqual(body.source.file,{objectId,objectVersion:1,name:'相机.jpg',sizeBytes:data.length,sha256});
      sourceId=body.requestId;state='active';return reply(snapshot());
    }
    if(path==='/api/v1/objects/multipart'){
      const body=request.postDataJSON();assert.equal(body.capability,'virtual_phone');assert.equal(body.size,data.length);assert.equal(body.sha256,sha256);
      currentUpload=randomUUID();parts.length=0;return reply({upload:{uploadId:currentUpload}});
    }
    if(path.includes('/parts/')){
      const bytes=request.postDataBuffer();assert.deepEqual(bytes,data);assert.equal(request.headers()['x-content-sha256'],sha256);
      if(block){entered();await new Promise(resolve=>release=resolve);return route.abort().catch(()=>{});}
      parts.push(bytes);return reply({stored:true});
    }
    if(path===`/api/v1/objects/multipart/${currentUpload}`){
      if(method==='DELETE'){aborted.push(currentUpload);return reply({aborted:true});}
      assert.deepEqual(Buffer.concat(parts),data);return reply({object:{objectId,version:1,size:data.length,integrity:{digest:sha256}}});
    }
    throw Error('unexpected request '+path);
  });
  await page.goto(origin+'/camera-ui-test');await page.locator('#open').click();
  await page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  assert.equal(await page.locator('#phone-camera-config').isVisible(),false);
  assert.match(await page.locator('#phone-camera-unavailable').innerText(),/不会自动更换系统/);
  supported=true;await page.locator('#phone-camera-refresh').click();await page.locator('#phone-camera-config').waitFor();
  await page.locator('#phone-camera-input').setInputFiles({name:'相机.jpg',mimeType:'image/jpeg',buffer:data});
  assert.equal(await page.locator('#phone-camera-start').isEnabled(),false,'image alone never authorizes input');
  await page.locator('#phone-camera-consent').check();await page.locator('#phone-camera-start').click();
  await page.getByText('正在使用图片',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('#phone-camera-stop').disabled);
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/camera')).length,1);assert.equal(await page.locator('#indicator').isVisible(),true);
  const mutations=()=>calls.filter(c=>c.method==='DELETE'&&c.path.endsWith('/camera')).length;
  await page.locator('#phone-camera-close').click();assert.equal(mutations(),0,'return to viewer does not close explicitly persistent input');
  assert.equal(await page.locator('dialog').evaluate(el=>el.open),false);
  await page.locator('#indicator').click();await page.waitForFunction(()=>!document.querySelector('#phone-camera-stop').disabled);
  await page.locator('#phone-camera-stop').click();await page.getByText('摄像头输入已关闭',{exact:true}).waitFor();
  assert.equal(mutations(),1);assert.equal(await page.locator('#phone-camera-consent').isChecked(),false);assert.equal(await page.locator('#indicator').isVisible(),false);
  await page.locator('#phone-camera-input').setInputFiles({name:'相机.jpg',mimeType:'image/jpeg',buffer:data});await page.locator('#phone-camera-consent').check();
  const before=calls.length;await page.evaluate(()=>window.csrf='__Host-teamaibox-csrf=first; __Host-teamaibox-csrf=second');
  await page.locator('#phone-camera-start').click();await page.waitForFunction(()=>!document.querySelector('#phone-camera-input').disabled);
  assert.equal(calls.length,before,'duplicate CSRF sends no upload');
  await page.evaluate(()=>window.csrf='__Host-teamaibox-csrf=fixture-only');
  block=true;const waiting=new Promise(resolve=>entered=resolve);await page.locator('#phone-camera-start').click();await waiting;
  await page.locator('#phone-camera-cancel').click();release();await page.waitForFunction(()=>!document.querySelector('#phone-camera-input').disabled);
  assert.equal(aborted.length,1);assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/camera')).length,1);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=innerWidth),true);
  const screenshot=join(await mkdtemp(join(tmpdir(),'phone-camera-ui-')),'camera.png');await page.screenshot({path:screenshot});t.diagnostic('UI screenshot: '+screenshot);
  await page.evaluate(()=>{window.currentPhone={...currentPhone,generation:2};cameraUI.refresh();});
  assert.equal(await page.locator('dialog').evaluate(el=>el.open),false);assert.equal(await page.locator('#phone-camera-input').inputValue(),'');
  assert.equal(calls.some(c=>c.path.includes('/media')||c.path.includes('/adb')),false);assert.deepEqual(errors,[]);
});
