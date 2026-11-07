import test from 'node:test';
import assert from 'node:assert/strict';
import {createPenpotNativeActivation} from '../src/penpot-native-activation.mjs';
import {penpotRuntimePaths as p} from '../src/penpot-runtime-config.mjs';

function fixture() {
  const f = {context: {schemaVersion:1, enabled:true}, busy:false, status:'disabled', calls:[],
    config:{plugin:[p.plugin], mcp:{other:{type:'remote',url:'https://example.invalid/mcp',enabled:false}},
      skills:{paths:['/workspace/skills']},model:'synthetic/model'}};
  f.transport={async request(method,target,options) {
    f.calls.push({method,target,body:options?.body});
    const path=new URL(target,'http://local').pathname;
    let result;
    if(path==='/config') result=structuredClone(f.config);
    else if(path==='/mcp' && method==='POST') {
      const body=JSON.parse(options.body); assert.equal(body.name,p.entry);
      assert.deepEqual(body.config,{type:'remote',url:p.endpoint,enabled:f.context.enabled,oauth:false});
      f.status=f.context.enabled?'connected':'disabled';result={[p.entry]:{status:f.status}};
    } else if(path==='/mcp') result={[p.entry]:{status:f.status}};
    else if(path==='/session/status') result={session:{type:f.busy?'busy':'idle'}};
    else if(path==='/api/session/active') result={data:{}};
    else if(['/pty','/permission','/question'].includes(path)) result=[];
    else throw Error('unexpected operation: '+path);
    return Response.json(result);
  }};
  f.activation=createPenpotNativeActivation({transport:f.transport,context:async()=>f.context,intervalMs:0});
  f.refresh=()=>f.activation.refresh('GET','/mcp?directory=%2Fworkspace%2Fdesign');
  return f;
}
test('native per-directory activation preserves user config and coalesces concurrent discovery',async()=>{
  const f=fixture(), before=structuredClone(f.config);
  assert.deepEqual(await Promise.all([f.refresh(),f.refresh()]),[{status:'ready'},{status:'ready'}]);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.ok(f.calls.every(c=>c.target.endsWith('?directory=%2Fworkspace%2Fdesign')));
  assert.deepEqual(f.config,before);
  assert.deepEqual(await f.refresh(),{status:'ready'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('busy sessions defer only activation; disable does not wait or dispose',async()=>{
  const f=fixture();f.busy=true;
  assert.deepEqual(await f.refresh(),{status:'waiting_for_idle'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  f.busy=false;assert.deepEqual(await f.refresh(),{status:'ready'});
  f.busy=true;const before=f.calls.length;
  assert.deepEqual(await f.refresh(),{status:'ready'});
  assert.ok(f.calls.slice(before).every(c=>!c.target.startsWith('/session/status')));
  f.busy=true;f.context={schemaVersion:1,enabled:false};
  assert.deepEqual(await f.refresh(),{status:'disabled'});
  f.busy=false;f.context={schemaVersion:1,enabled:true};
  assert.deepEqual(await f.refresh(),{status:'ready'});
  assert.ok(f.calls.every(c=>c.method!=='POST'||c.target.startsWith('/mcp?')));
});
test('legacy instances and conflicting reserved user configuration are never overwritten',async()=>{
  const f=fixture();f.config.plugin=[];
  assert.deepEqual(await f.refresh(),{status:'restart_required'});
  f.config.mcp[p.entry]={type:'remote',url:'https://example.invalid/custom'};
  assert.deepEqual(await f.refresh(),{status:'configuration_conflict'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('invalid path and changed operator intent cannot cause an activation',async()=>{
  const f=fixture();assert.throws(()=>f.activation.refresh('GET','/mcp?directory=/etc'));
  let count=0;
  const activation=createPenpotNativeActivation({transport:f.transport,context:async()=>({schemaVersion:1,enabled:++count===1})});
  assert.deepEqual(await activation.refresh('GET','/mcp'),{status:'configuration_changed'});
  assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('optional native failure is isolated and bounded; no retry of writes',async()=>{
  let calls=0;const errors=[];
  const a=createPenpotNativeActivation({transport:{request:async()=>{calls++;throw Error('secret');}},
    context:async()=>({schemaVersion:1,enabled:true}),onUnavailable:code=>errors.push(code)});
  assert.deepEqual(await a.refresh('GET','/mcp'),{status:'unavailable'});
  assert.deepEqual(await a.refresh('GET','/mcp'),{status:'unavailable'});
  assert.equal(calls,1);assert.deepEqual(errors,['penpot_native_activation_unavailable']);
});
