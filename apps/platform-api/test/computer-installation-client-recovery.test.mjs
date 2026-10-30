import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerApi } from '../../virtual-computers-plugin/src/public/computer-client.mjs';

test('lost create response survives page reload and reuses original idempotency key',async()=>{
  const values=new Map(), storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const seen=[],body={name:'Temporary installation fixture',profileId:'linux-arm64',resources:{vcpus:2,memoryGiB:4,diskGiB:32}};
  const first=createComputerApi({cookie:()=> '__Host-teamaibox-csrf=fixture',uuid:()=> 'same-request-key',fetcher:async(path,request)=>{seen.push(request);throw Error('lost reply');}});
  first.useJournal(storage,'owner-fixture');
  await assert.rejects(first.mutate('','POST',body),{code:'computer_network_unavailable'});
  assert.equal(first.hasPending(),true);
  const second=createComputerApi({cookie:()=> '__Host-teamaibox-csrf=new-session',fetcher:async(path,request)=>{seen.push(request);return {ok:true,json:async()=>({id:'original-operation'})};}});
  second.useJournal(storage,'owner-fixture');assert.equal(second.hasPending(),true);
  assert.deepEqual(await second.retry(),{id:'original-operation'});
  assert.equal(seen[0].headers['idempotency-key'],seen[1].headers['idempotency-key']);
  assert.equal(seen[0].body,seen[1].body);assert.equal(seen[1].headers['x-csrf-token'],'new-session');
  assert.equal(values.size,0);assert.equal(second.hasPending(),false);
});
