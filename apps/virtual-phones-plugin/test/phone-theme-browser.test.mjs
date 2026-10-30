import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {createVirtualPhonesPluginServer} from '../src/server.mjs';
import {semanticThemeTokenNamesV1} from '../../../packages/plugin-sdk/src/preferences-v1.mjs';
import {readThemeTokens} from '../../../packages/ui-system/test/token-fixture.mjs';

// Real browser CSS and preference messaging; phone/API data are synthetic.
test('phone first paint, host handshake, live themes and open dialog stay coherent', {
  skip: !process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT, timeout:60000,
}, async t => {
  const {chromium}=await import(pathToFileURL(process.env.TEAMAIBOX_PHONE_UI_PLAYWRIGHT));
  const server=createVirtualPhonesPluginServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[],writes=[]; page.on('pageerror',e=>errors.push(e.message));
  const modes={light:await readThemeTokens('light'),dark:await readThemeTokens('dark')};
  const tokens=theme=>{
    return Object.fromEntries(semanticThemeTokenNamesV1.map(name=>[name,modes[theme][name]]));
  };
  let revision=0;
  const snapshot=(theme,locale='zh-CN')=>({schemaVersion:1,type:'teamaibox.plugin-preferences/v1',pluginId:'official.virtual-phones',revision:++revision,
    requested:{theme,locale,direction:'ltr'},effective:{theme,locale,direction:'ltr'},
    compatibility:{localeSupported:true,directionSupported:true,themeSupported:true,liveUpdates:true},disclosures:[],semanticTokens:tokens(theme)});
  await page.route(origin+'/host',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><script>
    window.readyMessages=0;addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='teamaibox.plugin-ready/v1')window.readyMessages++;});
    </script><iframe style="width:100%;height:850px;border:0" src="/plugins/official.virtual-phones?theme=dark&locale=en"></iframe>`}));
  const rom={id:'synthetic-standard-camera',familyId:'aosp',name:'标准 Android',version:'Android 17',googlePlay:false,experimental:false,cameraCapability:'verified',createEnabled:true,reasonCode:null};
  await page.route(origin+'/api/**',route=>{
    if(route.request().method()!=='GET')writes.push(route.request().url());
    const availability=route.request().url().endsWith('/availability');
    return route.fulfill({contentType:'application/json',body:JSON.stringify(availability?{object:'virtual_phone.availability',enabled:true,runtimeConfigured:true,roms:[rom],defaultRomVersionId:rom.id}:
      {object:'list',data:[{object:'virtual_phone',id:'00000000-0000-4000-8000-000000000101',name:'示例工作手机',state:'stopped',revision:1,runningCharged:false,rom}],quota:{stored:1,running:0,storedPerUser:2,runningPerUser:2}})});
  });
  await page.goto(origin+'/host');await page.waitForFunction(()=>window.readyMessages===1);
  const frame=page.frames().find(f=>f.url().includes('/plugins/'));
  await frame.locator('#create:not(:disabled)').waitFor();
  assert.equal(await frame.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(await frame.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(16, 25, 30)');
  assert.equal(await frame.locator('h1').innerText(),'My virtual phones');
  assert.equal(await frame.locator('.summary').getAttribute('aria-label'),'Phone capacity');
  assert.equal(await frame.locator('#phone-video').getAttribute('aria-label'),'Phone screen; click to use the keyboard');
  await frame.locator('#create').click();await frame.locator('#name').fill('保留输入');
  for(const theme of ['light','dark','light']){
    const next=snapshot(theme);
    await page.evaluate(value=>document.querySelector('iframe').contentWindow.postMessage(value,location.origin),next);
    await frame.waitForFunction(rev=>document.documentElement.dataset.pluginPreferenceRevision===String(rev),next.revision);
    assert.equal(await frame.locator('.summary').getAttribute('aria-label'),'配额');
    assert.equal(await frame.locator('#phone-video').getAttribute('aria-label'),'手机画面；点击后可使用键盘');
    assert.equal(await frame.locator('#name').inputValue(),'保留输入');
    assert.equal(await frame.locator('#editor').evaluate(el=>el.open),true);
    const colors=await frame.evaluate(()=>Object.fromEntries(['body','.card','#editor','#name','#submit'].map(sel=>{
      const s=getComputedStyle(document.querySelector(sel));return [sel,{bg:s.backgroundColor,fg:s.color}];})));
    assert.equal(colors.body.bg,theme==='dark'?'rgb(16, 25, 30)':'rgb(246, 248, 248)');
    assert.equal(colors['#editor'].bg,theme==='dark'?'rgb(24, 37, 43)':'rgb(255, 255, 255)');
    assert.equal(colors['#submit'].fg,theme==='dark'?'rgb(16, 25, 30)':'rgb(255, 255, 255)');
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.equal(await frame.locator('#editor').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      if(process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS)await page.screenshot({path:`${process.env.TEAMAIBOX_PHONE_UI_SCREENSHOTS}/phone-${theme}-${width}.png`});
    }
  }
  assert.doesNotMatch(await frame.locator('body').innerText(),/Cuttlefish|ARM64|KVM/i);
  assert.deepEqual(writes,[],'changing appearance does not operate a phone');
  assert.deepEqual(errors,[]);
});
