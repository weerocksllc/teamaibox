import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPenpotEditorHost} from '../../../apps/platform-api/src/design/penpot-editor-host.mjs';
import {PenpotConnectionAuthority} from '../src/penpot-connection-authority.mjs';
import {PenpotMcpHttpApi} from '../../../apps/platform-api/src/design/penpot-mcp-http-api.mjs';

const fileId='11111111-1111-4111-8111-111111111111';
const pageId='22222222-2222-4222-8222-222222222222';
const connectionId='33333333-3333-4333-8333-333333333333';
const response=body=>({ok:true,status:200,json:async()=>body});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const listeners=new Map(),states=[],calls=[];
  let plugin,loads=0,unloads=0;
  const selected={fileId,pageId,connectionId,generation:5,sessionID:'ses_example'};
  const host={parent:{postMessage:value=>states.push(value)},
    location:{origin:'https://design.example',hash:`#/workspace?file-id=${fileId}&page-id=${pageId}`},
    navigator:{onLine:true},document:{cookie:'__Host-teamaibox-csrf=synthetic'},
    addEventListener:(name,listener)=>listeners.set(name,listener),
    removeEventListener:(name,listener)=>{if(listeners.get(name)===listener)listeners.delete(name);},
    fetch:async(url,options)=>{const action=url.split('/').at(-1),body=JSON.parse(options.body);calls.push({action,body});
      return response(action==='select'||action==='heartbeat'?selected:action==='current'?{generation:4,connected:true}:{});},
    ɵloadPlugin:async(_manifest,_closed,options)=>{loads++;plugin=options;options.mcp.setMcpStatus('connected');},
    ɵunloadPlugin:()=>{unloads++;},
  };
  const cleanup=mountPenpotEditorHost(host);
  const send=async(action,extra={},source=host.parent,origin=host.location.origin)=>{await tick();return listeners.get('message')?.({source,origin,data:{type:'teamaibox.design.command/v1',requestId:'request_example',action,...extra}});};
  return {host,states,calls,listeners,selected,cleanup,send,get plugin(){return plugin;},get loads(){return loads;},get unloads(){return unloads;}};
}

test('host requires explicit selection; foreign messages and stored selection never attach',async t=>{
  const f=fixture();t.after(f.cleanup);
  await f.send('status');assert.equal(f.states.at(-1).generation,4);assert.equal(f.loads,0);
  await f.send('connect',{sessionID:'ses_example',expectedGeneration:4},{},f.host.location.origin);
  await f.send('connect',{sessionID:'ses_example',expectedGeneration:4},f.host.parent,'https://other.example');
  assert.equal(f.loads,0);
  await f.send('connect',{sessionID:'ses_example',expectedGeneration:4});assert.equal(f.loads,1);
  assert.equal(f.states.at(-1).state,'connected');assert.equal(f.plugin.mcp.getToken(),undefined);
  assert.equal(f.plugin.mcp.getServerUrl(),`wss://design.example/api/v1/design/editor/ws/mcp/${connectionId}`);
  assert.equal(f.plugin.teamaiboxDesign.current().fileId,fileId);
  await f.send('disconnect');assert.equal(f.states.at(-1).state,'disconnected');
  assert.equal(f.plugin.teamaiboxDesign.current(),undefined);await tick();
  assert.ok(f.calls.some(c=>c.action==='disconnect'&&c.body.generation===5));
  await f.send('status');assert.equal(f.loads,1);
});

test('target or session cancellation while select is pending cannot attach the stale result',async t=>{
  const f=fixture();t.after(f.cleanup);const original=f.host.fetch;
  let resolve;
  f.host.fetch=(url,options)=>url.endsWith('/select')?new Promise(done=>{resolve=done;}):original(url,options);
  const pending=f.send('connect',{sessionID:'ses_example',expectedGeneration:4});
  await tick();
  assert.equal(f.states.at(-1).state,'connecting');
  await f.send('disconnect');resolve(response(f.selected));await pending;await tick();
  assert.equal(f.loads,0);assert.equal(f.states.at(-1).state,'disconnected');
  assert.ok(f.calls.some(c=>c.action==='disconnect'&&c.body.connectionId===connectionId));
});

test('late-loaded host observes the current generation without requiring a parent refresh',async t=>{
 const f=fixture();t.after(f.cleanup);assert.equal(f.states[0].selectable,false);
 await tick();assert.equal(f.states.at(-1).selectable,true);assert.equal(f.states.at(-1).generation,4);assert.equal(f.loads,0);
 await f.send('connect',{sessionID:'ses_example',expectedGeneration:4});assert.equal(f.states.at(-1).state,'connected');
});

test('legacy runtime selection reports upgrade required without loading a plugin or replaying selection',async t=>{
 const f=fixture();t.after(f.cleanup);const original=f.host.fetch;
 f.host.fetch=(url,options)=>url.endsWith('/select')?Promise.resolve(Response.json({error:{code:'penpot_agent_upgrade_required'}},{status:409})):original(url,options);
 await f.send('connect',{sessionID:'ses_example',expectedGeneration:4});
 assert.equal(f.states.at(-1).state,'disconnected');assert.equal(f.states.at(-1).reason,'upgrade_required');
 assert.equal(f.loads,0);assert.equal(f.plugin,undefined);
});

test('upgrade notice is restricted to an authenticated editor selecting its own legacy runtime',async t=>{
 const identityId='44444444-4444-4444-8444-444444444444';let allowed=true,ownerIdentityId=identityId;
 const denied=()=>{throw Error('not authenticated');};const unexpected=()=>assert.fail('legacy selection cannot read or change a design');
 const connections=new PenpotConnectionAuthority({repository:{get:unexpected,select:unexpected},
   platform:{loadSession:unexpected,authenticateNativeSession:async()=>allowed?{identityId}:denied(),validateNativeBinding:unexpected},
   nativePermissions:{check:unexpected},routes:{resolve:async()=>({ownerIdentityId,sandboxKey:'sandbox.'+'a'.repeat(32),designRuntime:null,designRuntimeStatus:'upgrade_required'})}});
 const api=new PenpotMcpHttpApi({connections,proofs:{issue:unexpected},dispatches:{consume:unexpected},serviceKey:'b'.repeat(43)});t.after(()=>api.close());
 const input={pathname:'/api/v1/design/editor/_integration/select',context:{identityId},nativeToken:'synthetic',body:{sessionID:'ses_example',fileId,pageId,expectedGeneration:0}};
 await assert.rejects(api.handle(input),{code:'penpot_agent_upgrade_required',status:409});
 ownerIdentityId='55555555-5555-4555-8555-555555555555';await assert.rejects(api.handle(input),{code:'penpot_call_denied',status:403});
 ownerIdentityId=identityId;allowed=false;await assert.rejects(api.handle(input),{code:'penpot_call_denied',status:403});
});

test('offline, target changes and disposal invalidate authority; returning online never retries a write',async t=>{
  const f=fixture();t.after(f.cleanup);
  await f.send('connect',{sessionID:'ses_example',expectedGeneration:4});
  const authority=f.plugin.teamaiboxDesign;
  f.host.navigator.onLine=false;f.listeners.get('offline')();
  assert.equal(authority.current(),undefined);
  await assert.rejects(authority.authorize('request','execute_code',{code:'synthetic'},'ticket'));
  f.host.navigator.onLine=true;await tick();assert.equal(f.loads,1);
  assert.equal(f.calls.filter(c=>c.action==='claim').length,0);
  await f.send('connect',{sessionID:'ses_example',expectedGeneration:5});
  f.host.location.hash=`#/workspace?file-id=${fileId}&page-id=44444444-4444-4444-8444-444444444444`;
  assert.equal(f.plugin.teamaiboxDesign.current(),undefined);f.listeners.get('hashchange')();
  assert.equal(f.states.at(-1).state,'disconnected');f.cleanup();assert.equal(f.listeners.size,0);
});

test('a pending claim cannot authorize execution after the target was disconnected',async t=>{
  const f=fixture();t.after(f.cleanup);await f.send('connect',{sessionID:'ses_example',expectedGeneration:4});
  let resolve;const original=f.host.fetch;
  f.host.fetch=(url,options)=>url.endsWith('/claim')?new Promise(done=>{resolve=done;}):original(url,options);
  const pending=f.plugin.teamaiboxDesign.authorize('request','execute_code',{code:'synthetic'},'ticket');
  await f.send('disconnect');resolve(response({allowed:true}));await assert.rejects(pending,/target changed/);
});

test('a plugin that loads but never opens its socket releases the binding without a retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();t.after(f.cleanup);let plugin,attempts=0;
  f.host.ɵloadPlugin=async(_manifest,_closed,options)=>{attempts++;plugin=options;};
  const opening=f.send('connect',{sessionID:'ses_example',expectedGeneration:4});
  await tick();assert.equal(f.states.at(-1).state,'connecting');
  t.mock.timers.tick(12000);
  await opening;await tick();
  assert.equal(f.states.at(-1).state,'disconnected');assert.equal(f.states.at(-1).reason,'reopen');
  assert.equal(plugin.teamaiboxDesign.current(),undefined);
  plugin.mcp.setMcpStatus('connected');
  assert.equal(f.states.at(-1).state,'disconnected');assert.equal(attempts,1);
  assert.ok(f.calls.some(c=>c.action==='disconnect'&&c.body.connectionId===connectionId));
  assert.equal(f.calls.filter(c=>c.action==='claim').length,0);
});
