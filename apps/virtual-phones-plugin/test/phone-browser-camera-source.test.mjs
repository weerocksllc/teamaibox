import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneBrowserCameraSource} from '../src/public/phone-browser-camera-source.mjs';
import {createPhoneApi,normalizePhone} from '../src/public/phone-client.mjs';
const phone={id:'10000000-0000-4000-8000-000000000001',generation:3};
function fixture(){
  const calls=[],timers=new Set(),page=new EventTarget();let callbacks,capture,handler=null;
  class Capture{
    state='off';stream=null;
    constructor(options){callbacks=options;capture=this;}
    async start(id){this.id=id;this.state='connecting';this.stream={live:true};callbacks.onState('connecting');
      const answer=await callbacks.exchange({sourceId:id,offerSdp:'synthetic-offer',signal:new AbortController().signal});
      assert.equal(answer.sourceId,id);this.state='sending';callbacks.onState('sending');return {sourceId:id};}
    async stop(){this.state='off';this.stream=null;callbacks.onState('off');if(this.id)await callbacks.revoke({sourceId:this.id,signal:AbortSignal.timeout(100)});}
  }
  const errors=[];
  const json=async(path,options)=>{
    calls.push({path,...options});if(handler){const result=await handler(path,options);if(result!==undefined)return result;}
    if(path.endsWith('/heartbeat'))return {sourceId:options.body.sourceId,expiresInMilliseconds:4000};
    if(path.endsWith('/offer'))return {sourceId:options.body.sourceId,answerSdp:'synthetic-answer'};
    if(options.method==='POST')return {object:'virtual_phone.camera',phoneId:phone.id,generation:phone.generation,
      sourceId:options.body.requestId,sourceKind:'browser',state:'active'};
    return {state:'stopped'};
  };
  const source=new PhoneBrowserCameraSource({phone,json,Capture,page,onError:code=>errors.push(code),
    schedule:fn=>{timers.add(fn);return fn;},cancel:fn=>timers.delete(fn)});
  return {source,calls,timers,page,errors,get capture(){return capture;},get callbacks(){return callbacks;},
    handler(fn){handler=fn;},async tick(){const fn=timers.values().next().value;timers.delete(fn);fn?.();await new Promise(r=>setTimeout(r,0));}};
}
test('explicit source binds current phone, video-only metadata, one offer and non-overlapping short heartbeats',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);
  await f.source.start();assert.equal(f.source.state,'sending');assert.equal(f.calls.length,3);
  assert.deepEqual(f.calls[0].body,{expectedGeneration:3,requestId:f.source.sourceId,source:{kind:'browser',continueWithoutViewer:false}});
  assert.equal(f.calls[1].body.sourceId,f.source.sourceId);assert.equal(f.calls[2].body.offerSdp,'synthetic-offer');
  assert.equal(f.timers.size,1);await f.tick();assert.equal(f.timers.size,1);assert.equal(f.calls.length,4);
  const id=f.source.sourceId;const stop=f.source.stop();assert.equal(f.source.stream,null);assert.equal(f.timers.size,0);await stop;
  assert.equal(f.calls.at(-1).body.sourceId,id);assert.equal(f.calls.at(-1).method,'DELETE');
});
test('failed, expired or wrong-source heartbeat stops local capture without retrying permission',async()=>{
  for(const mode of ['network','expired','wrong']){
    const f=fixture();await f.source.start();f.handler((path)=>{if(path.endsWith('/heartbeat')){
      if(mode==='network')throw Error('private network message');return {sourceId:mode==='wrong'?phone.id:f.source.sourceId,expiresInMilliseconds:mode==='expired'?0:4000};}});
    await f.tick();assert.equal(f.source.stream,null);assert.equal(f.source.state,'off');assert.equal(f.timers.size,0);
    assert.deepEqual(f.errors,['camera_connection_lost']);assert.equal(f.calls.filter(c=>c.path.endsWith('/offer')).length,1);
  }
});
test('page exit, offline and permission withdrawal stop renewal and local tracks',async()=>{
  for(const event of ['pagehide','offline','permission']){
    const f=fixture();await f.source.start();if(event==='permission')void f.capture.stop();else f.page.dispatchEvent(new Event(event));
    assert.equal(f.source.stream,null);assert.equal(f.timers.size,0);assert.equal(f.source.sourceId,null);await f.source.dispose();
  }
});
test('aborted late open is revoked again without sending SDP or reviving renewal',async()=>{
  const f=fixture();let resolve;f.handler((path,options)=>{
    if(path.endsWith('/camera')&&options.method==='POST')return new Promise(r=>resolve=()=>r({phoneId:phone.id,generation:3,sourceId:options.body.requestId,sourceKind:'browser',state:'active'}));});
  const starting=f.source.start(),rejection=assert.rejects(starting);await f.source.stop();resolve();await rejection;
  assert.equal(f.source.stream,null);assert.equal(f.timers.size,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/offer')).length,0);
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,2);
});
test('phone list accepts only implemented camera source states without losing the source kind',()=>{
  const value={...phone,object:'virtual_phone',name:'Test',state:'running',revision:1,runningCharged:true};
  for(const sourceKind of ['image','browser','video','usb','udp']){
    for(const state of ['starting','active','stopping']){
      const cameraInput={state,generation:3,sourceId:phone.id,sourceKind};
      assert.deepEqual(normalizePhone({...value,cameraInput}).cameraInput,cameraInput);
    }
  }
  for(const sourceKind of ['other','',null])assert.throws(()=>normalizePhone({...value,cameraInput:{state:'active',generation:3,sourceId:phone.id,sourceKind}}));
});
test('refresh preserves the full phone list while USB and network camera inputs are active',async()=>{
  const data=['usb','udp'].map((sourceKind,i)=>({...phone,id:`10000000-0000-4000-8000-00000000000${i+1}`,
    object:'virtual_phone',name:sourceKind,state:'running',revision:1,runningCharged:true,
    cameraInput:{state:'active',generation:3,sourceId:phone.id,sourceKind}}));
  const api=createPhoneApi({fetchImpl:async()=>new Response(JSON.stringify({object:'list',data,
    quota:{stored:2,running:2,storedPerUser:null,runningPerUser:null}}),{headers:{'content-type':'application/json'}})});
  const result=await api.list();
  assert.deepEqual(result.data.map(p=>p.cameraInput.sourceKind),['usb','udp']);
  assert.equal(result.data.length,2);
});
