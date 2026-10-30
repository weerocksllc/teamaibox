import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

test('AI startup tags stay visible and clear independently when ready', {
  skip: !process.env.TEAMAIBOX_UI_PLAYWRIGHT, timeout: 60000,
}, async t => {
  const { chromium } = await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  const browser = await chromium.launch({ headless:true });t.after(()=>browser.close());
  const page = await browser.newPage();let allReady=false, activeLocale='zh-CN',activeTheme='light';const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.hostname!=='127.0.0.1'||request.method()!=='GET')return route.abort();
    if(url.pathname==='/runtime-config.js'){
      const response=await route.fetch();
      return route.fulfill({contentType:'text/javascript',body:(await response.text()).replace('preferredLocale:"zh-CN"',`preferredLocale:"${activeLocale}"`).replace('preferredTheme:"light"',`preferredTheme:"${activeTheme}"`)});
    }
    if(url.pathname==='/api/v1/applications'){
      const response=await route.fetch(), data=await response.json();
      const states={assistant:'loading',drawing:'retrying',ocr:'failed',asr:'ready',translation:'unavailable'};
      for(const app of data.applications){
        const state=allReady?'ready':states[app.pluginKey.split('.')[1]]??'ready';
        app.startupState=state;app.launchable=state==='ready';app.availability=app.launchable?'available':'unavailable';
        app.blockers=app.launchable?[]:['model_route_unavailable'];
      }
      return route.fulfill({json:data});
    }
    return route.continue();
  });
  const output=process.env.TEAMAIBOX_UI_SCREENSHOTS;
  if(output)await mkdir(output,{recursive:true});
  for(const locale of ['zh-CN','en'])for(const theme of ['light','dark']){
    activeLocale=locale;activeTheme=theme;
    await page.addInitScript(({locale,theme})=>{
      localStorage.setItem('teamaibox.recent-locale',locale);localStorage.setItem('teamaibox.recent-theme',theme);
    },{locale,theme});
    await page.setViewportSize({width:1280,height:900});
    await page.goto('http://127.0.0.1:4188/');
    const tag=page.locator('.application-startup-tag--loading').first();await tag.waitFor();
    assert.match(await tag.textContent(),locale==='zh-CN'?/加载中/:/Loading/);
    assert.equal(await page.locator('.application-startup-tag--retrying').first().textContent(),locale==='zh-CN'?'恢复中':'Retrying');
    assert.equal(await page.locator('.application-startup-tag--failed').first().textContent(),locale==='zh-CN'?'启动异常':'Failed');
    assert.equal(await page.locator('.application-startup-tag--unavailable').first().textContent(),locale==='zh-CN'?'状态异常':'Unavailable');
    const clipped=await page.locator('.application-startup-tag').evaluateAll(tags=>tags.filter(tag=>{
      const box=tag.getBoundingClientRect(),parent=tag.closest('button')?.getBoundingClientRect();
      return parent&&(box.left<parent.left||box.right>parent.right||box.bottom>parent.bottom);
    }).map(x=>x.textContent));assert.deepEqual(clipped,[]);
    if(output)await page.screenshot({path:`${output}/${locale}-${theme}.png`});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  allReady=true;await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('.sidebar-app[data-startup="ready"]:not(:disabled)').length===10&&!document.querySelector('.application-startup-tag'));
  assert.deepEqual(errors,[]);
});
