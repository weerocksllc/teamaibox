import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Actual browser UI with explicit synthetic API. Not a live Android result.
test('network input stays gated, discloses unencrypted UDP, waits and stops without hardware capture',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://phone-network.test',browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1100,height:820}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  const phoneId=randomUUID(),runId=randomUUID(),policyId=randomUUID(),root=`/api/v1/virtual-phones/${phoneId}/camera`;
  let enabled=false,state='stopped',sourceId,busy=true,inputState='waiting';
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8'),dialog=html.match(/<dialog id="phone-camera-dialog"[\s\S]*?<\/dialog>/)[0];
  await page.addInitScript(()=>{Object.defineProperty(document,'cookie',{get:()=>'__Host-teamaibox-csrf=synthetic-only'});window.captures=0;navigator.mediaDevices.getUserMedia=()=>{window.captures++;throw Error('unexpected camera');};});
  const snapshot=()=>({object:'virtual_phone.camera',phoneId,generation:1,state,inputState,...(sourceId?{sourceId,sourceKind:'udp',policyId,policyRevision:2}:{}),capabilities:{image:true,browser:true,video:true,usb:true,udp:enabled}});
  await page.route(origin+'/**',async route=>{
    const r=route.request(),url=new URL(r.url()),path=url.pathname,method=r.method();
    const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/plugins/official.virtual-phones/app.css"><link rel="stylesheet" href="/plugins/official.virtual-phones/phone-camera.css"></head><body><button id="open">Camera</button><button id="indicator" hidden></button>${dialog}<script type="module">import {createPhoneCamera} from '/plugins/official.virtual-phones/phone-camera.mjs';window.ui=createPhoneCamera({element:document.querySelector('dialog'),getPhone:()=>({id:'${phoneId}',generation:1,state:'running'}),indicator:document.querySelector('#indicator')});document.querySelector('#open').onclick=()=>ui.open();</script></body></html>`});
    if(path.startsWith('/plugins/'))return route.fulfill({response:await route.fetch({url:local+path})});
    if(path===root+'/network-sources'){assert.equal(url.search,'?generation=1');return reply({object:'list',phoneId,runId,generation:1,data:[{policyId,policyRevision:2,name:'会议摄像头',listenAddress:'10.64.0.19',listenPort:24100,allowedSources:['10.64.0.8/32'],externalInputEncrypted:false,format:'UDP/MPEG-TS/H.264'}]});}
    if(path===root){
      if(method==='POST'){
        assert.equal(r.headers()['x-csrf-token'],'synthetic-only');const value=r.postDataJSON();posts.push(value);
        assert.deepEqual(value.source,{kind:'udp',policyId,policyRevision:2,continueWithoutViewer:true});assert.equal(value.expectedGeneration,1);
        if(busy)return reply({error:{code:'phone_camera_udp_port_unavailable'}},409);
        state='active';sourceId=value.requestId;
      }
      if(method==='DELETE'){assert.equal(r.postDataJSON().sourceId,sourceId);state='stopped';}
      return reply(snapshot());
    }
    throw Error('Unexpected path '+path);
  });
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#phone-camera-refresh').disabled);
  await page.goto(origin+'/test');await page.locator('#open').click();await ready();assert.equal(await page.locator('#phone-camera-tab-udp').isVisible(),false);
  enabled=true;await page.locator('#phone-camera-refresh').click();await ready();await page.locator('#phone-camera-tab-udp').click();await ready();
  await page.locator('#phone-camera-udp-source').selectOption(policyId);assert.equal(await page.locator('#phone-camera-udp-start').isEnabled(),false);
  assert.match(await page.locator('#phone-camera-udp-panel').innerText(),/不加密/);assert.equal(await page.locator('#phone-camera-udp-address').innerText(),'udp://10.64.0.19:24100');
  await page.locator('#phone-camera-udp-consent').check();await page.locator('#phone-camera-udp-start').click();await ready();assert.match(await page.locator('#phone-camera-status').innerText(),/端口/);
  busy=false;await page.locator('#phone-camera-udp-start').click();await ready();assert.equal(await page.locator('#phone-camera-state').innerText(),'已开启，等待推流');
  inputState='receiving';await page.locator('#phone-camera-refresh').click();await ready();assert.equal(await page.locator('#phone-camera-state').innerText(),'正在接收网络画面');
  await page.locator('#phone-camera-close').click();await page.locator('#open').click();await ready();assert.equal(posts.length,2);
  assert.equal(await page.locator('#phone-camera-udp-address').innerText(),'udp://10.64.0.19:24100');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.locator('#phone-camera-stop').click();await ready();await page.reload();await page.locator('#open').click();await ready();assert.equal(posts.length,2);
  assert.equal(await page.evaluate(()=>captures),0);assert.deepEqual(errors,[]);
});
