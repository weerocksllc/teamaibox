import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

// Actual Chromium, production dialog/module; explicit synthetic HTTP responses.
// This tests UI behavior, not a deployed Android or member acceptance.
test('files dialog uploads exact multipart bytes, reports install failure, downloads and cancels safely', {
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
}, async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local=`http://127.0.0.1:${server.address().port}`,origin='https://phone-files.test';
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true});
  const errors=[],calls=[],parts=[],aborted=[];page.on('pageerror',error=>errors.push(error.message));
  const phoneId=randomUUID(),objectId=randomUUID(),referenceId=randomUUID();
  const data=Buffer.from('synthetic upload byte proof\0\xff'.repeat(180000)),sha256=createHash('sha256').update(data).digest('hex');
  let files=[],installFails=true,blockPart=false,releasePart=null,partEntered=null,currentUpload=null;
  const source=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8');
  const dialog=source.match(/<dialog id="phone-files-dialog"[\s\S]*?<\/dialog>/)[0];
  await page.addInitScript(()=>{window.testCsrf='fixture-only';Object.defineProperty(document,'cookie',{get:()=>window.testCsrf});});
  await page.route(origin+'/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    const reply=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/files-ui-test')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><link rel="stylesheet" href="/plugins/official.virtual-phones/phone-debug.css"></head><body>${dialog}<button id="open">Files</button><script type="module">import {createPhoneFiles} from '/plugins/official.virtual-phones/phone-files.mjs';window.currentPhone={id:'${phoneId}',state:'running',generation:1};window.filesUI=createPhoneFiles({element:document.querySelector('dialog'),getPhone:()=>window.currentPhone});document.querySelector('#open').onclick=()=>filesUI.open();</script></body></html>`});
    if(!path.startsWith('/api/'))return route.fulfill({response:await route.fetch({url:local+path})});
    calls.push({path,method});
    if(method!=='GET')assert.equal(request.headers()['x-csrf-token'],'fixture-only');
    if(path.endsWith('/files')&&method==='GET'){
      assert.equal(url.searchParams.get('generation'),'1');return reply({phoneId,data:files});
    }
    if(path==='/api/v1/objects/multipart'){
      const input=request.postDataJSON();assert.equal(input.capability,'virtual_phone');assert.equal(input.size,data.length);assert.equal(input.sha256,sha256);
      currentUpload=randomUUID();parts.length=0;return reply({upload:{uploadId:currentUpload}});
    }
    if(path.includes('/parts/')){
      const bytes=request.postDataBuffer();assert.equal(request.headers()['content-type'],'application/octet-stream');
      assert.equal(request.headers()['x-content-sha256'],createHash('sha256').update(bytes).digest('hex'));
      if(blockPart){partEntered?.();await new Promise(resolve=>releasePart=resolve);return route.abort().catch(()=>{});}
      parts.push(bytes);return reply({stored:true});
    }
    if(path===`/api/v1/objects/multipart/${currentUpload}`){
      if(method==='DELETE'){aborted.push(currentUpload);return reply({aborted:true});}
      assert.deepEqual(Buffer.concat(parts),data);assert.equal(request.postDataJSON().parts.length,parts.length);
      return reply({object:{objectId,version:1,size:data.length,integrity:{digest:sha256}}});
    }
    if(path.endsWith('/files')||path.endsWith('/installations')){
      const input=request.postDataJSON();assert.equal(input.expectedGeneration,1);assert.equal(input.file.objectId,objectId);assert.equal(input.file.sha256,sha256);
      if(path.endsWith('/installations')&&installFails)return reply({error:{code:'phone_install_failed'}},422);
      files=[{name:'会议.bin',sizeBytes:data.length}];return reply({phoneId,name:'会议.bin',sha256,installed:true});
    }
    if(path.endsWith('/file-exports'))return reply({phoneId,objectId,sizeBytes:data.length,sha256});
    if(path.endsWith('/references'))return reply({reference_id:referenceId});
    if(path.endsWith('/content'))return route.fulfill({contentType:'application/octet-stream',headers:{'content-length':String(data.length)},body:data});
    throw Error('unexpected synthetic route '+path);
  });
  await page.goto(origin+'/files-ui-test');
  await page.evaluate(()=>window.testCsrf='__Host-teamaibox-csrf=fixture-only');
  await page.locator('#open').click();await page.getByText('此目录还没有文件。').waitFor();
  await page.locator('#phone-file-input').setInputFiles({name:'会议.bin',mimeType:'application/octet-stream',buffer:data});
  await page.locator('#phone-file-upload').click();await page.waitForFunction(()=>document.querySelector('#phone-file-status').textContent==='已完成。'&&document.querySelector('#phone-file-input').value==='');
  assert.equal(parts.length,2);assert.ok(await page.locator('#phone-file-list').innerText().then(v=>v.includes('会议.bin')));
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载',exact:true}).click();
  const download=await downloadEvent;assert.equal(download.suggestedFilename(),'会议.bin');assert.deepEqual(await readFile(await download.path()),data);
  await page.waitForFunction(()=>!document.querySelector('#phone-file-input').disabled);
  await page.locator('#phone-file-input').setInputFiles({name:'会议.bin',mimeType:'application/octet-stream',buffer:data});
  page.on('dialog',()=>assert.fail('installation must not use browser-native dialogs'));
  await page.locator('#phone-file-install').click();await page.locator('#phone-install-yes').click();
  await page.getByText('Android 拒绝了这个 APK，未确认安装成功。').waitFor();
  installFails=false;const before=calls.length;
  await page.locator('#phone-file-install').click();await page.locator('#phone-install-no').click();await page.waitForFunction(()=>!document.querySelector('#phone-file-input').disabled);
  assert.equal(calls.length,before,'declining installation sends no upload');
  assert.equal(await page.locator('#phone-file-status').innerText(),'已取消安装，未上传文件。');
  // A duplicate CSRF cookie fails before any mutation leaves the browser.
  await page.evaluate(()=>window.testCsrf='__Host-teamaibox-csrf=fixture-only; __Host-teamaibox-csrf=duplicate');
  await page.locator('#phone-file-upload').click();await page.waitForFunction(()=>!document.querySelector('#phone-file-input').disabled);
  assert.equal(calls.length,before);
  await page.evaluate(()=>window.testCsrf='__Host-teamaibox-csrf=fixture-only');
  blockPart=true;const waiting=new Promise(resolve=>partEntered=resolve);
  await page.locator('#phone-file-upload').click();await waiting;
  await page.locator('#phone-file-cancel').click();releasePart();
  await page.waitForFunction(()=>!document.querySelector('#phone-file-input').disabled);
  assert.equal(aborted.length,1);assert.match(await page.locator('#phone-file-status').innerText(),/已中断传输/);
  assert.equal(calls.filter(c=>c.path.endsWith('/files')&&c.method==='POST').length,1,'cancelled transfer never submitted to Android');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.querySelector('dialog').scrollWidth<=innerWidth),true);
  await page.evaluate(()=>{window.currentPhone={...currentPhone,generation:2};filesUI.refresh();});
  assert.equal(await page.locator('dialog').evaluate(el=>el.open),false,'changing run closes stale file controls');
  assert.equal(await page.locator('#phone-file-input').inputValue(),'');assert.deepEqual(errors,[]);
});
