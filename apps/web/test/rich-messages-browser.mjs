// Synthetic message projections rendered by the actual production React route.
// Real platform authentication and native per-owner filesystem; no model prompt.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function runRichMessages({page,context,routes,owner,second,origin,checks,errors,evidence,docker,resources,login,externalRequests}){
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await page.exposeFunction('__richPolicyViolation',value=>errors.push('CSP violation: '+value));
  await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',event=>window.__richPolicyViolation(event.violatedDirective)));
  const native=routes.get(owner.id).native;
  const result=await native.request('POST','/session',{body:JSON.stringify({title:'Rich message presentation'})});
  const session=await result.json();
  const png=await readFile(new URL('../public/brand/mascot.png',import.meta.url));
  const dataImage='data:image/png;base64,'+png.toString('base64');
  const filename='rich-message-preview.png';
  docker('exec',resources[0].name,'node','--input-type=module','-e',`import{writeFile}from'node:fs/promises';await writeFile('/workspace/${filename}',Buffer.from('${png.toString('base64')}','base64'));await writeFile('/workspace/rich-message-note.txt','Synthetic attachment.');`);
  const now=Date.now();
  const message=(id,parts,complete=true)=>({info:{id,sessionID:session.id,role:'assistant',time:{created:now,...(complete?{completed:now}: {})}},parts});
  let revision=0,reads=0;
  let messages=[message('msg_rich',[{id:'prt_text',type:'text',text:'# Rich answers\n\nA stable paragraph for selection.\n\n**Streaming'}],false)];
  const pattern=`**/session/${session.id}/message?*`;
  await page.route(pattern,route=>{reads++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(messages)});});
  async function update(next){
    messages=next;const previous=reads;
    const refreshed=page.waitForResponse(r=>r.url().includes(`/session/${session.id}/message?`));
    const response=await native.request('PATCH',`/session/${session.id}`,{body:JSON.stringify({title:'Rich message presentation '+(++revision)})});assert.equal(response.status,200);
    await (await refreshed).finished();
    assert.ok(reads>previous,'Native metadata event must refresh the synthetic message projection');
  }
  const url=new URL('/apps/assistant',origin);url.searchParams.set('assistantSession',session.id);url.searchParams.set('assistantView','conversation');
  await page.goto(url.href);await page.getByRole('heading',{name:'Rich answers',exact:true}).waitFor();
  const phase=process.env.RICH_RESUME??'all';
  let executions=0;page.on('request',request=>{if(request.method()==='POST'&&/\/(?:prompt_async|prompt|command|shell)(?:\?|$)/.test(request.url()))executions++;});
  const markdown='# Rich answers\n\nA stable paragraph for selection.\n\n**Streaming bold** and *emphasis* with `inline code`.\n\n- First item\n- Second item\n\n> A clear quotation.\n\n| Feature | State |\n| --- | --- |\n| Markdown | Ready |\n\n```typescript\nconst answer = 42;\nconsole.log(answer);\n```\n\nInline math $E=mc^2$.\n\n$$\n\\frac{a}{b}=c\n$$\n\n```mermaid\nflowchart LR\n A[Question] --> B[Answer]\n```\n';
  if(['all','render'].includes(phase)){
    await page.locator('.assistant-transcript').evaluate(n=>n.scrollTop=0);
    await page.evaluate(()=>{const p=[...document.querySelectorAll('.assistant-rich-text p')].find(n=>n.textContent==='A stable paragraph for selection.');window.__richStable=p;const r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r);});
    await update([message('msg_rich',[{id:'prt_text',type:'text',text:markdown.slice(0,markdown.indexOf('console.log'))}],false)]);
    await page.getByText('Streaming bold',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>window.__richStable?.isConnected&&getSelection().toString()==='A stable paragraph for selection.'));
    assert.equal(await page.locator('.assistant-code').first().getAttribute('data-incomplete'),'true');
    await update([message('msg_rich',[{id:'prt_text',type:'text',text:markdown}])]);
    await page.locator('.assistant-code .hljs-keyword').first().waitFor();
    assert.equal(await page.locator('.assistant-rich-text table').count(),1);
    await page.waitForFunction(()=>document.querySelectorAll('.assistant-rich-text .katex').length>=2);
    await page.locator('.assistant-diagram img').waitFor({timeout:30000});
    await page.locator('.assistant-code[data-language=typescript]').getByRole('button',{name:'Copy code',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'const answer = 42;\nconsole.log(answer);');
    await page.locator('.assistant-diagram').getByRole('button',{name:'Source',exact:true}).click();
    assert.match(await page.locator('.assistant-diagram pre').innerText(),/flowchart LR/);
    await page.reload();await page.getByRole('heading',{name:'Rich answers',exact:true}).waitFor();await page.locator('.assistant-diagram img').waitFor({timeout:30000});
    checks.push('Built React: partial Markdown converges to GFM/code/math/Mermaid; unchanged paragraph selection retained; exact code copy; diagram source; history reload; no model execution');
    await page.screenshot({path:join(evidence,'rich-answer-dark.png')});
  }
  const mediaParts=[
    {id:'prt_media_text',type:'text',text:`## Images and files\n\n![Workspace preview](./${filename})\n\n![Missing image](./does-not-exist.png)\n\n![External preview](https://example.invalid/preview.png)`},
    {id:'prt_file',type:'file',mime:'image/png',filename:'Native image attachment',url:dataImage},
    {id:'prt_reasoning',type:'reasoning',text:'**Reasoning detail** without an extra execution.',time:{start:now,end:now}},
    {id:'prt_tool',type:'tool',tool:'read_demo',state:{status:'completed',title:'Read demonstration files',input:{path:filename},output:'Actual native fields are presented, not executed.',attachments:[{id:'prt_tool_image',type:'file',mime:'image/png',filename:'Tool image attachment',url:dataImage},{id:'prt_tool_file',type:'file',mime:'text/plain',filename:'rich-message-note.txt',url:'file:///workspace/rich-message-note.txt'}]}},
    {id:'prt_error',type:'tool',tool:'failed_demo',state:{status:'error',input:{},error:'Synthetic tool failure'}},
    {id:'prt_pending',type:'tool',tool:'pending_demo',state:{status:'pending',input:{}}},
    {id:'prt_running',type:'tool',tool:'running_demo',state:{status:'running',title:'Still working',input:{}}},
    {id:'prt_future',type:'unknown-part',value:'Retained original field'},
  ];
  if(['all','media'].includes(phase)){
    await update([message('msg_rich_media',mediaParts)]);
    await page.getByRole('heading',{name:'Images and files',exact:true}).waitFor();
    for(const alt of ['Workspace preview','Native image attachment'])await page.getByRole('img',{name:alt,exact:true}).waitFor();
    await page.getByRole('button',{name:'Enlarge image: Native image attachment',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Native image attachment',exact:true});await dialog.waitFor();assert.ok(await dialog.evaluate(n=>n.contains(document.activeElement)));
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.ok(await page.getByRole('button',{name:'Enlarge image: Native image attachment',exact:true}).evaluate(n=>n===document.activeElement));
    const tool=page.locator('.assistant-tool-card').filter({hasText:'read_demo'});await tool.locator(':scope>summary').click();await tool.getByRole('img',{name:'Tool image attachment',exact:true}).waitFor();
    const download=page.waitForEvent('download');await tool.getByRole('button',{name:'Download file',exact:true}).click();const file=await download;assert.equal(file.suggestedFilename(),'rich-message-note.txt');assert.equal(await readFile(await file.path(),'utf8'),'Synthetic attachment.');
    await page.locator('.assistant-image[data-media-state=error]').waitFor();
    await page.locator('.assistant-reasoning>summary').click();await page.getByText('Reasoning detail',{exact:true}).waitFor();
    for(const status of ['completed','error','pending','running'])assert.equal(await page.locator(`.assistant-tool-card[data-tool-status=${status}]`).count(),1);
    await page.locator('.assistant-tool-card[data-tool-status=error]>summary').click();await page.getByRole('alert').filter({hasText:'Synthetic tool failure'}).waitFor();
    await tool.locator('.assistant-part-raw>summary').click();assert.match(await tool.locator('.assistant-part-raw pre').innerText(),/"attachments"/);
    const external=page.getByRole('link',{name:'Open external image',exact:true});assert.equal(await external.getAttribute('href'),'https://example.invalid/preview.png');assert.match(await external.getAttribute('rel'),/noreferrer/);
    assert.equal(externalRequests.length,0);
    checks.push('Built React with real owner filesystem: workspace/part/tool image previews, missing-image fallback, native file download, modal Escape/focus, reasoning and all tool states/raw details; external image stays an explicit link');
    await page.screenshot({path:join(evidence,'rich-media-tools-dark.png')});
  }
  if(['all','security'].includes(phase)){
    const hostile='# Safe content\n\n<img src=x onerror="window.__richXss=1">\n\n[Unsafe](javascript:alert(1))\n\n```unknown_language\nraw <code> & text\n```\n\n```mermaid\nnot a diagram\n```\n\n$$\n\\notACommand{\n$$';
    await update([message('msg_safe',[{id:'prt_safe',type:'text',text:hostile},{id:'prt_svg',type:'file',mime:'image/png',filename:'Not a PNG',url:'data:image/png;base64,'+Buffer.from('<svg onload="alert(1)"/>').toString('base64')}])]);
    await page.getByRole('heading',{name:'Safe content',exact:true}).waitFor();await page.getByText('Could not render diagram. Source is available.',{exact:true}).waitFor({timeout:30000});
    assert.equal(await page.locator('.assistant-rich-text [onerror],.assistant-rich-text script,.assistant-rich-text a[href^="javascript:"]').count(),0);
    assert.equal(await page.evaluate(()=>window.__richXss),undefined);
    await page.locator('.assistant-image[data-media-state=error]').waitFor();
    assert.equal(await page.locator('.assistant-code[data-language=unknown_language] code').innerText(),'raw <code> & text');
    // Delay an actual authenticated file response, switch context, then release it.
    let arrived,release;const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);let held=false;
    await page.route(`**/api/fs/read/${filename}?*`,async route=>{if(held)return route.continue();held=true;const response=await route.fetch();arrived();await gate;await route.fulfill({response});});
    await update([message('msg_delayed',[{id:'prt_delayed',type:'text',text:`![Delayed image](./${filename})`}])]);await ready;
    const empty=await (await native.request('POST','/session',{body:JSON.stringify({title:'Another presentation context'})})).json();
    const newUrl=new URL(page.url());newUrl.searchParams.set('assistantSession',empty.id);await page.goto(newUrl.href);release();
    await page.waitForFunction(()=>!document.querySelector('.assistant-image img'));
    checks.push('Unsafe HTML/URLs and spoofed image rejected; invalid math/diagram keeps source; delayed image cannot attach after context switch');
    await page.unroute(`**/api/fs/read/${filename}?*`);
  }
  if(['all','layout','final'].includes(phase)){
    await page.goto(url.href);await update([message('msg_long',[{id:'prt_long',type:'text',text:markdown+'\n\n'+('A long paragraph with output. '.repeat(80)+'\n\n').repeat(12)}],false)]);
    const transcript=page.locator('.assistant-transcript');
    await page.waitForFunction(()=>{const n=document.querySelector('.assistant-transcript');return n.scrollHeight>n.clientHeight*3&&n.scrollHeight-n.clientHeight-n.scrollTop<50;});
    await transcript.hover();await page.mouse.wheel(0,-1000);await page.waitForFunction(()=>document.querySelector('.assistant-jump-latest'));
    const top=await transcript.evaluate(n=>n.scrollTop);
    await update([message('msg_long',[{id:'prt_long',type:'text',text:messages[0].parts[0].text+'\n\nNew streamed tail. '.repeat(80)}],false)]);
    assert.ok(Math.abs(await transcript.evaluate(n=>n.scrollTop)-top)<3);
    await page.getByRole('button',{name:'Jump to latest',exact:true}).click();await page.waitForFunction(()=>{const n=document.querySelector('.assistant-transcript');return n.scrollHeight-n.clientHeight-n.scrollTop<50;});
    const preferences=()=>page.locator('.topbar .appearance-preferences select');
    for(const [width,height,locale,theme] of [[1440,1000,'en','dark'],[1280,800,'zh-CN','light'],[430,932,'ar','dark']]){
      await page.setViewportSize({width,height});
      if(width===430){await page.locator('.mobile-nav button').last().click();const profile=page.locator('.profile-popover .appearance-preferences select');await profile.nth(0).selectOption(locale);await profile.nth(1).selectOption(theme);await page.keyboard.press('Escape');}
      else{await preferences().nth(0).selectOption(locale);await preferences().nth(1).selectOption(theme);}
      await page.waitForFunction(locale=>document.documentElement.lang===locale,locale);
      await page.waitForFunction(()=>{const r=document.querySelector('.assistant-compose-input').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth+1;});
      await transcript.evaluate(n=>n.scrollTop=n.scrollHeight);await page.waitForFunction(()=>{const n=document.querySelector('.assistant-transcript');return n.scrollHeight-n.clientHeight-n.scrollTop<50;});
      await transcript.hover();await page.mouse.wheel(0,-600);await page.locator('.assistant-jump-latest').waitFor();
      assert.ok(await page.locator('.assistant-jump-latest').evaluate(n=>{const r=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect();return Math.abs((r.left+r.right)-(p.left+p.right))<4&&r.left>=p.left&&r.right<=p.right;}),'Jump control stays centered and contained in LTR/RTL');
      assert.equal(await page.locator('.assistant-error').count(),0,'No native preparation or rendering error banner');
      await page.screenshot({path:join(evidence,`rich-layout-${locale}-${theme}.png`)});
    }
    checks.push('Built React: scroll-back retained, explicit tail following, long code/table/content contained; desktop/light/narrow/RTL inputs remain reachable');
  }
  if(['all','boundaries','final'].includes(phase)){
    await page.setViewportSize({width:1440,height:1000});
    const preferences=page.locator('.topbar .appearance-preferences select');await preferences.nth(0).selectOption('en');await preferences.nth(1).selectOption('dark');
    await page.waitForFunction(()=>document.documentElement.lang==='en');
    // Exercise actual incomplete-tail rendering beyond the initial fence case.
    for(const text of ['- First item\n- Sec','- First item\n- Second item\n\n**Bo','- First item\n- Second item\n\n**Bold** [Guide](https://example.invalid/gu']){
      await update([message('msg_fragments',[{id:'prt_fragments',type:'text',text}],false)]);
      await page.waitForFunction(()=>document.querySelector('.assistant-rich-text li')?.textContent==='First item');
    }
    const final='- First item\n- Second item\n\n**Bold** [Guide](https://example.invalid/guide)\n\n```unknown_language\nraw <code> & text\n```';
    await update([message('msg_fragments',[{id:'prt_fragments',type:'text',text:final}])]);
    await page.locator('.assistant-rich-text a[href="https://example.invalid/guide"]').waitFor();
    assert.deepEqual(await page.locator('.assistant-rich-text li').allTextContents(),['First item','Second item']);
    assert.equal(await page.locator('.assistant-rich-text strong').innerText(),'Bold');
    assert.equal(await page.locator('.assistant-code code').innerText(),'raw <code> & text');
    const statePart={id:'prt_transition',type:'tool',tool:'state_transition',state:{status:'running',input:{}}};
    await update([message('msg_transition',[statePart],false)]);await page.locator('[data-tool-status=running]').waitFor();
    await update([message('msg_transition',[{...statePart,state:{...statePart.state,status:'error',error:'Terminal failure'}}])]);
    await page.locator('[data-tool-status=error]').waitFor();assert.equal(await page.locator('[data-tool-status=completed]').count(),0);
    await page.evaluate(()=>{window.__richCreated=[];window.__richRevoked=[];const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=(blob)=>{const url=create(blob);window.__richCreated.push(url);return url;};URL.revokeObjectURL=url=>{window.__richRevoked.push(url);revoke(url);};});
    await update([message('msg_scoped',[{id:'prt_scoped',type:'file',mime:'image/png',filename:'Scoped preview',url:dataImage}])]);
    await page.locator('.assistant-image img').waitFor();const previousUrls=await page.evaluate(()=>window.__richCreated.slice());assert.ok(previousUrls.length);
    // SPA selection must dispose resources, not merely a full-document reload.
    const empty=await (await native.request('POST','/session',{body:JSON.stringify({title:'Scoped empty context'})})).json();
    await page.locator('.assistant-session-row').filter({hasText:'Scoped empty context'}).click();
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,empty.id);
    await page.waitForFunction(urls=>urls.every(u=>window.__richRevoked.includes(u)),previousUrls);
    assert.equal(await page.locator('.assistant-image img').count(),0);
    await page.locator('.assistant-session-row').filter({hasText:'Rich message presentation'}).click();await page.locator('.assistant-image img').waitFor();
    let arrived,release;const ready=new Promise(r=>arrived=r),gate=new Promise(r=>release=r);
    await page.route(`**/api/fs/read/${filename}?*`,async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});});
    await update([message('msg_late',[{id:'prt_late',type:'text',text:`![Delayed scope](./${filename})`}])]);await ready;
    await page.locator('.assistant-session-row').filter({hasText:'Scoped empty context'}).click();
    await page.waitForFunction(id=>new URL(location.href).searchParams.get('assistantSession')===id,empty.id);release();
    await page.waitForFunction(()=>!document.querySelector('.assistant-image img'));
    await page.unroute(`**/api/fs/read/${filename}?*`);
    checks.push('Additional incomplete list/emphasis/link tails converge once; running tool becomes error; SPA context switch revokes previews and cancels late images');
  }
  if(['all','boundaries','owner-boundary','final'].includes(phase)){
    // A matching relative filename belongs to each owner's separate container.
    // Missing files use the pinned engine's error semantics, not always 404.
    docker('exec',resources[1].name,'node','-e',`require('fs').writeFileSync('/workspace/${filename}','Other owner synthetic bytes');`);
    const first=await context.request.get(origin+`/api/v1/assistant/native/api/fs/read/${filename}?directory=/workspace`);assert.equal(first.status(),200);assert.deepEqual(await first.body(),png);
    docker('exec',resources[0].name,'node','-e',"const fs=require('fs');fs.writeFileSync('/tmp/rich-private.txt','Outside workspace synthetic bytes');fs.symlinkSync('/tmp/rich-private.txt','/workspace/rich-escape.txt');");
    const escape=await context.request.get(origin+'/api/v1/assistant/native/api/fs/read/rich-escape.txt?directory=/workspace');assert.equal(escape.ok(),false);assert.ok(!(await escape.text()).includes('Outside workspace synthetic bytes'));
    await login('synthetic-b');const other=await context.request.get(origin+`/api/v1/assistant/native/api/fs/read/${filename}?directory=/workspace`);assert.equal(other.status(),200);assert.equal(await other.text(),'Other owner synthetic bytes');
    await page.goto(new URL('/apps/assistant',origin).href);await page.locator('.assistant-project-home').waitFor();assert.equal(await page.locator('.assistant-image img').count(),0);
    checks.push('Same filename resolves only to the authenticated owner; native realpath containment rejects workspace symlink escape; account switch has no previous image');
  }
  assert.equal(executions,0,'Presentation must never execute a prompt or tool');
  assert.equal(externalRequests.length,0);
  assert.deepEqual(errors,[]);
}
