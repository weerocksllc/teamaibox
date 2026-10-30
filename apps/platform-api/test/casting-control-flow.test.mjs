import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {TrustedMediaCastingRuntimeClient} from '../src/casting/trusted-media-runtime-client.mjs';

const SESSION='10000000-0000-4000-8000-000000000001';
const CERT=Buffer.from('-----BEGIN CERTIFICATE-----\n'+'A'.repeat(96));
// Ephemeral fixture only: do not store PEM-shaped credentials in source files.
const KEY=Buffer.from(generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}));
const health=()=>({status:200,body:{healthy:true,outputs:{browser:{healthy:true}}}});
const make=(request,timeoutMilliseconds=1000)=>new TrustedMediaCastingRuntimeClient({origin:'https://127.0.0.1:17443',serverName:'localhost',
  ca:CERT,cert:CERT,key:KEY,timeoutMilliseconds,transport:{request}});

test('nine overlapping readiness reads use one wire request, not nine media locks',async()=>{
  let calls=0;
  const client=make(async()=>{calls++;await sleep(25);return {status:200,body:{nodeId:SESSION,nodeGeneration:9,
    observedAt:new Date().toISOString(),outputs:{browser:{available:true,reasonCode:null}}}};});
  try{
    const results=await Promise.all(Array.from({length:9},()=>client.readiness({nodeId:SESSION,nodeGeneration:9})));
    assert.equal(calls,1);assert(results.every(r=>r.outputs.browser.available));
    await client.readiness({nodeId:SESSION,nodeGeneration:9});assert.equal(calls,2);
  }finally{client.close();}
});

test('different control calls are ordered, and shared read results are independent',async()=>{
  let active=0,peak=0;const paths=[];
  const client=make(async input=>{paths.push(input.path);peak=Math.max(peak,++active);await sleep(15);active--;return health();});
  try{
    const results=await Promise.all([client.health({sessionId:SESSION}),client.health({sessionId:SESSION}),
      client.health({sessionId:SESSION.replace(/1$/,'2')})]);
    assert.equal(paths.length,2);assert.equal(peak,1);
    results[0].outputs.browser.healthy=false;assert.equal(results[1].outputs.browser.healthy,true);
  }finally{client.close();}
});

test('mutation is a read barrier and is sent once between old and new observations',async()=>{
  let version=1;const calls=[];
  const client=make(async input=>{calls.push(input.method);await sleep(15);
    if(input.method==='DELETE'){version++;return {status:204,body:null};}
    return {status:200,body:{...health().body,version}};});
  try{
    const first=client.health({sessionId:SESSION});
    const stopped=client.stopReceiver({sessionId:SESSION,reasonCode:'cast_stopped_by_initiator'});
    const after=client.health({sessionId:SESSION});
    const [old,,fresh]=await Promise.all([first,stopped,after]);
    assert.equal(old.version,1);assert.equal(fresh.version,2);assert.deepEqual(calls,['GET','DELETE','GET']);
  }finally{client.close();}
});

test('a failed request does not poison the queue or retry a mutation',async()=>{
  const calls=[];const client=make(async input=>{calls.push(input.method);await sleep(10);
    if(input.method==='DELETE')return {status:503,body:{error:{code:'private_detail'}}};return health();});
  try{
    const failed=client.stopReceiver({sessionId:SESSION,reasonCode:'cast_stopped_by_initiator'});
    const check=client.health({sessionId:SESSION});
    await assert.rejects(failed,{code:'cast_media_runtime_unavailable'});assert.equal((await check).healthy,true);
    assert.deepEqual(calls,['DELETE','GET']);
  }finally{client.close();}
});

test('total deadline includes queue time and an expired queued request is never sent later',async()=>{
  const calls=[];
  const client=make(async input=>{calls.push(input.method);
    if(input.method==='DELETE'){await sleep(3100);return {status:204,body:null};}return health();},5000);
  try{
    const first=client.stopReceiver({sessionId:SESSION,reasonCode:'cast_stopped_by_initiator'});
    const expired=client.health({sessionId:SESSION});
    const results=await Promise.allSettled([first,expired]);
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
    assert.deepEqual(calls,['DELETE']);
    assert.equal((await client.health({sessionId:SESSION})).healthy,true);assert.deepEqual(calls,['DELETE','GET']);
  }finally{client.close();}
});

test('close aborts the active transport and prevents queued mutations',async()=>{
  let calls=0,signal;const client=make(async input=>{calls++;signal=input.signal;
    return new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));});
  const check=client.health({sessionId:SESSION});
  const stop=client.stopReceiver({sessionId:SESSION,reasonCode:'cast_stopped_by_initiator'});
  await sleep(10);client.close();
  const results=await Promise.allSettled([check,stop]);assert(results.every(r=>r.status==='rejected'));
  assert.equal(signal.aborted,true);assert.equal(calls,1);
});
