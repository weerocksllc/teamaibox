import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Real Chromium layout/input with explicitly SYNTHETIC phone/API/RTC fixtures.
// This is not real Android, LAN, TLS trust or product acceptance.
test('phone workspace puts video first, auto-connects, maps input and leaves Android running',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async()=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://phone-workspace.test';
  let browser;
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});
    const errors=[],requests=[];let connectionFailures=0;page.on('pageerror',e=>errors.push(e.message));
    const phone={object:'virtual_phone',id:'00000000-0000-4000-8000-000000000101',name:'办公手机',state:'running',revision:1,runningCharged:true};
    await page.addInitScript(()=>{
      Object.defineProperty(document,'cookie',{get:()=> '__Host-teamaibox-csrf=fixture-only'});
      window.syntheticInputs=[];window.syntheticClosedPeers=0;window.syntheticSockets=[];
      class SyntheticSocket{
        constructor(){this.readyState=1;this.bufferedAmount=0;window.syntheticSockets.push(this);queueMicrotask(()=>this.onopen?.());}
        send(raw){const value=JSON.parse(raw);const deliver=message=>queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(message)}));
          if(value.type==='phone.authenticate')deliver({type:'phone.signal.ready'});
          else if(value.message_type==='connect')deliver({message_type:'device_info',device_info:{}});
          else if(value.payload?.type==='request-offer')deliver({message_type:'device_msg',payload:{type:'offer',sdp:'explicit-synthetic-sdp'}});
        }close(){if(this.readyState===3)return;this.readyState=3;this.onclose?.();}
      }
      class SyntheticPeer{
        constructor(){this.connectionState='new';this.stream=null;}
        async getStats(){window.syntheticStatsReads=(window.syntheticStatsReads||0)+1;return new Map([
          ['v',{type:'inbound-rtp',kind:'video',frameWidth:720,frameHeight:1280,framesDecoded:123,framesPerSecond:30}],
          ['a',{type:'inbound-rtp',kind:'audio',totalAudioEnergy:1.25}]]);}
        createDataChannel(label){return {label,readyState:'open',bufferedAmount:0,send(raw){window.syntheticInputs.push(JSON.parse(raw));},close(){this.readyState='closed';}};}
        async setRemoteDescription(value){this.remoteDescription=value;}
        async addIceCandidate(){}async createAnswer(){return {type:'answer',sdp:'explicit-synthetic-answer'};}
        async setLocalDescription(){
          const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;
          const draw=canvas.getContext('2d');draw.fillStyle='#244638';draw.fillRect(0,0,720,1280);draw.fillStyle='white';draw.font='32px sans-serif';draw.fillText('SYNTHETIC UI TEST',160,640);
          this.stream=canvas.captureStream(1);this.ontrack?.({track:this.stream.getVideoTracks()[0]});
          this.connectionState='connected';this.onconnectionstatechange?.();
          this.ondatachannel?.({channel:this.createDataChannel('device-control')});
        }
        close(){if(this.connectionState==='closed')return;this.connectionState='closed';this.stream?.getTracks().forEach(t=>t.stop());window.syntheticClosedPeers++;}
      }
      window.WebSocket=SyntheticSocket;window.RTCPeerConnection=SyntheticPeer;
    });
    await page.route(origin+'/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(!path.startsWith('/api/'))return route.fulfill({response:await route.fetch({url:local+path})});
      requests.push({path,method:request.method()});
      const reply=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path.endsWith('/availability'))return reply({object:'virtual_phone.availability',enabled:true,runtimeConfigured:true});
      if(request.method()==='POST'&&path.endsWith('/adb-grants')){
        assert.deepEqual(request.postDataJSON(),{ttlSeconds:900});
        return reply({object:'virtual_phone.connection_ticket',phoneId:phone.id,id:crypto.randomUUID(),token:'c'.repeat(43),kind:'adb',
          expiresAt:new Date(Date.now()+900000).toISOString(),connectionExpiresAt:new Date(Date.now()+60000).toISOString()});
      }
      if(request.method()==='POST'&&path.endsWith('/connections')){
        if(connectionFailures-->0)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'phone_runtime_unavailable'}})});
        return reply({object:'virtual_phone.connection_ticket',phoneId:phone.id,id:crypto.randomUUID(),token:'b'.repeat(43),kind:'control'});
      }
      if(request.method()==='DELETE')return reply({closed:true});
      return reply({object:'list',data:[phone],quota:{stored:1,running:1,storedPerUser:2,runningPerUser:2}});
    });
    await page.goto(origin+'/plugins/official.virtual-phones');
    await page.locator('button[data-action=open]').click();
    await page.waitForFunction(()=>document.querySelector('#phone-video').videoWidth===720);
    assert.equal(await page.locator('#phone-connection').innerText(),'已连接');
    assert.equal(requests.some(r=>r.path.includes('adb-grants')),false,'merely opening a phone never opens ADB');
    assert.equal(await page.evaluate(()=>window.syntheticStatsReads||0),0,'no background diagnostics until requested');
    await page.locator('#phone-workspace-more summary').click();await page.locator('#phone-open-diagnostics').click();
    await page.waitForFunction(()=>document.querySelector('#phone-diagnostics dl').textContent.includes('123'));
    assert.match(await page.locator('#phone-diagnostics').innerText(),/累计音频能量/);
    await page.locator('#phone-close-diagnostics').click();
    const reads=await page.evaluate(()=>window.syntheticStatsReads);await new Promise(r=>setTimeout(r,1150));
    assert.equal(await page.evaluate(()=>window.syntheticStatsReads),reads,'collapsed diagnostics stop polling');
    await page.locator('#phone-workspace-more summary').click();await page.locator('#phone-open-adb').click();
    assert.equal(await page.locator('#phone-adb-status').innerText(),'调试已关闭。');
    await page.locator('#phone-adb-enable').click();await page.locator('#phone-adb-issued').waitFor({state:'visible'});
    assert.equal(await page.locator('#phone-adb-token').getAttribute('type'),'password');assert.equal(await page.locator('#phone-adb-token').inputValue(),'c'.repeat(43));
    assert.doesNotMatch(await page.locator('#phone-adb-command').innerText(),/c{43}/);
    assert.match(await page.locator('#phone-adb-command').innerText(),/node --use-system-ca/);
    assert.equal(await page.locator('#phone-adb-enable').isDisabled(),true,'cannot accidentally issue duplicate grants');
    assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:Object.entries(sessionStorage)})),
      {local:0,session:[['teamaibox.virtual-phone.selection.v1',phone.id]]},'only the navigation ID may persist; no media or ADB credential');
    const download=page.waitForEvent('download');await page.getByRole('link',{name:'下载连接工具'}).click();
    assert.equal((await download).suggestedFilename(),'phone-adb-cli.mjs');
    if(process.env.TEAMAIBOX_PHONE_UI_SCREENSHOT)await page.screenshot({path:process.env.TEAMAIBOX_PHONE_UI_SCREENSHOT});
    await page.locator('#phone-adb-disable').click();await page.waitForFunction(()=>document.querySelector('#phone-adb-status').textContent==='调试已关闭。');
    assert.equal(await page.locator('#phone-adb-token').inputValue(),'');assert.equal(await page.locator('#phone-adb-command').innerText(),'');
    assert.equal(await page.locator('#phone-connection').innerText(),'已连接','debug close does not stop viewing');
    await page.locator('#phone-adb-dismiss').click();
    const video=page.locator('#phone-video'),box=await video.boundingBox();
    assert.ok(box.y<120&&box.height>500,'video is visible in the first viewport');
    await video.click();await page.keyboard.press('a');await page.locator('[data-phone-control=home]').click();
    const inputs=await page.evaluate(()=>window.syntheticInputs);
    assert.ok(inputs.some(x=>x.type==='multi-touch'&&x.down===1));assert.ok(inputs.some(x=>x.type==='keyboard'&&x.keycode==='KeyA'));
    assert.ok(inputs.some(x=>x.command==='home'&&x.button_state==='up'));
    await video.focus();await page.keyboard.press('Tab');assert.equal(await video.evaluate(el=>document.activeElement===el),false,'Tab can leave the phone without trapping browser focus');
    const beforeReconnect=requests.filter(x=>x.method==='POST').length;
    await page.evaluate(()=>window.syntheticSockets.at(-1).close());
    await page.waitForFunction(()=>window.syntheticSockets.length===2&&document.querySelector('#phone-connection').textContent==='已连接');
    assert.equal(requests.filter(x=>x.method==='POST').length,beforeReconnect+1,'a dropped connection automatically consumes a new ticket');
    assert.ok(!requests.some(x=>x.path.endsWith('/start')||x.path.endsWith('/stop')),'reconnection does not restart Android');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const narrow=await video.boundingBox();assert.ok(narrow.y+narrow.height<780&&narrow.height>400);
    await page.locator('#phone-workspace-more summary').click();await page.locator('#phone-open-adb').click();await page.locator('#phone-adb-enable').click();
    await page.locator('#phone-adb-issued').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>document.querySelector('#phone-adb-dialog').scrollWidth<=innerWidth),true);
    await page.locator('#phone-adb-dismiss').click();
    await page.locator('#phone-return').click();await page.locator('#phone-workspace').waitFor({state:'hidden'});
    assert.equal(await page.locator('#phone-adb-token').inputValue(),'');
    assert.equal(requests.filter(r=>r.method==='DELETE'&&r.path.includes('/adb-grants/')).length,2,'leaving requests exact debug revocation');
    await page.waitForFunction(()=>window.syntheticClosedPeers===2);
    assert.ok(requests.some(x=>x.method==='DELETE'&&x.path.includes('/connections/')));
    assert.ok(!requests.some(x=>x.path.endsWith('/stop')),'returning never shuts down a phone');
    await page.locator('button[data-action=open]').click();await page.waitForFunction(()=>document.querySelector('#phone-video').videoWidth===720);
    const count=requests.filter(x=>x.method==='POST').length;
    await page.goto(origin+'/plugins/official.virtual-phones');await page.waitForFunction(()=>document.querySelector('#phone-video').videoWidth===720);
    assert.equal(requests.filter(x=>x.method==='POST').length,count+1,'recreated iframe without old hash automatically requests a fresh connection');
    // Explicit synthetic reboot outage: more than three failures, then recover.
    const beforeBoot=requests.filter(x=>x.method==='POST').length;
    const socketsBefore=await page.evaluate(()=>window.syntheticSockets.length);
    connectionFailures=4;
    await page.evaluate(()=>window.syntheticSockets.at(-1).close());
    await page.waitForFunction(n=>window.syntheticSockets.length===n+1&&document.querySelector('#phone-connection').textContent==='已连接',socketsBefore,{timeout:25000});
    assert.equal(requests.filter(x=>x.method==='POST').length,beforeBoot+5);
    assert.ok(!requests.some(x=>x.path.endsWith('/start')||x.path.endsWith('/stop')));
    // A loss immediately followed by leaving the workspace cancels retry.
    await page.evaluate(()=>window.syntheticSockets.at(-1).close());await page.locator('#phone-return').click();
    const beforeLeaving=requests.filter(x=>x.method==='POST').length;await page.waitForTimeout(1300);
    assert.equal(requests.filter(x=>x.method==='POST').length,beforeLeaving);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
