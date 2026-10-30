import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createVirtualPhonesPluginServer } from "../src/server.mjs";

// Opt-in real Chromium rendering against explicit API fixtures. This is NOT
// Android, production authentication, LAN media, or product acceptance evidence.
test("member phone UI: lifecycle, lost response, confirmation, layout and restored page", {
  skip:!process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT, timeout:60000,
}, async () => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server = createVirtualPhonesPluginServer();
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:1280,height:800}});
    const page = await context.newPage(), errors = [], mutations = [], requests = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror",error=>errors.push(error.message));
    page.on("request",request=>requests.push(request.url()));
    // The fixture replaces only the CSRF cookie read. Auth enforcement is tested
    // separately by the real HTTPS Platform API suite, not by this rendering test.
    await page.addInitScript(()=>Object.defineProperty(document,"cookie",{get:()=>"__Host-teamaibox-csrf=fixture-only"}));
    const first = "00000000-0000-4000-8000-000000000101", second = "00000000-0000-4000-8000-000000000102";
    const makePhone = (id,name) => ({object:"virtual_phone",id,name,state:"stopped",revision:1,runningCharged:false});
    let phones = [makePhone(first,"办公手机")], unauthorized = false, loseCreateResponse = true, reads = 0;
    const committed = new Map();
    await page.route(origin+"/api/v1/virtual-phones**",async route=>{
      const request = route.request(), method = request.method(), path = new URL(request.url()).pathname;
      const reply = (value,status=200) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
      if (unauthorized) return reply({error:{code:"invalid_session"}},401);
      if (method === "GET") {
        reads++;
        if (path.endsWith("/availability")) return reply({object:"virtual_phone.availability",enabled:true,runtimeConfigured:true});
        return reply({object:"list",data:phones,quota:{stored:phones.length,running:phones.filter(p=>p.runningCharged).length,storedPerUser:2,runningPerUser:2}});
      }
      const body = request.postDataJSON(), key = request.headers()["idempotency-key"];
      mutations.push({method,path,body,key});
      assert.equal(request.headers()["x-csrf-token"],"fixture-only");
      if (committed.has(key)) return reply(committed.get(key),202);
      const phoneId = path.split("/")[4] || second, phone = phones.find(p=>p.id === phoneId);
      const result = {object:"virtual_phone.operation",id:crypto.randomUUID(),phoneId};
      if (method === "PATCH") {
        assert.equal(body.expectedRevision,phone.revision); phone.name = body.name; phone.revision++;
        return reply(phone);
      }
      if (method === "DELETE") {
        assert.equal(body.confirmDelete,true); assert.equal(body.expectedRevision,phone.revision);
        phones = phones.filter(p=>p.id !== phoneId);
      } else if (phone) {
        assert.equal(body.expectedRevision,phone.revision);
        phone.state = path.endsWith("/stop") ? "stopped" : "running";
        phone.runningCharged = phone.state === "running"; phone.revision++;
      } else {
        assert.equal(body.start,true); phones.push({...makePhone(second,body.name),state:"creating"});
      }
      committed.set(key,result);
      if (phoneId === second && loseCreateResponse) { loseCreateResponse = false; return route.abort("connectionreset"); }
      return reply(result,202);
    });
    await page.goto(origin+"/plugins/official.virtual-phones");
    await page.locator(".card").waitFor();
    const card = id=>page.locator(".card").filter({has:page.locator(`details[data-phone='${id}']`)});
    const action = (id,name)=>page.locator(`button[data-phone='${id}'][data-action='${name}']`);
    const refresh = async () => { const before = reads; await Promise.all([
      page.waitForResponse(response=>response.url().endsWith("/availability")), page.locator("#refresh").click(),
    ]); assert.ok(reads>before); };
    await card(first).locator("summary").click(); await action(first,"rename").click();
    const literal = "<img src=x onerror=alert(1)>";
    await page.locator("#name").fill(literal); await page.locator("#submit").click();
    await page.getByRole("heading",{name:literal,exact:true}).waitFor();
    assert.equal(await page.locator(".card img").count(),0);
    await card(first).locator("summary").click(); await action(first,"rename").click();
    await page.locator("#name").fill("办公手机"); await page.locator("#submit").click();
    await page.getByRole("heading",{name:"办公手机",exact:true}).waitFor();
    await action(first,"start").click(); await action(first,"stop").waitFor();
    await card(first).locator("summary").click(); await action(first,"restart").click();
    await page.waitForFunction(()=>!document.querySelector("button[data-action=stop]").disabled);
    await action(first,"stop").click(); await action(first,"start").waitFor();
    phones[0].errorCode="phone_resource_protection"; phones[0].revision++;
    await refresh(); await card(first).getByText(/保护性关机/).waitFor();
    assert.match(await card(first).innerText(),/已保存的数据保留/);
    assert.equal(await action(first,"start").isDisabled(),false);
    await page.locator("#create").click(); await page.locator("#name").fill("测试手机"); await page.locator("#submit").click();
    await page.locator("#uncertain").waitFor();
    assert.equal(await page.locator("#create").isDisabled(),true);
    await page.locator("#retry").click(); await page.locator("#uncertain").waitFor({state:"hidden"});
    await page.getByRole("heading",{name:"测试手机",exact:true}).waitFor();
    const creates = mutations.filter(m=>m.method==="POST" && m.path==="/api/v1/virtual-phones");
    assert.equal(creates.length,2); assert.deepEqual(creates[0],creates[1]); assert.equal(phones.length,2);
    phones[1].state="running"; phones[1].runningCharged=true; phones[1].revision++;
    await refresh(); await action(second,"stop").waitFor();
    assert.equal(await page.locator("#create").isDisabled(),true,"saved quota enforced in UI");
    if (process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS) await page.screenshot({path:join(process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS,"virtual-phones-desktop.png"),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"no narrow-screen horizontal overflow");
    if (process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS) await page.screenshot({path:join(process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS,"virtual-phones-mobile.png"),fullPage:true});
    // Returning from a cached page resumes reads; closing it never stops a guest.
    const beforeRestore = reads, beforeClose = mutations.length;
    await Promise.all([page.waitForResponse(response=>response.url().endsWith("/availability")),
      page.evaluate(()=>{ dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})); dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})); }),
    ]);
    assert.ok(reads>beforeRestore); assert.equal(mutations.length,beforeClose);
    await card(first).locator("summary").click(); await action(first,"delete").click();
    await page.locator("#submit").click(); assert.equal(await page.locator("#editor").isVisible(),true);
    assert.equal(mutations.filter(m=>m.method==="DELETE").length,0);
    await page.locator("#confirm-delete").check(); await page.locator("#submit").click();
    await page.getByRole("heading",{name:"办公手机",exact:true}).waitFor({state:"hidden"});
    assert.equal(phones.length,1); assert.equal(phones[0].id,second);
    unauthorized=true; await page.locator("#refresh").click();
    await page.locator("#error").waitFor(); await page.locator(".card").waitFor({state:"hidden"});
    assert.equal(await page.locator("#create").isDisabled(),true);
    assert.match(await page.locator("#error").innerText(),/登录/);
    assert.deepEqual(errors,[]);
    assert.ok(requests.every(url=>url.startsWith(origin+"/")),"no third-party assets or requests");
    assert.ok(!requests.some(url=>url.includes("/applications")),"UI refresh never loads the application catalog");
    const beforeLeave=mutations.length; await page.close(); assert.equal(mutations.length,beforeLeave);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
