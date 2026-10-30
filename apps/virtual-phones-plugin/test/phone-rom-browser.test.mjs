import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createVirtualPhonesPluginServer } from "../src/server.mjs";

// Actual Chromium UI, synthetic API only. Does not certify Google or Android.
test("ROM picker: explicit choice, disabled reasons, stable refresh and exact submission", {
  skip: !process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT, timeout: 60000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server = createVirtualPhonesPluginServer();
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width:1280,height:900 } }), errors = [], writes = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(document,"cookie",{get:()=>"__Host-teamaibox-csrf=synthetic-only"}));
  const aosp={id:"aosp-17-16102939-v1",familyId:"aosp",name:"Android AOSP",version:"Android 17 · 16102939 · v1",googlePlay:false,experimental:false,cameraCapability:"unavailable",createEnabled:true,reasonCode:null};
  const google={...aosp,id:"google-experimental-17-16102939-v1",familyId:"google-experimental",name:"Android + Google Play",googlePlay:true,experimental:true,createEnabled:false,reasonCode:"phone_rom_unavailable"};
  const phoneId="00000000-0000-4000-8000-000000000101";
  let reads=0,phones=[];
  await page.route(origin+"/api/v1/virtual-phones**",async route=>{
    const req=route.request(), path=new URL(req.url()).pathname;
    const reply=value=>route.fulfill({contentType:"application/json",body:JSON.stringify(value)});
    if(req.method()==="GET"){
      if(path.endsWith("/availability")){reads++;return reply({object:"virtual_phone.availability",enabled:true,runtimeConfigured:true,defaultRomVersionId:aosp.id,roms:[aosp,...[1,2,3].map(n=>({...aosp,id:'aosp-camera-v'+n,name:'Android AOSP · 摄像头',version:'Camera v'+n,createEnabled:false})),google]});}
      return reply({object:"list",data:phones,quota:{stored:phones.length,running:0,storedPerUser:2,runningPerUser:2}});
    }
    const body=req.postDataJSON();writes.push(body);
    phones=[{object:"virtual_phone",id:phoneId,name:body.name,state:"stopped",revision:1,runningCharged:false,rom:google}];
    return reply({object:"virtual_phone.operation",id:phoneId,phoneId});
  });
  await page.goto(origin+"/plugins/official.virtual-phones");
  await page.locator("#create:not(:disabled)").click();
  const a=page.locator(`input[value='${aosp.id}']`),g=page.locator(`input[value='${google.id}']`);
  assert.equal(await a.isChecked(),true); assert.equal(await g.isDisabled(),true);
  assert.match(await page.locator("#rom-choices").innerText(),/尚未开放新建/);
  assert.equal(await page.locator('#rom-choices .rom-choice').count(),2);
  assert.deepEqual(await page.locator('#rom-choices strong').allTextContents(),['标准 Android','Android + Google Play']);
  assert.doesNotMatch(await page.locator('#rom-choices').innerText(),/Camera v|16102939|摄像头版/);
  await page.locator("#name").fill("Google 工作手机");
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator("#editor").evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    if(process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS)await page.screenshot({path:join(process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS,`rom-picker-${width}.png`)});
  }
  // Polling is intentionally accelerated by the test, not by the product.
  google.createEnabled=true;google.reasonCode=null;
  await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));});
  await page.waitForFunction(id=>!document.querySelector(`input[value='${id}']`).disabled,google.id);
  await g.check(); await g.focus();
  const before=reads;
  await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));});
  await page.waitForResponse(r=>r.url().endsWith("/availability"));
  assert.ok(reads>before);assert.equal(await g.isChecked(),true);assert.equal(await g.evaluate(el=>document.activeElement===el),true);
  assert.equal(await page.locator("#name").inputValue(),"Google 工作手机");
  await page.locator("#submit").click();
  await page.getByRole("heading",{name:"Google 工作手机",exact:true}).waitFor();
  assert.deepEqual(writes,[{name:"Google 工作手机",start:true,romVersionId:google.id}]);
  assert.match(await page.locator(".card").innerText(),/Google Play.*实验版/s);
  assert.match(await page.locator(".card").innerText(),/虚拟摄像头 · 尚未开放/);
  assert.deepEqual(errors,[]);
});
