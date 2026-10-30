import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DurableComputeBackend} from '../src/compute/durable-job-service.mjs';

const work={ownerIdentityId:'owner',operation:'chat.completions',request:{stream:true,stream_options:{include_usage:true}}};
const result={id:'chat_test',object:'chat.completion',created:123,model:'local/test',choices:[
  {index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'write',arguments:'{"file":"test"}'}}]},finish_reason:'tool_calls'},
],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
function fixture({status='succeeded',execute}={}) {
  const job={jobId:'job',ownerIdentityId:'owner',status,result:structuredClone(result)};
  let executions=0,reads=0;
  const backend=new DurableComputeBackend({jobService:{
    async submit(){return {...job};}, async get(input){assert.deepEqual(input,{jobId:'job',ownerIdentityId:'owner'});reads++;return {...job};}, async cancel(){},
  },execution:{async awaitResult(){throw Error('unexpected buffered execution');},async streamResult(){executions++;return execute(job);}},
  realtimeAdmission:{async admit(){},async connect(){},async heartbeat(){},async disconnect(){}}});
  return {backend,job,counts:()=>({executions,reads})};
}
async function collect(backend,input=work){const out=[];for await(const item of await backend.stream(input))out.push(item.data);return out;}

test('completed queued chat is replayed as SSE without a second model execution',async()=>{
  const f=fixture();const chunks=await collect(f.backend);
  assert.deepEqual(f.counts(),{executions:0,reads:1});
  assert(chunks.every(c=>c.object==='chat.completion.chunk'&&c.id===result.id&&c.model===result.model));
  assert.deepEqual(chunks[0].choices[0].delta.tool_calls,[{index:0,...result.choices[0].message.tool_calls[0]}]);
  assert.equal(chunks[0].choices[0].finish_reason,null);
  assert.equal(chunks[1].choices[0].finish_reason,'tool_calls');
  assert.deepEqual(chunks[2].choices,[]);assert.deepEqual(chunks[2].usage,result.usage);
  assert.deepEqual(f.job.result,result);
});
test('replayed text and multiple choices preserve content and omit unrequested usage',async()=>{
  const f=fixture();f.job.result.choices=[{index:0,message:{role:'assistant',content:'Done'},finish_reason:'stop'},
    {index:1,message:{role:'assistant',content:'Alternative'},finish_reason:'length'}];
  const chunks=await collect(f.backend,{...work,request:{stream:true}});
  assert.equal(chunks.length,2);assert.deepEqual(chunks[0].choices.map(c=>c.delta.content),['Done','Alternative']);
  assert.deepEqual(chunks[1].choices.map(c=>c.finish_reason),['stop','length']);
  assert(chunks.every(c=>c.usage===undefined));
});
test('completion racing stream preparation reads the durable result instead of re-executing',async()=>{
  const f=fixture({status:'queued',execute:job=>(async function*(){job.status='succeeded';throw Object.assign(Error('already complete'),{code:'job_not_dispatchable'});})()});
  assert.equal((await collect(f.backend))[1].choices[0].finish_reason,'tool_calls');assert.equal(f.counts().executions,1);
});
test('an active or failed job is not misrepresented as completed',async()=>{
  for(const status of ['running','failed','cancelled']){
    const error=Object.assign(Error('unavailable'),{code:'job_execution_in_progress'});
    const f=fixture({status,execute:()=>{throw error;}});
    await assert.rejects(collect(f.backend),e=>e===error);
  }
});
test('an already observed partial stream must not append a replayed whole response',async()=>{
  const error=Object.assign(Error('lost stream'),{code:'job_not_dispatchable'});
  const f=fixture({status:'queued',execute:job=>(async function*(){yield {data:{partial:true}};job.status='succeeded';throw error;})()});
  await assert.rejects(collect(f.backend),e=>e===error);assert.equal(f.counts().reads,0);
});
test('invalid or incompatible persisted results fail without model re-execution',async()=>{
  const f=fixture();f.job.result.object='response';
  await assert.rejects(collect(f.backend),{code:'compute_stream_replay_unavailable'});assert.equal(f.counts().executions,0);
});
