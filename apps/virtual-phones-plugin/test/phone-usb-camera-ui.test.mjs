import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Real UI/Chromium, synthetic API and no physical camera. Actual USB/Android
// and the installed ordinary-member path remain separate qualification gates.
test('USB picker is gated, explicit, current-phone bound, handles busy/replug and never captures this browser',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://phone-usb.test',browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1100,height:820}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  const phoneId=randomUUID(),runId=randomUUID(),deviceId=randomUUID(),root=`/api/v1/virtual-phones/${phoneId}/camera`;
  let enabled=false,state='stopped',sourceId,attachmentId='a'.repeat(64),available=true,busy=true;
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8'),dialog=html.match(/<dialog id="phone-camera-dialog"[\s\S]*?<\/dialog>/)[0];
  await page.addInitScript(()=>{Object.defineProperty(document,'cookie',{get:()=>'__Host-teamaibox-csrf=synthetic-only'});
    window.captures=0;navigator.mediaDevices.getUserMedia=()=>{window.captures++;throw Error('unexpected browser camera');};});
  const snapshot=()=>({object:'virtual_phone.camera',phoneId,generation:1,state,...(sourceId?{sourceId,sourceKind:'usb'}:{}),capabilities:{image:true,browser:true,video:true,usb:enabled}});
  await page.route(origin+'/**',async route=>{
    const r=route.request(),url=new URL(r.url()),path=url.pathname,method=r.method();
    const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/plugins/official.virtual-phones/app.css"><link rel="stylesheet" href="/plugins/official.virtual-phones/phone-camera.css"></head><body><button id="open">Camera</button><button id="indicator" hidden></button>${dialog}<script type="module">import {createPhoneCamera} from '/plugins/official.virtual-phones/phone-camera.mjs';window.ui=createPhoneCamera({element:document.querySelector('dialog'),getPhone:()=>({id:'${phoneId}',generation:1,state:'running'}),indicator:document.querySelector('#indicator')});document.querySelector('#open').onclick=()=>ui.open();</script></body></html>`});
    if(path.startsWith('/plugins/'))return route.fulfill({response:await route.fetch({url:local+path})});
    if(path===root+'/usb-devices'){assert.equal(url.search,'?generation=1');return reply({object:'list',phoneId,runId,generation:1,
      data:available?[{deviceId,attachmentId,name:'FHD USB Camera',formats:['MJPG']}]:[]});}
    if(path===root){
      if(method==='POST'){
        assert.equal(r.headers()['x-csrf-token'],'synthetic-only');const value=r.postDataJSON();posts.push(value);
        assert.deepEqual(value.source,{kind:'usb',deviceId,attachmentId,continueWithoutViewer:true});assert.equal(value.expectedGeneration,1);
        if(busy)return reply({error:{code:'phone_camera_usb_busy'}},409);
        state='active';sourceId=value.requestId;
      }
      if(method==='DELETE'){assert.equal(r.postDataJSON().sourceId,sourceId);state='stopped';}
      return reply(snapshot());
    }
    throw Error('Unexpected path '+path);
  });
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  await page.goto(origin+'/test');await page.locator('#open').click();await ready();
  assert.equal(await page.locator('#phone-camera-tab-usb').isVisible(),false);enabled=true;
  await page.locator('#phone-camera-refresh').click();await ready();await page.locator('#phone-camera-tab-usb').click();await ready();
  assert.equal(await page.locator('#phone-camera-usb-device').inputValue(),'');assert.equal(posts.length,0);
  await page.locator('#phone-camera-usb-device').selectOption(deviceId);
  assert.equal(await page.locator('#phone-camera-usb-start').isEnabled(),false);
  await page.locator('#phone-camera-usb-consent').check();await page.locator('#phone-camera-usb-start').click();await ready();
  assert.match(await page.locator('#phone-camera-status').innerText(),/正在使用中/);assert.equal(posts.length,1);
  // Refresh/replug clears the previously selected attachment and permission
  // checkbox. No implicit retry on polling, reopening or device arrival.
  attachmentId='b'.repeat(64);await page.locator('#phone-camera-usb-refresh').click();await ready();
  assert.equal(await page.locator('#phone-camera-usb-device').inputValue(),'');assert.equal(await page.locator('#phone-camera-usb-consent').isChecked(),false);
  busy=false;await page.locator('#phone-camera-usb-device').selectOption(deviceId);await page.locator('#phone-camera-usb-consent').check();
  await page.locator('#phone-camera-usb-start').click();await ready();assert.equal(await page.locator('#indicator').innerText(),'摄像头 · USB');
  assert.equal(await page.locator('#phone-camera-usb-refresh').isEnabled(),false);
  await page.locator('#phone-camera-close').click();await page.locator('#open').click();await ready();assert.equal(posts.length,2);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  const dir=await mkdtemp(join(tmpdir(),'phone-usb-camera-ui-')),screenshot=join(dir,'usb-camera.png');await page.screenshot({path:screenshot});t.diagnostic('UI screenshot: '+screenshot);
  await page.locator('#phone-camera-stop').click();await ready();available=false;
  await page.locator('#phone-camera-usb-refresh').click();await ready();assert.equal(await page.locator('#phone-camera-usb-empty').isVisible(),true);
  await page.reload();await page.locator('#open').click();await ready();assert.equal(posts.length,2);
  assert.equal(await page.evaluate(()=>captures),0);assert.deepEqual(errors,[]);
});
