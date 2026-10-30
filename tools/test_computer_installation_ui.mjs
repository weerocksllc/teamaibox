import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createVirtualComputersPluginServer} from '../apps/virtual-computers-plugin/src/server.mjs';
import {supportedLocaleCodes} from '../packages/ui-system/src/locale-registry.mjs';
const {chromium,webkit}=createRequire(import.meta.url)(process.env.TEAMAIBOX_PLAYWRIGHT_MODULE||'playwright');
const server=createVirtualComputersPluginServer();
const staticHandlers=server.listeners('request');server.removeAllListeners('request');
let receivePart;
server.on('request',(req,res)=>{
 if(req.method==='PUT'&&/^\/api\/v1\/objects\/multipart\/[^/]+\/parts\/\d+$/.test(req.url)){
  void (async()=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);
   receivePart(req,Buffer.concat(chunks));res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  })().catch(error=>{res.writeHead(500);res.end();console.error(error);});
 }else for(const handler of staticHandlers)handler.call(server,req,res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,root='/plugins/official.virtual-computers/';
const output=await mkdtemp(join(tmpdir(),'teamaibox-installation-ui-'));
try{
 for(const [engine,type] of Object.entries({chromium,webkit})){
  const browser=await type.launch({headless:true});
  try{
   const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[],requests=[];
   page.on('pageerror',e=>errors.push(e.message));
   // Isolated browser fixture. Every mutation is intercepted; no appliance,
   // original guest, real drive file or user account is reachable here.
   const owner=randomUUID(),computerId=randomUUID(),mediaId=randomUUID(),rootId=randomUUID(),fileId=randomUUID(),uploadId=randomUUID(),objectId=randomUUID(),referenceId=randomUUID();
   let uploaded=null,parts=[];
   receivePart=(request,bytes)=>{
    assert(bytes.length>0);assert(bytes.every(value=>value===42));
    parts.push({partNumber:Number(request.url.split('/').at(-1)),size:bytes.length,integrity:{digest:request.headers['x-content-sha256']}});
   };
   const base={id:computerId,name:'Installation fixture only',state:'stopped',revision:1,
    system:{id:'linux-arm64',name:'Linux',edition:'ARM64',installable:true},resources:{vcpus:2,memoryBytes:4*1024**3,diskBytes:32*1024**3},errorCode:null};
   let media=[{id:mediaId,name:'ARM64 fixture.iso',state:'ready',revision:1,compatibility:'arm64',size:2**30}],
    installation={revision:1,observedRevision:1,observedMediaId:null,desiredMediaId:null,boot:null,operationId:null,phase:'empty'};
   await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,
     body=request.headers()['content-type']?.includes('application/json')?request.postDataJSON():null;
    if(request.method()!=='GET')requests.push({path,body});
    let data,status=200;
    if(path.endsWith('/availability'))data={ownerId:owner,enabled:true,limits:{maximum:{}},systems:['windows','linux'].map(os=>({id:os+'-arm64',name:os,edition:'ARM64',minimum:{vcpus:2,memoryGiB:4,diskGiB:32},createEnabled:true,installable:true}))};
    else if(path.endsWith('/shared-with-me'))data={data:[]};
    else if(path==='/api/v1/virtual-computers'&&request.method()==='GET')data={data:[base]};
    else if(path==='/api/v1/virtual-computers'&&request.method()==='POST')data={id:randomUUID(),computerId:randomUUID(),state:'queued'};
    else if(path.endsWith('/installation-media')&&request.method()==='GET')data={data:media};
    else if(path.endsWith('/installation-media')&&request.method()==='POST'){
     if(body.source==='drive'){assert.equal(body.version,3);assert.equal(body.fileId,fileId);}
     else{assert.equal(body.source,'upload');assert.equal(body.referenceId,referenceId);}
     data={id:randomUUID(),name:body.name,source:body.source,state:'ready',revision:1,compatibility:body.source==='drive'?'unverified':'arm64',size:3*2**30};media.push(data);
    }else if(path.endsWith('/installation'))data={supported:true,installation};
    else if(path.includes('/installation/')){
     const action=path.split('/').at(-1);assert.equal(body.expectedRevision,installation.revision);
     installation={...installation,revision:installation.revision+1,observedRevision:installation.revision+1};
     if(action==='mount')installation.observedMediaId=installation.desiredMediaId=body.mediaId;
     if(action==='eject')installation.observedMediaId=installation.desiredMediaId=null;
     if(action==='boot-disc')installation.boot={state:'pending'};
     if(action==='cancel-boot')installation.boot={state:'cancelled'};
     data={id:randomUUID(),computerId,state:'succeeded'};
    }else if(path==='/api/v1/objects/multipart'&&request.method()==='POST'){
     uploaded={objectId,objectKey:'virtual-computers/installation/'+uploadId,namespaceKey:'user:'+owner,size:body.size,integrity:{digest:body.sha256}};
     parts=[];data={upload:{uploadId,objectKey:uploaded.objectKey},part_size_bytes:65536};
    }else if(path.endsWith('/parts')&&request.method()==='GET')data={data:parts};
    else if(path.includes('/parts/')&&request.method()==='PUT'){
     // WebKit does not expose Blob body through Playwright routing. Receive
     // actual bytes at the isolated HTTP fixture instead of fabricating sizes.
     await route.continue();return;
    }else if(path==='/api/v1/objects/multipart/'+uploadId&&request.method()==='POST')data={};
    else if(path==='/api/v1/objects')data={data:[uploaded]};
    else if(path==='/api/v1/objects/'+objectId+'/references')data={reference_id:referenceId};
    else if(path==='/api/v1/files/bootstrap')data={data:[{id:rootId,scope_kind:'user'}]};
    else if(path.includes('/files/roots/'))data={data:[{id:fileId,kind:'file',name:'Drive ARM64.iso',current_version:3}]};
    else{status=404;data={error:{code:'not_found'}};}
    await route.fulfill({status,json:data});
   });
   // Header construction is tested without a privileged browser session.
   await page.addInitScript(()=>Object.defineProperty(document,'cookie',{get:()=> '__Host-teamaibox-csrf=isolated-fixture'}));
   await page.goto(origin+root+'?locale=en&theme=dark');
   await page.locator('#create:enabled').waitFor();
   const catalogs=await page.evaluate(async()=> (await import('./installation-text.mjs')).installationCatalogs);
   assert.deepEqual(Object.keys(catalogs).sort(),[...supportedLocaleCodes].sort());
   for(const locale of supportedLocaleCodes){assert.equal(Object.keys(catalogs[locale]).length,38);assert(Object.values(catalogs[locale]).every(v=>typeof v==='string'&&v.trim()));}
   await page.locator('#create').click();await page.locator('#name').fill('New installation fixture');
   await page.locator('#choose-iso').click();
   const dialog=page.locator('.installation-dialog');await dialog.getByRole('button',{name:'ARM64 fixture.iso',exact:false}).click();
   await dialog.getByRole('button',{name:'Choose installation media',exact:true}).click();
   await page.locator('#create-form button[type=submit]').click();
   assert(requests.some(r=>r.path==='/api/v1/virtual-computers'&&r.body.installationMediaId===mediaId));
   await page.getByRole('button',{name:'System installation & optical drive',exact:true}).click();
   await dialog.getByRole('button',{name:'ARM64 fixture.iso',exact:false}).click();
   await dialog.getByRole('button',{name:'Mount',exact:true}).click();
   await dialog.getByRole('button',{name:'Boot from disc next time',exact:true}).click();
   await dialog.getByRole('button',{name:'Cancel disc boot',exact:true}).click();
   await dialog.getByRole('button',{name:'Eject',exact:true}).click();
   assert.equal(requests.filter(r=>r.path.endsWith('/start')||r.path.endsWith('/shutdown')||r.path.endsWith('/delete')).length,0);
   await dialog.getByRole('button',{name:'Choose from drive',exact:true}).click();
   await dialog.getByRole('button',{name:'Personal drive',exact:true}).click();
   await dialog.getByRole('button',{name:'Drive ARM64.iso',exact:true}).click();
   await dialog.getByRole('checkbox').check();
   await dialog.getByRole('button',{name:'Mount',exact:true}).click();
   assert(requests.some(r=>r.body?.allowUnverified===true));
   await dialog.getByRole('button',{name:'Upload ISO',exact:true}).click();
   await dialog.locator('input[type=file]').setInputFiles({name:'Local fixture.iso',mimeType:'application/x-iso9660-image',buffer:Buffer.alloc(180000,42)});
   await dialog.getByRole('button',{name:'Local fixture.iso',exact:false}).waitFor();
   assert.equal(parts.length,3);assert(requests.some(r=>r.body?.source==='upload'));
   assert.equal(await page.evaluate(owner=>localStorage.getItem('teamaibox.installation-upload.'+owner),owner),null);
   await dialog.getByRole('button',{name:'Close',exact:true}).click();
   for(const [locale,theme,width,height] of [['ja','light',1280,720],['ar','dark',390,650],['de','light',900,500]]){
    await page.setViewportSize({width,height});await page.goto(origin+root+`?locale=${locale}&theme=${theme}`);
    await page.locator('#create:enabled').waitFor();await page.locator('#create').click();await page.locator('#choose-iso').click();
    await dialog.getByRole('button',{name:'ARM64 fixture.iso',exact:false}).waitFor();
    await dialog.getByRole('button',{name:catalogs[locale].choose,exact:true}).scrollIntoViewIfNeeded();
    const bounds=await dialog.boundingBox();assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=height+1);
    const horizontal=await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1);assert(horizontal);
    await page.screenshot({path:join(output,`${engine}-${locale}-${theme}.png`)});
    await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
   }
   assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,status:'passed',newFlowMutations:requests.length,locales:17,output}));
  }finally{await browser.close();}
 }
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
