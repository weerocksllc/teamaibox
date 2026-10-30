import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Actual UI/Chromium, synthetic camera/peer/API. Never a physical permission
// claim or an Android media result; those need their own end-to-end run.
test('browser camera UI is gated, explicit, visible and stops on lost lease or phone exit',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://camera-ui.test';
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const phoneId='10000000-0000-4000-8000-000000000001';let sourceId=null,state='stopped',enabled=false,lost=false;const calls=[];
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8'),dialog=html.match(/<dialog id="phone-camera-dialog"[\s\S]*?<\/dialog>/)[0];
  await page.addInitScript(()=>{
    Object.defineProperty(document,'cookie',{get:()=>'__Host-teamaibox-csrf=synthetic-only'});
    window.permissionCalls=0;window.deny=false;
    navigator.permissions.query=async()=>Object.assign(new EventTarget(),{state:'granted'});
    navigator.mediaDevices.getUserMedia=async spec=>{
      window.permissionCalls++;if(spec.audio!==false)throw Error('unexpected microphone');
      if(window.deny)throw Object.assign(Error(),{name:'NotAllowedError'});
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#26765a';ctx.fillRect(0,0,640,480);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,320,240);
      const stream=canvas.captureStream(15);window.syntheticTrack=stream.getVideoTracks()[0];return stream;
    };
    window.RTCPeerConnection=class extends EventTarget{
      iceGatheringState='complete';connectionState='new';
      addTransceiver(){return {setCodecPreferences(){}};}
      async createOffer(){return {type:'offer',sdp:'synthetic-offer'};}
      async setLocalDescription(value){this.localDescription=value;}
      async setRemoteDescription(){this.connectionState='connected';this.onconnectionstatechange?.();}
      close(){this.connectionState='closed';}
    };
  });
  await page.route(origin+'/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const reply=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/plugins/official.virtual-phones/app.css"><link rel="stylesheet" href="/plugins/official.virtual-phones/phone-camera.css"></head><body><button id="open">Camera</button><button id="indicator" hidden></button>${dialog}<script type="module">import {createPhoneCamera} from '/plugins/official.virtual-phones/phone-camera.mjs';window.phone={id:'${phoneId}',generation:1,state:'running'};window.ui=createPhoneCamera({element:document.querySelector('dialog'),getPhone:()=>phone,indicator:document.querySelector('#indicator')});document.querySelector('#open').onclick=()=>ui.open();</script></body></html>`});
    if(path.startsWith('/plugins/')){const response=await fetch(local+path);return route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')},body:Buffer.from(await response.arrayBuffer())});}
    const body=method==='GET'?null:request.postDataJSON();calls.push({path,method,body});
    if(path.endsWith('/heartbeat'))return reply(lost?{error:{code:'phone_camera_source_stopped'}}:{sourceId,expiresInMilliseconds:4000},lost?409:200);
    if(path.endsWith('/offer'))return reply({sourceId,answerSdp:'synthetic-answer'});
    assert.equal(path,`/api/v1/virtual-phones/${phoneId}/camera`);
    if(method==='POST'){assert.deepEqual(body.source,{kind:'browser',continueWithoutViewer:false});sourceId=body.requestId;state='active';}
    if(method==='DELETE'){assert.equal(body.sourceId,sourceId);state='stopped';}
    return reply({object:'virtual_phone.camera',phoneId,generation:1,state,sourceKind:'browser',...(sourceId?{sourceId}:{}),
      capabilities:{image:true,browser:enabled,usb:false,video:false,udp:false},...(state==='active'?{inputState:'receiving'}:{})},method==='POST'?201:200);
  });
  await page.goto(origin+'/test');await page.locator('#open').click();await page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  assert.equal(await page.locator('#phone-camera-source-tabs').isVisible(),false);assert.equal(await page.evaluate(()=>permissionCalls),0);
  enabled=true;await page.locator('#phone-camera-refresh').click();await page.locator('#phone-camera-tab-browser').click();
  assert.equal(await page.evaluate(()=>permissionCalls),0);await page.locator('#phone-camera-browser-start').click();
  await page.getByText('正在使用浏览器摄像头',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('#phone-camera-stop').disabled);
  assert.equal(await page.locator('#phone-camera-local-preview').isVisible(),true);assert.equal(await page.evaluate(()=>permissionCalls),1);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  const dir=await mkdtemp(join(tmpdir(),'phone-browser-camera-ui-'));const shot=join(dir,'browser-camera.png');await page.screenshot({path:shot});t.diagnostic('UI screenshot: '+shot);
  await page.locator('#phone-camera-close').click();assert.equal(await page.evaluate(()=>syntheticTrack.readyState),'live','closing settings returns to phone, not away from phone');
  lost=true;
  try{await page.waitForFunction(()=>syntheticTrack.readyState==='ended',{},{timeout:6000});}
  catch(error){t.diagnostic(JSON.stringify({calls:calls.map(c=>({path:c.path,method:c.method})),errors,local:await page.evaluate(()=>({permissions:permissionCalls,track:syntheticTrack.readyState}))}));throw error;}
  assert.equal(await page.evaluate(()=>permissionCalls),1);
  await page.locator('#open').click();await page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  lost=false;await page.locator('#phone-camera-tab-browser').click();await page.locator('#phone-camera-browser-start').click();
  await page.waitForFunction(()=>permissionCalls===2&&syntheticTrack.readyState==='live'&&!document.querySelector('#phone-camera-stop').disabled);
  await page.evaluate(()=>ui.reset());assert.equal(await page.evaluate(()=>syntheticTrack.readyState),'ended');
  assert.equal(await page.locator('dialog').evaluate(el=>el.open),false);
  await page.waitForTimeout(100);assert.ok(calls.some(c=>c.method==='DELETE'));assert.deepEqual(errors,[]);
});
