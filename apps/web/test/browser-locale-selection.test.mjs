import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createI18nRuntime} from '../src/i18n.ts';

// Local UI only. Intercept all identity writes; never proxy a real appliance.
test('English default ignores browser language and manual language persists across all app frames', {
  skip:!process.env.TEAMAIBOX_UI_PLAYWRIGHT,timeout:120000,
},async t=>{
  const port=4193,origin=`http://127.0.0.1:${port}`;
  const preview=spawn(process.execPath,['apps/web/tools/operations-preview-server.mjs'],{
    cwd:new URL('../../../',import.meta.url),env:{...process.env,TEAMAIBOX_PREVIEW_PORT:String(port)},stdio:'pipe',
  });
  t.after(()=>preview.kill());
  await new Promise((resolve,reject)=>{preview.stdout.once('data',resolve);preview.once('error',reject);preview.once('exit',code=>reject(Error(`preview exited ${code}`)));});
  const engines=await import(pathToFileURL(process.env.TEAMAIBOX_UI_PLAYWRIGHT));
  for(const engine of ['chromium','webkit']){
    const browser=await engines[engine].launch({headless:true});
    try{
      let signedIn=false;
      const preferences={preferredLocale:'zh-CN',preferredLocaleExplicit:false,preferredTheme:'light'};
      const writes=[];
      const session=()=>({authenticated:true,identity:{id:'00000000-0000-4000-8000-000000000001',identityKind:'local_user',loginName:'locale-fixture',displayName:'Locale Fixture',roles:['member']},
        preferences,permissions:['application:catalog:view','ai:invoke','messaging:use','drive:use','cast:use','cast:view','phone:use','computer:use'],teamMemberships:[],teamRoles:{}});
      const context=await browser.newContext({locale:'ja-JP'});
      const intercept=async context=>{
        // HTTP loopback fixture, not an authentication/cookie-security test.
        await context.addInitScript(()=>Object.defineProperty(document,'cookie',{get:()=>'__Host-teamaibox-csrf=fixture-only'}));
        await context.route('**/*',async route=>{
          const request=route.request(),url=new URL(request.url()),method=request.method();
          if(url.origin!==origin)return route.abort();
          const json=(data,status=200)=>route.fulfill({status,json:data});
          if(url.pathname==='/runtime-config.js')return route.fulfill({contentType:'text/javascript',body:'globalThis.__TEAM_AI_BOX_RUNTIME__={classification:"isolated-development-synthetic-only",transport:"https"};'});
          if(url.pathname==='/api/auth/session')return signedIn?json(session()):json({},401);
          if(url.pathname==='/api/setup/status')return json({required:false,claimProtected:true,ownerRecoveryAvailable:false});
          if(method==='POST'&&url.pathname==='/api/auth/sign-in'){
            assert.deepEqual(request.postDataJSON(),{loginName:'locale-fixture',password:'fixture-only'});signedIn=true;return json(session());
          }
          if(method==='POST'&&url.pathname==='/api/auth/sign-out'){signedIn=false;return json({});}
          if(method==='PATCH'&&url.pathname==='/api/preferences/locale'){
            preferences.preferredLocale=request.postDataJSON().locale;preferences.preferredLocaleExplicit=true;writes.push(preferences.preferredLocale);return json(preferences);
          }
          if(method==='PATCH'&&url.pathname==='/api/preferences/theme'){preferences.preferredTheme=request.postDataJSON().theme;return json(preferences);}
          if(method!=='GET')return route.abort();
          return route.continue();
        });
      };
      await intercept(context);
      const page=await context.newPage();
      const language=async locale=>page.waitForFunction(value=>document.documentElement.lang===value,locale);
      const login=async()=>{
        await page.locator('#login-name').fill('locale-fixture');await page.locator('#login-password').fill('fixture-only');
        await page.locator('form').filter({has:page.locator('#login-name')}).locator('button[type=submit]').click();
        await page.locator('.profile-trigger').waitFor();
      };
      await page.goto(origin);await language('en');await login();await language('en');
      await page.reload();await page.locator('.profile-trigger').waitFor();await language('en');
      assert.deepEqual(writes,[]);
      assert.equal(await page.evaluate(()=>localStorage.getItem('teamaibox.recent-locale')),null);
      await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['zh-CN']});dispatchEvent(new Event('languagechange'));});
      await language('en');assert.deepEqual(writes,[]);
      await page.locator('.profile-trigger').click();
      await page.locator('.appearance-preferences--profile select').first().selectOption('fr');
      await language('fr');await page.waitForFunction(()=>globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__.preferredLocaleExplicit===true);
      await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['ja-JP']});dispatchEvent(new Event('languagechange'));});
      await language('fr');
      assert.deepEqual(writes,['fr']);
      await page.reload();await page.locator('.profile-trigger').waitFor();await language('fr');
      await page.locator('.profile-trigger').click();await page.locator('.signout-button').click();
      await page.locator('#login-name').waitFor();await language('fr');await login();await language('fr');
      const translate=createI18nRuntime({locale:'fr'}).translate;
      for(const app of ['messaging','team-drive','drawing','ocr','asr','translation','wireless-casting','virtual-phones','virtual-computers']){
        const label=translate(`app.${app==='team-drive'?'drive':app}.name`);
        await page.locator('.sidebar-app').filter({hasText:label}).first().click();
        await page.locator('iframe[data-presentation=ready]').waitFor();
        const frame=page.frameLocator('.plugin-workspace__frame');
        assert.equal(await frame.locator('html').getAttribute('lang'),'fr',`${engine}: ${app}`);
      }
      // New browser with no local choice still honors an explicit account choice.
      const second=await browser.newContext({locale:'en-US'});signedIn=false;await intercept(second);
      const another=await second.newPage();await another.goto(origin);
      await another.locator('#login-name').fill('locale-fixture');await another.locator('#login-password').fill('fixture-only');
      await another.locator('form').filter({has:another.locator('#login-name')}).locator('button[type=submit]').click();
      await another.locator('.profile-trigger').waitFor();
      await another.waitForFunction(()=>document.documentElement.lang==='fr');
      assert.deepEqual(writes,['fr'],'automatic sign-in must not overwrite French with English');
      await second.close();await context.close();
      t.diagnostic(`${engine}: English default, manual French, reload, sign-out/sign-in, 9 app frames, new-browser account preference passed`);
    }finally{await browser.close();}
  }
});
