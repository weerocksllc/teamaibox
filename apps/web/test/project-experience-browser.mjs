import assert from 'node:assert/strict';
import {join} from 'node:path';
import {runProjectVisual} from './project-visual-browser.mjs';

/** Affected UI flow only. Called by the existing isolated native harness. */
export async function runProjectExperience({page,context,routes,owner,second,origin,checks,errors,evidence,docker,resources,login}){
  const composer=()=>page.locator('.assistant-compose-input');
  const nav=()=>page.locator('.assistant-project-navigation');
  const requests=[];page.on('request',r=>{if(r.method()!=='GET')requests.push({method:r.method(),url:r.url(),body:r.postData()});});
  if(process.env.NATIVE_EXPERIENCE_STAGE==='visual'){await runProjectVisual({page,context,routes,owner,evidence,checks,errors,requests});return;}
  if(process.env.NATIVE_EXPERIENCE_STAGE==='fencing'){
    const native=routes.get(owner.id).native,ids=[];
    for(const name of ['First','Second']){await routes.get(owner.id).client.workspaceOperation('folders',{directory:'/workspace',name});const response=await native.request('POST','/session?directory='+encodeURIComponent('/workspace/'+name),{body:JSON.stringify({title:name+' conversation'})});ids.push((await response.json()).id);}
    const url=new URL(page.url());url.searchParams.set('assistantDirectory','/workspace/First');url.searchParams.set('assistantSession',ids[0]);await page.goto(url.href);await composer().waitFor();
    let arrived,release;const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
    await page.route('**/fork?*',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});});
    const menu=page.locator('.assistant-more-menu');await menu.locator('summary').click();await menu.getByRole('button',{name:'Branch conversation',exact:true}).click();await ready;
    await nav().getByRole('button',{name:/Second \/workspace\/Second/}).click();await composer().fill('Keep second draft');release();await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,ids[1]);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.equal(await composer().inputValue(),'Keep second draft');assert.equal(await page.locator('.assistant-session-heading h3').innerText(),'Second conversation');checks.push('A late branch completion cannot hijack a newer project/session selection or its draft');assert.deepEqual(errors,[]);return;
  }
  if(process.env.NATIVE_EXPERIENCE_STAGE==='recovery'){
    const native=routes.get(owner.id).native;
    const ids=[];
    for(const name of ['Alpha project','Beta project']){await routes.get(owner.id).client.workspaceOperation('folders',{directory:'/workspace',name});const r=await native.request('POST',`/session?directory=${encodeURIComponent('/workspace/'+name)}`,{body:JSON.stringify({title:name+' conversation'})});ids.push((await r.json()).id);}
    const url=new URL(page.url());url.searchParams.set('assistantDirectory','/workspace/Alpha project');url.searchParams.set('assistantSession',ids[0]);await page.goto(url.href);await composer().waitFor();
    let release,arrived;const ready=new Promise(r=>arrived=r);const finish=new Promise(r=>release=r);
    await page.route('**/prompt_async?*',async route=>{arrived();await finish;await route.fulfill({status:503,contentType:'application/json',body:'{}'});});
    await composer().fill('Original failed input');await page.getByRole('button',{name:'Send',exact:true}).click();await ready;await composer().fill('Newer Alpha draft');
    await nav().getByRole('button',{name:/Beta project \/workspace\/Beta project/}).click();await composer().fill('Newer Beta draft');release();await page.getByText('Delivery could not be confirmed. Check the conversation before sending again.',{exact:true}).waitFor();
    assert.equal(await composer().inputValue(),'Newer Beta draft');assert.equal(await page.getByRole('button',{name:'Restore draft',exact:true}).isDisabled(),true);
    await nav().getByRole('button',{name:/Alpha project \/workspace\/Alpha project/}).click();assert.equal(await composer().inputValue(),'Newer Alpha draft');await composer().fill('');await page.getByRole('button',{name:'Restore draft',exact:true}).click();assert.equal(await composer().inputValue(),'Original failed input');
    await page.unroute('**/prompt_async?*');assert.equal(requests.filter(r=>r.url.includes('/prompt_async')).length,1);
    await page.route('**/event?*',r=>r.abort());await page.reload();await page.locator('[data-connected=false]').waitFor();await page.unroute('**/event?*');await page.locator('[data-connected=true]').waitFor({timeout:20000});assert.equal(new URL(page.url()).searchParams.get('assistantSession'),ids[0]);assert.equal(await composer().inputValue(),'Original failed input');
    assert.equal(requests.filter(r=>r.url.includes('/prompt_async')).length,1);checks.push('Delayed failure after context switch preserves both newer drafts; explicit restore; SSE reconnect attaches same session without duplicate prompt');
    await composer().fill('TAB_HOLD');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('button',{name:'Stop current run',exact:true}).waitFor();await page.getByRole('button',{name:'Stop current run',exact:true}).click();await page.locator('.assistant-run-status').getByText('Stopped',{exact:true}).waitFor({timeout:20000});
    await composer().fill('Synthetic denied action');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('button',{name:'Reject',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'Reject',exact:true}).click();
    await page.locator('.assistant-confirmation').waitFor({state:'detached'});assert.ok(requests.some(r=>r.url.includes('/permission/')&&JSON.parse(r.body).reply==='reject'));
    checks.push('Actual native Stop produces interrupted state; permission refusal replies to the original native request');assert.deepEqual(errors,[]);return;
  }
  if(process.env.NATIVE_EXPERIENCE_STAGE==='isolation'){
    await routes.get(owner.id).client.workspaceOperation('folders',{directory:'/workspace',name:'Private project'});
    const response=await routes.get(owner.id).native.request('POST','/session?directory=/workspace/Private%20project',{body:JSON.stringify({title:'Private conversation'})});const session=await response.json();
    const url=new URL(page.url());url.searchParams.set('assistantSession',session.id);url.searchParams.set('assistantDirectory','/workspace/Private project');await page.goto(url.href);await composer().waitFor();await composer().fill('Private draft');
    const token=(await context.cookies()).find(c=>c.name==='__Host-teamaibox-csrf')?.value;
    assert.equal((await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':token}})).status(),200);
    await login('synthetic-b');await page.reload();await page.locator('.assistant-project-home').waitFor();
    assert.equal(new URL(page.url()).searchParams.has('assistantDirectory'),false);assert.equal(await page.getByText('Private draft',{exact:true}).count(),0);assert.equal(await nav().getByRole('button',{name:/Private project/}).count(),0);
    checks.push('Account-switch fix: previous user URL directory, session, projects and draft are detached; actual second-user authentication');assert.deepEqual(errors,[]);return;
  }
  const newProject=async name=>{
    await nav().getByRole('button',{name:'New project',exact:true}).click();const modal=page.getByRole('dialog');
    await modal.getByRole('button',{name:'workspace',exact:true}).click();await modal.getByRole('textbox',{name:'Folder name',exact:true}).fill(name);await modal.getByRole('button',{name:'Create project',exact:true}).click();
    await composer().waitFor();await page.waitForFunction(value=>new URL(location.href).searchParams.get('assistantDirectory')===value,'/workspace/'+name);
  };
  if(!['actions','manage'].includes(process.env.NATIVE_EXPERIENCE_STAGE)){
  await newProject('Alpha project');await composer().fill('Alpha draft');
  await page.locator('.assistant-attach input').setInputFiles({name:'draft-note.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment')});
  await newProject('Beta project');await composer().fill('Beta draft');
  await nav().getByRole('button',{name:/Alpha project \/workspace\/Alpha project/}).click();
  assert.equal(await composer().inputValue(),'Alpha draft');assert.equal(await page.locator('.assistant-attachment').count(),1);
  await nav().getByRole('button',{name:/Beta project \/workspace\/Beta project/}).click();assert.equal(await composer().inputValue(),'Beta draft');
  await nav().getByRole('button',{name:/Alpha project \/workspace\/Alpha project/}).click();await page.reload();await composer().waitFor();assert.equal(await composer().inputValue(),'Alpha draft');
  await page.getByText('Select this attachment again before sending.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Remove attachment',exact:true}).click();checks.push('Two real non-Git workspace folders, project-scoped drafts, in-page attachment retention and refresh reselection');
  assert.equal(docker('exec',resources[0].name,'node','-e',"process.stdout.write(String(require('fs').existsSync('/workspace/Alpha project/.git')))"),'false');
  await nav().getByRole('button',{name:'Open a folder',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'workspace',exact:true}).click();await dialog.getByRole('button',{name:'Alpha project',exact:true}).click();
  const input=dialog.getByLabel('Import files',{exact:true});await input.setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic project notes\n')});
  await dialog.getByText('notes.txt · ✓',{exact:true}).waitFor();await input.setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('must not replace')});
  await dialog.locator('.assistant-import-results li').filter({hasText:'notes.txt'}).waitFor();assert.equal(docker('exec',resources[0].name,'node','-e',"process.stdout.write(require('fs').readFileSync('/workspace/Alpha project/notes.txt','utf8'))"),'Synthetic project notes');
  await dialog.getByRole('button',{name:'Open a folder',exact:true}).click();
  await assert.rejects(routes.get(second.id).client.workspaceOperation('files',{directory:'/workspace/Alpha project',name:'notes.txt',content:'eA=='}));
  docker('exec',resources[0].name,'node','-e',"require('fs').symlinkSync('/tmp','/workspace/escape')");
  await assert.rejects(routes.get(owner.id).client.workspaceOperation('files',{directory:'/workspace/escape',name:'escape.txt',content:'eA=='}),{status:403});
  await assert.rejects(routes.get(owner.id).client.workspaceOperation('files',{directory:'/workspace/../tmp',name:'escape.txt',content:'eA=='}));
  checks.push('Browser → authenticated platform → real container Bridge → files: import, no overwrite, other-owner and symlink/traversal rejection');
  }else{
    const client=routes.get(owner.id).client;
    for(const name of ['Alpha project','Beta project'])await client.workspaceOperation('folders',{directory:'/workspace',name});
    await client.workspaceOperation('files',{directory:'/workspace/Alpha project',name:'notes.txt',content:Buffer.from('Synthetic project notes\n').toString('base64')});
    await nav().getByRole('button',{name:'Open a folder',exact:true}).click();const picker=page.getByRole('dialog');
    await picker.getByRole('button',{name:'Alpha project',exact:true}).click();await picker.getByRole('button',{name:'Open a folder',exact:true}).click();await composer().waitFor();
  }
  if(process.env.NATIVE_EXPERIENCE_STAGE!=='manage'){
  await composer().fill('Synthetic project reply');await page.getByRole('button',{name:'Send',exact:true}).click();await composer().fill('Newer unsent text');
  await page.waitForFunction(()=>new URL(location.href).searchParams.get('assistantSession'));
  const permission=page.getByRole('button',{name:'Allow once',exact:true});await permission.waitFor({timeout:45000});await permission.click();
  await page.locator('.assistant-transcript .assistant-message__content').filter({hasText:'Synthetic native execution completed.'}).waitFor({timeout:45000});assert.equal(await composer().inputValue(),'Newer unsent text');
  assert.equal(requests.filter(r=>r.url.includes('/prompt_async')).length,1);
  }else{
    const response=await routes.get(owner.id).native.request('POST','/session?directory=/workspace/Alpha%20project',{body:JSON.stringify({title:'Native conversation'})});const item=await response.json();const url=new URL(page.url());url.searchParams.set('assistantSession',item.id);url.searchParams.set('assistantDirectory','/workspace/Alpha project');await page.goto(url.href);await composer().waitFor();await composer().fill('Newer unsent text');
  }
  const session=new URL(page.url()).searchParams.get('assistantSession');
  const more=()=>page.locator('.assistant-more-menu>summary');await more().click();await page.locator('.assistant-more-menu').getByRole('button',{name:'Rename',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox',{name:'Rename',exact:true}).fill('Launch conversation');await dialog.getByRole('button',{name:'Save',exact:true}).click();await page.locator('.assistant-session-heading h3').filter({hasText:'Launch conversation'}).waitFor();
  await more().click();await page.locator('.assistant-more-menu').getByRole('button',{name:'Branch conversation',exact:true}).click();await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')!==id,session);assert.equal(await composer().inputValue(),'');
  const branch=new URL(page.url()).searchParams.get('assistantSession');await more().click();await page.getByRole('button',{name:'Delete conversation',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal(new URL(page.url()).searchParams.get('assistantSession'),branch);
  await more().click();await page.getByRole('button',{name:'Delete conversation',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByText('Project files will be kept.',{exact:true}).waitFor();await dialog.getByRole('button',{name:'Delete conversation',exact:true}).click();
  await page.waitForFunction(()=>!new URL(location.href).searchParams.has('assistantSession'));
  await page.locator('.assistant-header-search').click();await page.locator('.native-session-index').getByRole('button',{name:'Launch conversation',exact:true}).click();await composer().waitFor();assert.equal(await composer().inputValue(),'Newer unsent text');
  await page.reload();await composer().waitFor();assert.equal(new URL(page.url()).searchParams.get('assistantSession'),session);assert.equal(await composer().inputValue(),'Newer unsent text');
  checks.push('Rename, branch, cancelled/confirmed delete, owner-wide search and deep-link reload; real native send/permission/reply evidence reused from prior stage');
  await page.getByRole('button',{name:'Files',exact:true}).click();await page.locator('.assistant-context-panel .native-file-list').getByRole('button',{name:'notes.txt',exact:true}).click();await page.locator('.assistant-context-panel pre').filter({hasText:'Synthetic project notes'}).waitFor();
  await page.locator('.assistant-context-panel>header').getByRole('button',{name:'Close',exact:true}).click();assert.equal(await composer().inputValue(),'Newer unsent text');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.locator('.assistant-context-panel').getByRole('button',{name:'+ Terminal',exact:true}).click();await page.locator('.native-terminal .xterm').waitFor();
  const before=await routes.get(owner.id).native.request('GET','/pty?directory=/workspace/Alpha%20project');const ptys=await before.json();assert.ok(ptys.length);
  await page.locator('.assistant-context-panel>header').getByRole('button',{name:'Close',exact:true}).click();const after=await routes.get(owner.id).native.request('GET','/pty?directory=/workspace/Alpha%20project');assert.equal((await after.json()).length,ptys.length);
  assert.equal(requests.filter(r=>r.method==='DELETE'&&r.url.includes('/pty/')).length,0);checks.push('File panel reads imported bytes and closing the real PTY view leaves the terminal alive');
  for(const [width,height,locale,theme] of [[1440,1000,'en','dark'],[1280,800,'zh-CN','light'],[430,932,'ar','dark']]){
    await page.setViewportSize({width,height});await page.getByLabel('Fixture language').selectOption(locale);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.waitForFunction(()=>{const r=document.querySelector('.assistant-compose-input').getBoundingClientRect();return r.width>80&&r.top>=0&&r.bottom<=innerHeight;});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:join(evidence,`projects-${locale}-${theme}-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:1000});await page.getByLabel('Fixture language').selectOption('en');
  await context.request.post(origin+'/api/auth/sign-out',{headers:{origin,'x-csrf-token':(await context.cookies()).find(c=>c.name==='__Host-teamaibox-csrf')?.value}});
  await login('synthetic-b');await page.reload();await page.locator('.assistant-project-home').waitFor();assert.equal(await page.getByText('Newer unsent text',{exact:true}).count(),0);assert.equal(await nav().getByRole('button',{name:/Alpha project/}).count(),0);
  checks.push('English dark, Chinese light and Arabic RTL at three viewport sizes; second authenticated user sees no prior projects/drafts');assert.deepEqual(errors,[]);
}
