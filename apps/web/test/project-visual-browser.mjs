import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function runProjectVisual({page,context,routes,owner,evidence,checks,errors,requests}){
  const native=routes.get(owner.id).native,client=routes.get(owner.id).client;
  if(process.env.NATIVE_VISUAL_RESUME==='shell'){
    const created=await native.request('POST','/session',{body:JSON.stringify({title:'Layout review'})});const session=await created.json();
    const message={info:{id:'msg_layout',sessionID:session.id,role:'assistant',time:{created:Date.now(),completed:Date.now()}},parts:[{id:'prt_text',type:'text',text:'Long project history '.repeat(1800)},{id:'prt_tool',type:'tool',tool:'layout_fixture',state:{status:'completed',title:'Read project notes',input:{},output:'Long synthetic tool output '.repeat(3000)}}]};
    await page.route(`**/session/${session.id}/message?*`,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify([message])}));
    const url=new URL(page.url());url.searchParams.set('assistantSession',session.id);url.searchParams.set('assistantView','conversation');await page.goto(url.href);await page.locator('.assistant-compose-input').waitFor();
    await page.locator('.native-part>summary').filter({hasText:'Read project notes'}).click();
    const check=page.locator('.assistant-design-icon--check');assert.equal(await check.evaluate(n=>n.getBoundingClientRect().width),16);
    for(const [width,height] of [[1440,1000],[1280,800],[430,932]]){await page.setViewportSize({width,height});await page.waitForFunction(()=>{const r=document.querySelector('.assistant-compose-input')?.getBoundingClientRect();return Boolean(r&&r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth+1);});}
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(evidence,'long-history-tool-layout.png')});checks.push('Production React rendering with explicitly synthetic long history/tool data preserves input geometry at three widths and exact 16px tool icon');
    await page.locator('.assistant-native-header>button').last().click();await page.locator('.assistant-native').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.querySelector('.sidebar')?.getBoundingClientRect().width!==72);assert.equal(await page.locator('.topbar .assistant-native-header').count(),0);checks.push('Assistant exit restores the original shell dimensions, labels and header; no model execution');assert.deepEqual(errors,[]);return;
  }
  const sessions=[];
  for(const [name,title] of [['Design workspace','Launch brief'],['Research notes','Research conversation']]){
    await client.workspaceOperation('folders',{directory:'/workspace',name});
    const response=await native.request('POST','/session?directory='+encodeURIComponent('/workspace/'+name),{body:JSON.stringify({title})});sessions.push(await response.json());
  }
  await page.reload();await page.locator('.assistant-project-cards>button').filter({hasText:'Design workspace'}).waitFor();
  const preferences=()=>page.locator('.topbar .appearance-preferences select');await preferences().nth(1).selectOption('dark');await page.screenshot({path:join(evidence,'project-home-dark.png')});
  await page.locator('.assistant-project-cards>button').filter({hasText:'Design workspace'}).click();const composer=page.locator('.assistant-compose-input');await composer.fill('Prepare a launch plan.');
  if(!['layout','viewport','mobile'].includes(process.env.NATIVE_VISUAL_RESUME)){
  const more=page.locator('.assistant-more-menu');await more.locator('summary').click();await more.getByRole('button',{name:'Archive conversation',exact:true}).click();
  await more.locator('summary').click();await more.getByRole('button',{name:'Restore conversation',exact:true}).waitFor();assert.ok((await (await native.request('GET',`/session/${sessions[0].id}?directory=${encodeURIComponent(sessions[0].directory)}`)).json()).time.archived);
  await more.getByRole('button',{name:'Restore conversation',exact:true}).click();
  await page.locator('.assistant-project-navigation').getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('dialog').getByRole('textbox',{name:'Folder name'}).fill('Cancelled project');await page.keyboard.press('Escape');assert.equal(new URL(page.url()).searchParams.get('assistantSession'),sessions[0].id);
  await page.locator('.assistant-project-navigation').getByRole('button',{name:'Open a folder',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByLabel('Import files',{exact:true}).setInputFiles([{name:'brief.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic launch notes')},{name:'too-large.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(16*1024*1024+1)}]);
  await dialog.getByText('brief.txt · ✓',{exact:true}).waitFor();await dialog.getByText('too-large.bin · File exceeds 16 MiB',{exact:true}).waitFor();await page.keyboard.press('Escape');
  checks.push('Production React route: archive/restore, cancelled folder creation, explicit per-file partial import result');
  }else await client.workspaceOperation('files',{directory:sessions[0].directory,name:'brief.txt',content:Buffer.from('Synthetic launch notes').toString('base64')});
  if(!['viewport','mobile'].includes(process.env.NATIVE_VISUAL_RESUME)){
  let arrived,release;const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);let captured=false;
  const pattern=`**/session/${sessions[0].id}/message?*`;
  await page.route(pattern,async route=>{if(captured)return route.continue();captured=true;const response=await route.fetch();arrived();await gate;await route.fulfill({response});});
  await native.request('POST','/session?directory='+encodeURIComponent(sessions[0].directory),{body:JSON.stringify({title:'Late-response fixture'})});await ready;
  await page.locator('.assistant-project-navigation').getByRole('button',{name:/Research notes \/workspace\/Research notes/}).click();await page.locator('.assistant-session-heading h3').filter({hasText:'Research conversation'}).waitFor();const late=page.waitForResponse(r=>r.url().includes(`/session/${sessions[0].id}/message?`));release();await (await late).finished();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('.assistant-session-heading h3').innerText(),'Research conversation');await page.unroute(pattern);checks.push('Late native history response cannot overwrite a newly selected directory/session');
  }
  await page.locator('.assistant-project-navigation').getByRole('button',{name:/Design workspace \/workspace\/Design workspace/}).click();assert.equal(await composer.inputValue(),'Prepare a launch plan.');
  if(process.env.NATIVE_VISUAL_RESUME!=='mobile'){
  await page.getByRole('button',{name:'Terminal',exact:true}).click();const drawer=page.locator('.assistant-terminal-drawer');await drawer.getByRole('button',{name:'+ Terminal',exact:true}).click();await drawer.locator('.xterm').waitFor();
  const terminal=await (await native.request('GET','/pty?directory='+encodeURIComponent(sessions[0].directory))).json();assert.equal(terminal.length,1);await page.screenshot({path:join(evidence,'terminal-drawer-dark.png')});await page.keyboard.press('Escape');await drawer.waitFor({state:'detached'});assert.equal((await (await native.request('GET','/pty?directory='+encodeURIComponent(sessions[0].directory))).json()).length,1);
  const icons=await page.locator('.assistant-design-icon').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height).map(n=>({name:n.className,url:getComputedStyle(n).maskImage,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
  for(const icon of icons){const url=/url\("?([^"\)]+)"?\)/.exec(icon.url)?.[1];assert.ok(url,icon.name);const response=await context.request.get(url);assert.equal(response.status(),200);assert.ok((await response.body()).length>60);assert.equal(icon.width,icon.name.includes('--right')?14:icon.name.includes('--spark')?20:18);}
  }
  const views=process.env.NATIVE_VISUAL_RESUME==='mobile'?[[430,932,'ar','dark']]:[[1440,1000,'en','dark'],[1280,800,'zh-CN','light'],[430,932,'ar','dark']];
  for(const [width,height,locale,theme] of views){
    await page.setViewportSize({width,height});
    if(width===430){await page.locator('.mobile-nav button').last().click();const profile=page.locator('.profile-popover .appearance-preferences select');await profile.nth(0).selectOption(locale);await profile.nth(1).selectOption(theme);await page.keyboard.press('Escape');}
    else{await preferences().nth(0).selectOption(locale);await preferences().nth(1).selectOption(theme);}
    await page.waitForFunction(locale=>document.documentElement.lang===locale,locale);
    await page.waitForFunction(()=>{const r=document.querySelector('.assistant-compose-input')?.getBoundingClientRect();return Boolean(r&&r.width>80&&r.top>=0&&r.bottom<=innerHeight);});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:join(evidence,`production-${locale}-${theme}-${width}.png`)});
    if(width===430){await page.locator('.assistant-navigation-toggle').click();const modal=page.getByRole('dialog');await modal.waitFor();assert.ok(await modal.evaluate(node=>node.contains(document.activeElement)));await page.keyboard.press('Escape');await modal.waitFor({state:'detached'});assert.ok(await page.locator('.assistant-navigation-toggle').evaluate(node=>node===document.activeElement));}
  }
  await page.setViewportSize({width:1440,height:1000});await preferences().nth(0).selectOption('en');
  assert.equal(await page.locator('.topbar .assistant-native-header').count(),1);assert.equal(await page.locator('.assistant-native>.assistant-native-header').count(),0);
  assert.equal(await page.locator('.sidebar').evaluate(node=>Math.round(node.getBoundingClientRect().width)),72);
  checks.push(process.env.NATIVE_VISUAL_RESUME==='mobile'?'Production mobile profile language/theme, RTL, composer geometry, project modal focus/Escape; prior desktop/light/icon/terminal evidence reused':'Production shell uses one header and compact app rail; exact local Figma icons; terminal drawer and draft retained; three theme/locale/viewport layouts and modal focus/Escape');
  const missing=new URL(page.url());missing.searchParams.set('assistantSession','ses_missing');await page.goto(missing.href);await page.waitForFunction(()=>!new URL(location.href).searchParams.has('assistantSession'));assert.equal(await page.locator('.assistant-transcript .assistant-message').count(),0);checks.push('Unavailable remembered native session falls back without stale history or replay');
  await page.locator('.assistant-native-header>button').last().click();await page.locator('.assistant-native').waitFor({state:'detached'});assert.notEqual(await page.locator('.sidebar').evaluate(n=>Math.round(n.getBoundingClientRect().width)),72);checks.push('Leaving Assistant restores the normal product shell width and header');
  assert.equal(requests.filter(r=>r.url.includes('/prompt_async')).length,0);assert.deepEqual(errors,[]);
}
