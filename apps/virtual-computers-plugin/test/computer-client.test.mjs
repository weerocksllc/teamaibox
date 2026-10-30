import test from 'node:test';
import assert from 'node:assert/strict';
import {createComputerApi,computerActions} from '../src/public/computer-client.mjs';
const cookie=()=>'__Host-teamaibox-csrf=csrf-token';
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});

test('an uncertain create response is retried with the same key and original body',async()=>{
  const calls=[];let n=0;
  const api=createComputerApi({cookie,uuid:()=>`request-${++n}`,fetcher:async(url,options)=>{
    calls.push({url,...options});if(calls.length===1)throw Error('connection lost');return response({id:'original-operation'},202);
  }});
  const input={name:'Work',resources:{memoryGiB:8}};
  await assert.rejects(api.mutate('','POST',input),e=>e.uncertain===true);
  input.name='Different';assert.equal(api.hasPending(),true);
  await assert.rejects(api.mutate('','POST',input),{code:'computer_request_pending'});
  assert.deepEqual(await api.retry(),{id:'original-operation'});
  assert.equal(calls[0].headers['idempotency-key'],calls[1].headers['idempotency-key']);
  assert.equal(calls[0].body,calls[1].body);assert.equal(n,1);assert.equal(api.hasPending(),false);
  assert.equal(calls[0].headers['x-csrf-token'],'csrf-token');assert.equal(calls[0].credentials,'same-origin');
});
test('permission/capacity errors permit a new request, while malformed and server responses remain uncertain',async()=>{
  for(const status of [403,409,503]){
    const api=createComputerApi({cookie,uuid:()=> 'request-key',fetcher:async()=>response({error:{code:'test-error'}},status)});
    await assert.rejects(api.mutate('/id/start','POST',{expectedRevision:1}),{code:'test-error'});
    assert.equal(api.hasPending(),status>=500);
  }
  const api=createComputerApi({cookie,uuid:()=> 'request-key',fetcher:async()=>({ok:true,status:202,json:async()=>{throw Error('truncated');}})});
  await assert.rejects(api.mutate('','POST',{}),e=>e.uncertain===true);assert.equal(api.hasPending(),true);
});
test('missing or duplicate platform CSRF cookies never send a mutation',async()=>{
  for(const value of ['','__Host-teamaibox-csrf=','__Host-teamaibox-csrf=a; __Host-teamaibox-csrf=b']) {
    let sent=false;const api=createComputerApi({cookie:()=>value,uuid:()=> 'request-key',fetcher:async()=>{sent=true;}});
    await assert.rejects(api.mutate('','POST',{}),{code:'invalid_session'});assert.equal(sent,false);assert.equal(api.hasPending(),false);
  }
});
test('running guests offer desktop and graceful shutdown, not destructive actions',()=>{
  assert.deepEqual(computerActions({state:'running'}),['open','shutdown']);
  assert.deepEqual(computerActions({state:'stopped'}),['open','start','delete']);
  assert.deepEqual(computerActions({state:'stopping'}),['open','refresh']);
  assert.deepEqual(computerActions({state:'starting'}),['open','refresh']);
  for(const state of ['unavailable','error'])assert.deepEqual(computerActions({state}),['refresh']);
});
