import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';

// Presentation-only synthetic sessions; no appliance, real account or mail app.
test('company contact is reachable on login and in the sidebar without covering content', {
  skip:!process.env.TEAMAIBOX_UI_PLAYWRIGHT,timeout:90000,
},async t=>{
  const origin='http://127.0.0.1:4194';
  const preview=spawn(process.execPath,['apps/web/tools/operations-preview-server.mjs'],{
    cwd:new URL('../../../',import.meta.url),env:{...process.env,TEAMAIBOX_PREVIEW_PORT:'4194'},stdio:'pipe',
  });
  t.after(()=>preview.kill());
  await new Promise((resolve,reject)=>{preview.stdout.once('data',resolve);preview.once('error',reject);preview.once('exit',code=>reject(Error(`preview exited ${code}`)));});
  const engines=await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  const screenshots=process.env.TEAMAIBOX_UI_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  for(const engine of ['chromium','webkit']){
    const browser=await engines[engine].launch({headless:true});
    try{
      for(const sample of [
        {width:1440,height:900,theme:'light',locale:'zh-CN'},
        {width:1280,height:720,theme:'dark',locale:'en'},
        {width:390,height:844,theme:'light',locale:'en'},
        {width:390,height:844,theme:'dark',locale:'ar'},
      ]){
        let authenticated=false;
        const context=await browser.newContext({viewport:{width:sample.width,height:sample.height},locale:sample.locale,colorScheme:sample.theme});
        await context.route('**/*',route=>{
          const request=route.request(),url=new URL(request.url());
          if(url.origin!==origin||request.method()!=='GET')return route.abort();
          if(request.headers().accept==='text/event-stream')return route.fulfill({contentType:'text/event-stream',body:': footer fixture\n\n'});
          if(url.pathname==='/runtime-config.js')return route.fulfill({contentType:'text/javascript',body:'globalThis.__TEAM_AI_BOX_RUNTIME__={classification:"isolated-development-synthetic-only",transport:"https"};'});
          if(url.pathname==='/api/auth/session')return route.fulfill({status:authenticated?200:401,json:authenticated?{
            authenticated:true,identity:{id:'00000000-0000-4000-8000-000000000001',identityKind:'local_user',loginName:'footer-fixture',displayName:'Footer Fixture',roles:['member']},
            preferences:{preferredTheme:sample.theme,preferredLocale:sample.locale,preferredLocaleExplicit:true},
            permissions:['application:catalog:view'],teamMemberships:[],teamRoles:{},
          }:{}});
          if(url.pathname==='/api/setup/status')return route.fulfill({json:{required:false,claimProtected:true,ownerRecoveryAvailable:false}});
          return route.continue();
        });
        const page=await context.newPage();
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        for(const placement of ['login','sidebar']){
          authenticated=placement==='sidebar';await page.goto(origin);
          await page.locator(placement==='login'?'#login-name':sample.width<800?'.mobile-menu-trigger':'.profile-trigger').waitFor();
          if(placement==='sidebar'&&sample.width<800)await page.locator('.mobile-menu-trigger').click();
          const footer=page.locator(`.company-footer--${placement}`);
          await footer.waitFor();await footer.scrollIntoViewIfNeeded();
          assert.match(await footer.innerText(),new RegExp(`© ${new Date().getFullYear()} Weerocks LLC`));
          const link=footer.getByRole('link',{name:'teamaibox@weerocks.llc'});
          assert.equal(await link.getAttribute('href'),'mailto:teamaibox@weerocks.llc');
          assert.equal(await link.getAttribute('dir'),'ltr');
          await link.focus();
          const contact=await link.evaluate(el=>{
            const box=el.getBoundingClientRect();
            return {focused:document.activeElement===el,visible:box.width>0&&box.height>0&&box.left>=-1&&box.right<=innerWidth+1&&box.top>=-1&&box.bottom<=innerHeight+1,unobstructed:el.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))};
          });
          assert.deepEqual(contact,{focused:true,visible:true,unobstructed:true},`${engine} ${placement} ${sample.width}: contact is visible, unobstructed and focusable`);
          if(placement==='sidebar'){
            const catalog=await page.locator('.sidebar-catalog').boundingBox(),status=await page.locator('.device-status').boundingBox(),legal=await footer.boundingBox();
            assert.ok(catalog.height>0&&catalog.y+catalog.height<=status.y+1&&status.y+status.height<=legal.y+1,'sidebar content must not overlap footer');
            if(sample.width<800){
              const dock=await page.locator('.mobile-nav').boundingBox();
              assert.ok(legal.y+legal.height<=dock.y,'copyright must not be painted behind the inert mobile dock');
            }
          }
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal page overflow');
          if(screenshots)await page.screenshot({path:join(screenshots,`${engine}-${placement}-${sample.width}-${sample.theme}.png`),fullPage:placement==='login'});
        }
        assert.deepEqual(errors,[]);await context.close();
      }
      t.diagnostic(`${engine}: login/sidebar, desktop/mobile, light/dark and RTL footer checks passed`);
    }finally{await browser.close();}
  }
});
