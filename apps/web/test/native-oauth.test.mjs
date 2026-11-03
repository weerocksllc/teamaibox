import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeNativeMcp,readNativeOAuthReturn} from '../src/assistant/native-oauth.ts';

function setup(t,{abort=false}={}) {
  const saved=new Map(['window','BroadcastChannel'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const[key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const lifetime=new AbortController(),state='a'.repeat(64),calls=[];
  let channel;const popup={closed:false,close(){this.closed=true;},location:{}};
  globalThis.window={location:{origin:'https://appliance.test'},open:()=>popup};
  globalThis.BroadcastChannel=class {constructor(name){this.name=name;channel=this;}close(){this.closed=true;}};
  Object.defineProperty(popup.location,'href',{set(url){
    assert.equal(new URL(url).searchParams.get('state'),state);
    if(abort){lifetime.abort();return;}
    channel.onmessage({data:{state:'b'.repeat(64),code:'wrong-flow'}});
    channel.onmessage({data:{state,code:'synthetic-code'}});
  }});
  const client={signal:lifetime.signal,request:async(path,options={})=>{
    calls.push({path,...options});
    if(path==='/global/config'&&!options.method)return {mcp:{demo:{type:'remote',url:'https://mcp.example.test',oauth:{scope:'demo'},enabled:true}},command:{other:{template:'retain'}}};
    if(path.endsWith('/auth'))return {authorizationUrl:`https://identity.example.test/authorize?state=${state}`,oauthState:state};
    if(path.endsWith('/callback'))return {status:'connected'};
    return {};
  }};
  return {client,calls,popup,get channel(){return channel;}};
}
test('native OAuth only forwards matching return state; unrelated config is never replaced',async t=>{
  const env=setup(t);await authorizeNativeMcp(env.client,'demo','/workspace/project');
  const patch=env.calls.find(item=>item.method==='PATCH');
  assert.deepEqual(Object.keys(patch.body),['mcp']);assert.equal(patch.body.mcp.demo.oauth.scope,'demo');
  assert.equal(patch.body.mcp.demo.oauth.redirectUri,'https://appliance.test/assistant/oauth/callback');
  const callbacks=env.calls.filter(item=>item.path.endsWith('/callback'));
  assert.equal(callbacks.length,1);assert.equal(callbacks[0].body.code,'synthetic-code');assert.equal(callbacks[0].directory,'/workspace/project');
  assert.equal(env.popup.closed,true);assert.equal(env.channel.closed,true);
});
test('sign-out prevents OAuth return from reaching any subsequent user',async t=>{
  const env=setup(t,{abort:true});await assert.rejects(authorizeNativeMcp(env.client,'demo','/workspace'),{name:'AbortError'});
  assert.equal(env.calls.some(item=>item.path.endsWith('/callback')),false);assert.equal(env.popup.closed,true);assert.equal(env.channel.closed,true);
});
test('callback accepts one native state and one code, never ambiguous query values',()=>{
  const base='https://appliance.test/assistant/oauth/callback?state='+'a'.repeat(64);
  assert.deepEqual(readNativeOAuthReturn(new URL(base+'&code=synthetic')),{state:'a'.repeat(64),code:'synthetic'});
  assert.equal(readNativeOAuthReturn(new URL(base+'&state='+'b'.repeat(64)+'&code=x')),null);
  assert.equal(readNativeOAuthReturn(new URL(base+'&code=x&code=y')),null);
  assert.equal(readNativeOAuthReturn(new URL(base)),null);
});
