import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamicSandboxController,dynamicSandboxIdentity} from '../src/dynamic-sandbox-controller.mjs';
import {createDynamicSandboxRuntime} from '../src/dynamic-sandbox-runtime.mjs';

const owner='00000000-0000-4000-8000-000000000011';
const id=dynamicSandboxIdentity(owner), archive=id.name+'-before-penpot';
const old='sha256:'+'a'.repeat(64), next='sha256:'+'b'.repeat(64), size=8*1024**3;

function fixture({running=false,enabled=true,previous=old}={}) {
 const config={image:next,penpot:{enabled,previousAgentImage:previous},volume:'data',networks:['control','egress']};
 const requests=[],projected=[];
 const f={config,requests,projected,failCreate:false,busy:running,baseImage:old};
 const original={Id:'a'.repeat(64),Image:old,Config:{Labels:{'com.teamaibox.dynamic-agent-owner':owner},User:'65532:65532'},
   State:{Running:running,Status:running?'running':'exited',Health:{Status:'healthy'}},
   HostConfig:{ReadonlyRootfs:true,Privileged:false,Memory:size,MemorySwap:size,CapDrop:['ALL'],
    Mounts:[['/workspace','workspace'],['/run/teamaibox','runtime'],['/run/secrets','model']].map(([Target,kind])=>({Type:'volume',Source:'data',Target,ReadOnly:kind!=='workspace',VolumeOptions:{Subpath:id.key+'/'+kind}}))}};
 const containers=new Map([[id.name,original]]);f.containers=containers;f.original=original;
 f.runtime=createDynamicSandboxRuntime({config,availableMemory:async()=>128*1024**3,docker:async(method,path,body)=>{
   requests.push({method,path});
   if(path==='/images/'+next+'/json')return {Id:next,Config:{Env:['OPENCODE_DISABLE_CHANNEL_DB=1'],Labels:{
     'com.teamaibox.penpot.base-image':f.baseImage,'com.teamaibox.opencode.modified-by-platform':'true'}}};
   if(path.startsWith('/containers/json?'))return [...containers.values()].filter(c=>c.State.Running);
   const key=path.split('/')[2];
   if(method==='GET'&&path.endsWith('/json')){
     if(!containers.has(key))throw Object.assign(Error('not found'),{status:404});
     return structuredClone(containers.get(key));
   }
   if(path.startsWith('/containers/create?')){
     if(f.failCreate)throw Error('image start failed');
     assert.equal(body.Image,next);assert.deepEqual(body.HostConfig.Mounts.map(m=>m.VolumeOptions.Subpath),original.HostConfig.Mounts.map(m=>m.VolumeOptions.Subpath));
     containers.set(id.name,{Id:'b'.repeat(64),Image:next,HostConfig:body.HostConfig,Config:{User:body.User,Labels:body.Labels},State:{Running:false,Status:'created'}});return;
   }
   const entry=[...containers].find(([,c])=>c.Id===key);assert.ok(entry,path);
   if(path.includes('/rename?')){assert.equal(entry[1].State.Running,false);containers.delete(entry[0]);containers.set(path.split('?name=')[1],entry[1]);return;}
   if(path.endsWith('/start')){entry[1].State={Running:true,Status:'running',Health:{Status:'healthy'}};return;}
   throw Error('unexpected request '+path);
 }});
 const storage={async prepare(){return {token:'synthetic'};},async credentials(_id,current){projected.push(f.runtime.isLegacy(current)?'legacy':'current');},
  async touch(){},async list(){return [{...id,lastUsedAt:Date.now()}];}};
 f.controller=new DynamicSandboxController({runtime:f.runtime,storage,identities:{active:async()=>true,busy:async()=>f.busy}});
 return f;
}

test('running approved legacy stays in service; reconciliation keeps native config legacy-safe',async()=>{
 const f=fixture({running:true});
 assert.equal((await f.controller.ensure(owner)).designRuntimeStatus,'upgrade_required');
 await f.controller.reconcile();
 assert.deepEqual(f.projected,['legacy']);assert.equal(f.containers.get(id.name),f.original);
 assert.ok(f.requests.every(r=>r.method==='GET'));
});

test('stopped approved legacy is retained and new runtime shares the exact data mounts',async()=>{
 const f=fixture();
 const results=await Promise.all([f.controller.ensure(owner),f.controller.ensure(owner)]);
 assert.ok(results.every(r=>!r.designRuntimeStatus));assert.equal(f.containers.get(archive),f.original);
 assert.equal(f.containers.get(id.name).Image,next);assert.deepEqual(f.projected,['current']);
 assert.equal(f.requests.filter(r=>r.path.includes('/rename?')).length,1);
 assert.ok(f.requests.every(r=>!r.path.includes('/stop')&&r.method!=='DELETE'));
});

test('failed creation leaves original intact and retry resumes from retained stopped container',async()=>{
 const f=fixture();f.failCreate=true;
 await assert.rejects(f.controller.ensure(owner),/image start failed/);
 assert.equal(f.containers.get(archive),f.original);assert.equal(f.containers.has(id.name),false);
 f.failCreate=false;await f.controller.ensure(owner);
 assert.equal(f.containers.get(id.name).Image,next);assert.equal(f.requests.filter(r=>r.path.includes('/rename?')).length,1);
});

test('unknown image or conflicting archive is denied without Docker changes',async()=>{
 const unknown=fixture({previous:'sha256:'+'c'.repeat(64)});
 await assert.rejects(unknown.controller.ensure(owner),/identity_conflict/);
 const conflict=fixture();conflict.containers.set(archive,{...conflict.original,Image:next});
 await assert.rejects(conflict.controller.ensure(owner),/archive_conflict/);
 for(const f of [unknown,conflict]){assert.deepEqual(f.projected,[]);assert.ok(f.requests.every(r=>r.method==='GET'));}
});

test('disabled integration starts the original instead of upgrading',async()=>{
 const f=fixture({enabled:false});
 assert.equal((await f.controller.ensure(owner)).designRuntimeStatus,'upgrade_required');
 assert.equal(f.containers.get(id.name),f.original);assert.deepEqual(f.projected,['legacy']);assert.equal(f.containers.has(archive),false);
});

test('a pending platform operation recovers a stopped legacy image without switching engines',async()=>{
 const f=fixture();f.busy=true;
 assert.equal((await f.controller.ensure(owner)).designRuntimeStatus,'upgrade_required');
 assert.equal(f.containers.get(id.name),f.original);assert.deepEqual(f.projected,['legacy']);assert.equal(f.containers.has(archive),false);
});

test('different base provenance refuses the cutover before changing mounts or name',async()=>{
 const f=fixture();f.baseImage='sha256:'+'c'.repeat(64);
 await assert.rejects(f.controller.ensure(owner),/upgrade_image_incompatible/);
 assert.equal(f.containers.get(id.name),f.original);assert.ok(f.requests.every(r=>r.method==='GET'));
 assert.deepEqual(f.projected,[]);
});

test('disabling during an interrupted cutover restores the stopped original name and image',async()=>{
 const f=fixture();f.failCreate=true;
 await assert.rejects(f.controller.ensure(owner),/image start failed/);
 f.config.penpot.enabled=false;
 assert.equal((await f.controller.ensure(owner)).designRuntimeStatus,'upgrade_required');
 assert.equal(f.containers.get(id.name),f.original);assert.equal(f.containers.has(archive),false);
 assert.equal(f.projected.at(-1),'legacy');
});
