import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';

test('owner list survives refresh, shows input, and stops without opening phone media',{
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT,timeout:60000,
},async t=>{
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],calls=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{Object.defineProperty(document,'cookie',{get:()=>'__Host-teamaibox-csrf=synthetic-only'});navigator.mediaDevices.getUserMedia=()=>{throw Error('unexpected physical camera');};});
  const origin=`http://127.0.0.1:${server.address().port}`,phoneId='00000000-0000-4000-8000-000000000101',sourceId='00000000-0000-4000-8000-000000000102';let state='active';
  const rom={id:'aosp-camera-17-16102939-v1',familyId:'aosp',name:'Android AOSP',version:'Android 17',googlePlay:false,experimental:true,cameraCapability:'verified'};
  const input=()=>({generation:1,state,...(state!=='stopped'?{sourceId,sourceKind:'image'}:{})});
  await page.route(origin+'/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();calls.push({path,method});
    const reply=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(path==='/api/v1/virtual-phones'&&method==='GET')return reply({object:'list',quota:{stored:1,running:1,storedPerUser:2,runningPerUser:2},data:[{object:'virtual_phone',id:phoneId,name:'测试手机',state:'running',generation:1,revision:1,runningCharged:true,rom,cameraInput:input()}]});
    if(path.endsWith('/availability'))return reply({object:'virtual_phone.availability',enabled:true,runtimeConfigured:true});
    assert.equal(path,`/api/v1/virtual-phones/${phoneId}/camera`);
    if(method==='DELETE'){assert.deepEqual(request.postDataJSON(),{expectedGeneration:1,sourceId});assert.equal(request.headers()['x-csrf-token'],'synthetic-only');state='stopped';}
    else assert.equal(method,'GET');
    return reply({object:'virtual_phone.camera',phoneId,...input(),capabilities:{image:true,browser:false,usb:false,video:false,udp:false}});
  });
  await page.goto(origin+'/plugins/official.virtual-phones');
  await page.getByText('图片输入已开启',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.path.endsWith('/camera')).length,0,'rendering list must not poll camera nodes');
  await page.reload();await page.getByText('图片输入已开启',{exact:true}).waitFor();
  await page.getByRole('button',{name:'管理／关闭输入'}).click();
  await page.getByRole('button',{name:'关闭摄像头输入',exact:true}).waitFor();
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator('#phone-camera-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  }
  await page.getByRole('button',{name:'关闭摄像头输入',exact:true}).click();
  await page.getByText('摄像头输入已关闭',{exact:true}).waitFor();
  await page.getByRole('button',{name:'返回手机',exact:true}).click();
  assert.equal(await page.locator('.camera-list-state').count(),0);
  assert.equal(await page.locator('.card .badge').innerText(),'运行中');
  assert.equal(calls.filter(c=>c.method!=='GET').length,1,'no phone stop, media grant, source restart or upload');
  assert.deepEqual(errors,[]);
});
