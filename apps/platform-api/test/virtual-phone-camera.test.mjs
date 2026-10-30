import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PhoneCameraService} from '../src/virtual-phones/phone-camera-service.mjs';
import {cameraStartInput,cameraGrant} from '../src/virtual-phones/phone-camera-contracts.mjs';

// Domain-only fixtures, not Android or deployed member acceptance.
function fixture(){
  const ownerId=randomUUID(),phoneId=randomUUID(),sessionId=randomUUID(),runId=randomUUID();
  const context={identityId:ownerId,sessionId},selected={ownerId,phoneId,sessionId,runId,generation:1,cameraCapability:'verified'};
  const input={expectedGeneration:1,requestId:randomUUID(),source:{kind:'image',continueWithoutViewer:true,
    file:{objectId:randomUUID(),objectVersion:1,name:'source.png',sizeBytes:5,sha256:'a'.repeat(64)}}};
  let value=null,allowed=true,live=true;const events=[];
  const copy=()=>value&&structuredClone({...value,authorized:live&&value.runId===selected.runId&&value.state!=='stopping'});
  const repository={
    async listStates({ownerId:owner,phones}){assert.equal(owner,ownerId);return phones.filter(p=>p.id===phoneId&&p.generation===1&&value&&value.state!=='stopped').map(p=>({phoneId:p.id,generation:p.generation,sourceId:value.sourceId,sourceKind:'image',state:live?value.state:'stopping'}));},
    async assertSelected(args){if(args.ownerId!==ownerId||args.phoneId!==phoneId)throw Object.assign(Error(),{code:'phone_not_found'});
      if(!live||args.sessionId!==sessionId)throw Object.assign(Error(),{code:'phone_grant_invalid'});
      if(args.generation!==selected.generation)throw Object.assign(Error(),{code:'phone_stale_run'});return {...selected};},
    async reserve(args){if(value){if(value.sourceId===args.sourceId){if(value.fingerprint!==args.fingerprint)throw Object.assign(Error(),{code:'phone_idempotency_conflict'});return {...copy(),created:false};}
        if(value.state!=='stopped')throw Object.assign(Error(),{code:'phone_operation_conflict'});}
      value={...args,id:randomUUID(),state:'starting'};return {...copy(),created:true};},
    async activate(v){if(value?.id!==v.id||value.state!=='starting')throw Object.assign(Error(),{code:'phone_camera_source_stopped'});value.state='active';return copy();},
    async current(){return value?.state!=='stopped'?copy():null;},async get(){return copy();},async active(){return value&&value.state!=='stopped'?[copy()]:[];},
    async beginStop(args){if(!value||value.state==='stopped'||args.id&&args.id!==value.id||args.runId&&args.runId!==value.runId||args.sessionId&&args.sessionId!==sessionId)return [];
      value.state='stopping';return [copy()];},async confirmStopped(){value.state='stopped';events.push('confirmed');},
  };
  const reply=(grant,state,extra={})=>({...grant,state,resourceScope:'phone-run',...extra});
  const runtime={maximumLeaseMilliseconds:5000,resourceScope:'phone-run',
    async capabilities(){return {image:true};},
    async open({grant,leaseExpiresAt}){events.push('open');return reply(grant,'waiting',{leaseExpiresAt});},
    async image({grant,chunks,signal}){for await(const chunk of chunks){assert.equal(chunk.toString(),'image');signal.throwIfAborted();}events.push('image');return reply(grant,'receiving');},
    async renew({grant,leaseExpiresAt}){events.push('renew');return reply(grant,'receiving',{leaseExpiresAt});},
    async close({grant}){events.push('close');return reply(grant,'stopped',{retainedFrameBytes:0});},
    async status({grant}){return reply(grant,'receiving');},
  };
  const objects={async withInput({ownerId:owner,input:file,signal},consume){assert.equal(owner,ownerId);assert.deepEqual(file,input.source.file);
    signal.throwIfAborted();events.push('read');return consume({metadata:file,chunks:(async function*(){yield Buffer.from('image');})()});}};
  const directory={async authorization(){return {permissions:allowed?['phone:use']:['phone:manage']};}};
  const dependencies={repository,directory,objectTransfer:objects,runtime};
  return {service:new PhoneCameraService(dependencies),dependencies,repository,runtime,objects,context,phoneId,input,events,selected,
    value:()=>copy(),allowed:x=>allowed=x,live:x=>live=x,start(){return this.service.start({context,phoneId,input});}};
}
test('USB input uses the explicit adapter and policy before opening; never reads objects or auto-resumes',async()=>{
  const f=fixture();f.input.source={kind:'usb',deviceId:randomUUID(),attachmentId:'b'.repeat(64),continueWithoutViewer:true};
  f.runtime.capabilities=async()=>({image:true,usb:true});
  const usbService={async devices(){},async administration(){},async configure(){},async select(selected,source){
    assert.equal(selected.runId,f.selected.runId);assert.deepEqual(source,f.input.source);f.events.push('select');}};
  f.runtime.usb=async({grant,source,signal})=>{assert.deepEqual(source,f.input.source);signal.throwIfAborted();f.events.push('usb');return {...grant,state:'receiving',resourceScope:'phone-run'};};
  await assert.rejects(f.start(),{code:'phone_camera_unavailable'});assert.deepEqual(f.events,[]);
  f.service=new PhoneCameraService({...f.dependencies,usbService});await f.start();assert.deepEqual(f.events,['select','open','usb']);
  await f.service.reconcile();assert.equal(f.events.at(-1),'renew');
  await new PhoneCameraService({...f.dependencies,usbService}).reconcile();assert.equal(f.value().state,'stopped');
  assert.deepEqual(f.events.slice(-2),['close','confirmed']);assert.equal(f.events.includes('read'),false);
});
test('USB device-change, authorization rejection and failed physical start never stay active',async()=>{
  for(const stage of ['select','runtime']){
    const f=fixture();f.input.source={kind:'usb',deviceId:randomUUID(),attachmentId:'c'.repeat(64),continueWithoutViewer:true};
    f.runtime.capabilities=async()=>({image:true,usb:true});f.runtime.usb=async()=>{throw Error('phone_camera_usb_busy');};
    const usbService={async devices(){},async administration(){},async configure(){},async select(){if(stage==='select')throw Error('phone_camera_usb_device_changed');}};
    f.service=new PhoneCameraService({...f.dependencies,usbService});await assert.rejects(f.start());
    if(stage==='select')assert.deepEqual(f.events,[]);else{assert.equal(f.value().state,'stopped');assert.deepEqual(f.events,['open','close','confirmed']);}
  }
});
test('network camera waits for sender without object access, validates policy and stops on lost ownership',async()=>{
  const f=fixture(),policy={listenAddress:'10.64.0.19',listenPort:24100,allowedSources:['10.64.0.0/24']};
  f.input.source={kind:'udp',policyId:randomUUID(),policyRevision:1,continueWithoutViewer:true};
  f.runtime.capabilities=async()=>({udp:true,image:true});
  const reserve=f.repository.reserve;f.repository.reserve=async args=>({...await reserve(args),udpPolicy:policy,udpPolicyRevision:1});
  f.runtime.udp=async({grant,policy:p})=>{assert.deepEqual(p,policy);f.events.push('udp');return {...grant,state:'waiting',resourceScope:'phone-run'};};
  const udpService={async sources(){},async administration(){},async configure(){},async select(selected,source){assert.equal(selected.runId,f.selected.runId);assert.deepEqual(source,f.input.source);f.events.push('select');}};
  await assert.rejects(f.start(),{code:'phone_camera_unavailable'});assert.deepEqual(f.events,[]);
  f.service=new PhoneCameraService({...f.dependencies,udpService});await f.start();assert.deepEqual(f.events,['select','open','udp']);
  f.runtime.status=async({grant})=>({...grant,state:'waiting',resourceScope:'phone-run'});
  assert.equal((await f.service.status({context:f.context,phoneId:f.phoneId,generation:1})).inputState,'waiting');
  f.live(false);await f.service.reconcile();assert.equal(f.value().state,'stopped');assert.equal(f.events.includes('read'),false);
});
test('camera defaults off; explicit image input has exact ownership, idempotency and separate stop',async()=>{
  const f=fixture();assert.equal((await f.service.status({context:f.context,phoneId:f.phoneId,generation:1})).state,'stopped');assert.deepEqual(f.events,[]);
  const result=await f.start();assert.equal(result.state,'active');assert.equal(result.resourceScope,'phone-run');
  assert.equal(JSON.stringify(result).includes(f.input.source.file.objectId),false);assert.equal(JSON.stringify(result).includes(f.context.sessionId),false);
  await f.start();assert.deepEqual(f.events,['open','read','image']);
  await f.service.reconcile();assert.equal(f.events.at(-1),'renew');
  await f.service.stop({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId}});
  assert.deepEqual(f.events.slice(-2),['close','confirmed']);assert.equal(f.value().state,'stopped');
});
test('list input state is owner-scoped metadata, with no image, viewer, or runtime polling',async()=>{
  const f=fixture(),phones=[{id:f.phoneId,generation:1}];
  assert.deepEqual(await f.service.listStates({context:f.context,phones}),[]);
  await f.start();const before=f.events.length;
  assert.deepEqual(await f.service.listStates({context:f.context,phones}),[{phoneId:f.phoneId,generation:1,sourceId:f.input.requestId,sourceKind:'image',state:'active'}]);
  assert.equal(f.events.length,before);
  assert.deepEqual(await f.service.listStates({context:f.context,phones:[{id:f.phoneId,generation:2}]}),[]);
  f.allowed(false);await assert.rejects(f.service.listStates({context:f.context,phones}),{code:'phone_permission_required'});
});
test('foreign owner, manager-only, old run, missing session and unadapted ROM cannot read source bytes',async()=>{
  for(const mode of ['owner','manage','generation','session','rom','adapter']){
    const f=fixture(),context={...f.context},input=structuredClone(f.input);
    if(mode==='owner')context.identityId=randomUUID();if(mode==='manage')f.allowed(false);
    if(mode==='generation')input.expectedGeneration=2;if(mode==='session')context.sessionId=randomUUID();
    if(mode==='rom')f.selected.cameraCapability='unavailable';if(mode==='adapter')f.runtime.capabilities=async()=>({image:false});
    await assert.rejects(f.service.start({context,phoneId:f.phoneId,input}));assert.deepEqual(f.events,[]);
  }
});
test('source contract rejects implicit capture, URLs, host paths, spoofed owner and oversized objects',()=>{
  const f=fixture();
  for(const change of [x=>x.source.kind='browser',x=>x.source.continueWithoutViewer=false,x=>x.source.url='http://node/camera',
    x=>x.source.file.name='../a.png',x=>x.ownerId=randomUUID(),x=>x.source.file.sizeBytes=Number.MAX_SAFE_INTEGER+1]){
    const input=structuredClone(f.input);change(input);assert.throws(()=>cameraStartInput(input));
  }
});
test('new source conflicts until stop confirmed, and retries with changed content are rejected',async()=>{
  const f=fixture();await f.start();
  await assert.rejects(f.service.start({context:f.context,phoneId:f.phoneId,input:{...f.input,requestId:randomUUID()}}),{code:'phone_operation_conflict'});
  await assert.rejects(f.service.start({context:f.context,phoneId:f.phoneId,input:{...f.input,source:{...f.input.source,file:{...f.input.source.file,objectVersion:2}}}}),{code:'phone_idempotency_conflict'});
  const close=f.runtime.close;f.runtime.close=async()=>{throw Error('node offline');};
  await assert.rejects(f.service.stop({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId}}));assert.equal(f.value().state,'stopping');
  f.runtime.close=close;await f.service.reconcile();assert.equal(f.value().state,'stopped');
});
test('logout, disabled permission and changed run actually close; no automatic source recovery',async()=>{
  for(const mode of ['logout','permission','run','process']){
    const f=fixture();await f.start();if(mode==='logout')f.live(false);if(mode==='permission')f.allowed(false);if(mode==='run')f.selected.runId=randomUUID();
    await (mode==='process'?new PhoneCameraService(f.dependencies):f.service).reconcile();
    assert.equal(f.value().state,'stopped');assert.deepEqual(f.events.slice(-2),['close','confirmed']);
  }
});
test('failed/ambiguous open, incorrect acknowledgement and failed object read revoke only that source',async()=>{
  for(const mode of ['open','reply','object','image']){
    const f=fixture();if(mode==='open')f.runtime.open=async()=>{throw Error('timeout');};
    if(mode==='reply')f.runtime.open=async({grant,leaseExpiresAt})=>({...grant,ownerId:randomUUID(),state:'waiting',resourceScope:'phone-run',leaseExpiresAt});
    if(mode==='object')f.objects.withInput=async()=>{throw Error('object denied');};
    if(mode==='image')f.runtime.image=async()=>{throw Error('decoder error');};
    await assert.rejects(f.start());assert.equal(f.value().state,'stopped');assert.deepEqual(f.events.slice(-2),['close','confirmed']);
  }
});
test('stop during source preparation aborts the transfer; late success cannot become active',async()=>{
  const f=fixture();let ready;const entered=new Promise(r=>ready=r);
  f.runtime.image=async({grant,signal})=>{ready();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
  const starting=f.start(),rejected=assert.rejects(starting);await entered;
  await f.service.stop({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId}});await rejected;
  assert.equal(f.value().state,'stopped');
});
test('renewal failure releases input, and remaining private bytes never count as a successful stop',async()=>{
  const f=fixture();await f.start();f.runtime.renew=async()=>{throw Error('transport died');};
  await assert.rejects(f.service.reconcile());assert.equal(f.value().state,'stopped');
  const g=fixture();await g.start();g.runtime.close=async({grant})=>({...grant,state:'stopped',resourceScope:'phone-run',retainedFrameBytes:1});
  await assert.rejects(g.service.stop({context:g.context,phoneId:g.phoneId,input:{expectedGeneration:1,sourceId:g.input.requestId}}),{code:'phone_camera_runtime_unavailable'});
  assert.equal(g.value().state,'stopping');
});
test('source expiry observed by status is reported stopped, not as live input',async()=>{
  const f=fixture();await f.start();f.runtime.status=async({grant})=>({...grant,state:'stopped',resourceScope:'phone-run'});
  assert.equal((await f.service.status({context:f.context,phoneId:f.phoneId,generation:1})).state,'stopped');assert.equal(f.value().state,'stopped');
});
test('a failed source does not starve another phone renewal or close its media',async t=>{
  const a=fixture(),b=fixture(),fixtures=[a,b];
  const choose=value=>fixtures.find(f=>f.phoneId===value.phoneId||f.value()?.id===value.id);
  const repository={...a.repository,
    async active(){return fixtures.map(f=>f.value()).filter(Boolean);},
    async get(id){return fixtures.find(f=>f.value()?.id===id).repository.get(id);},
  };
  for(const name of ['assertSelected','reserve','activate','current','beginStop','confirmStopped'])repository[name]=v=>choose(v).repository[name](v);
  const runtime={...a.runtime};for(const name of ['open','image','renew','close','status'])runtime[name]=v=>choose(v.grant).runtime[name](v);
  const objects={withInput:(v,consume)=>fixtures.find(f=>f.context.identityId===v.ownerId).objects.withInput(v,consume)};
  const service=new PhoneCameraService({repository,runtime,objectTransfer:objects,directory:a.dependencies.directory});
  for(const f of fixtures)await service.start({context:f.context,phoneId:f.phoneId,input:f.input});
  a.runtime.renew=async()=>{throw Error('source unavailable');};
  a.runtime.close=async()=>{throw Error('close unavailable');};
  await assert.rejects(service.reconcile());
  assert.equal(a.value().state,'stopping');assert.equal(b.value().state,'active');assert.equal(b.events.at(-1),'renew');
  assert.equal(b.events.includes('close'),false);
  // A slow cleanup must not hold the global renewal loop until another
  // healthy phone's four-second lease expires. Keep the first close pending.
  let release;const blocked=new Promise(resolve=>release=resolve);let closed=0;
  a.runtime.close=async({grant})=>{closed++;await blocked;return {...grant,state:'stopped',resourceScope:'phone-run',retainedFrameBytes:0};};
  const before=b.events.filter(x=>x==='renew').length;
  service.startReconciler();t.after(()=>{service.stopReconciler();release();});
  await new Promise(resolve=>setTimeout(resolve,3250));
  assert.equal(closed,1,'one cleanup at a time for the same source');
  assert.ok(b.events.filter(x=>x==='renew').length-before>=3,'healthy input renews while another cleanup is blocked');
  release();await service.reconcile();service.stopReconciler();
});

test('uploaded video is explicit, ROM-gated, owner-bound and renewed without a viewer',async()=>{
  for(const loop of [false,true]){
    const f=fixture();f.input.source={...f.input.source,kind:'video',loop,file:{...f.input.source.file,name:'movie.mp4',sizeBytes:64*1024**2}};
    f.runtime.capabilities=async()=>({image:true,video:true});
    f.runtime.video=async({grant,metadata,chunks,loop:selected})=>{assert.equal(selected,loop);assert.deepEqual(metadata,f.input.source.file);
      for await(const chunk of chunks)assert.equal(chunk.toString(),'image');f.events.push('video');return {...grant,state:'receiving',resourceScope:'phone-run'};};
    assert.equal((await f.service.status({context:f.context,phoneId:f.phoneId,generation:1})).capabilities.video,true);
    const first=await f.start();assert.equal(first.sourceKind,'video');assert.equal(first.continueWithoutViewer,true);
    await f.start();assert.deepEqual(f.events,['open','read','video']);
    await f.service.reconcile();assert.equal(f.events.at(-1),'renew');
    await assert.rejects(f.service.start({context:f.context,phoneId:f.phoneId,input:{...f.input,source:{...f.input.source,loop:!loop}}}),{code:'phone_idempotency_conflict'});
    f.runtime.status=async({grant})=>({...grant,state:'stopped',resourceScope:'phone-run'});
    assert.equal((await f.service.status({context:f.context,phoneId:f.phoneId,generation:1})).state,'stopped');
    assert.deepEqual(f.events.slice(-2),['close','confirmed']);
  }
});
test('video missing adapter, disallowed ROM or invalid options never reads the private file',async()=>{
  for(const mode of ['adapter','capability','rom','loop','continued','size','url']){
    const f=fixture();f.input.source={...f.input.source,kind:'video',loop:false};
    f.runtime.capabilities=async()=>({image:true,video:mode!=='capability'});
    if(mode!=='adapter')f.runtime.video=async()=>{throw Error('must not decode');};
    if(mode==='rom')f.selected.cameraCapability='unavailable';if(mode==='loop')f.input.source.loop='false';
    if(mode==='continued')f.input.source.continueWithoutViewer=false;if(mode==='size')f.input.source.file.sizeBytes=Number.MAX_SAFE_INTEGER+1;
    if(mode==='url')f.input.source.url='https://host/private';
    await assert.rejects(f.start());assert.deepEqual(f.events,[]);
  }
});
test('video startup failure and permission loss stop only that source',async()=>{
  for(const mode of ['decode','permission','logout','server']){
    const f=fixture();f.input.source={...f.input.source,kind:'video',loop:true};f.runtime.capabilities=async()=>({video:true});
    f.runtime.video=async({grant})=>{if(mode==='decode')throw Error('unsupported');return {...grant,state:'receiving',resourceScope:'phone-run'};};
    if(mode==='decode')await assert.rejects(f.start());
    else{await f.start();if(mode==='permission')f.allowed(false);if(mode==='logout')f.live(false);
      await(mode==='server'?new PhoneCameraService(f.dependencies):f.service).reconcile();}
    assert.equal(f.value().state,'stopped');assert.deepEqual(f.events.slice(-2),['close','confirmed']);
  }
});

function browserFixture(){
  const f=fixture();let now=10000;
  f.input.source={kind:'browser',continueWithoutViewer:false};
  f.runtime.capabilities=async()=>({image:true,browser:true});
  f.runtime.browserOffer=async({grant,offerSdp,allowedAddresses,signal})=>{
    signal.throwIfAborted();assert.equal(offerSdp,'v=0\r\n');assert.deepEqual(allowedAddresses,['10.64.0.8']);
    f.events.push('offer');return {...grant,state:'waiting',resourceScope:'phone-run',answerSdp:'v=0\r\n'};
  };
  f.service=new PhoneCameraService({...f.dependencies,now:()=>now});
  f.tick=milliseconds=>now+=milliseconds;
  f.heartbeat=(context=f.context)=>f.service.keepBrowserAlive({context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId}});
  f.offer=()=>f.service.browserOffer({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId,offerSdp:'v=0\r\n'},allowedAddresses:['10.64.0.8']});
  return f;
}
test('browser source remains gated to an installed adapter; no image/object access or automatic capture',async()=>{
  const f=browserFixture();f.runtime.capabilities=async()=>({image:true});
  await assert.rejects(f.start(),{code:'phone_camera_unavailable'});assert.deepEqual(f.events,[]);
  f.runtime.capabilities=async()=>({image:true,browser:true});
  const result=await f.start();assert.equal(result.sourceKind,'browser');assert.equal(result.continueWithoutViewer,false);
  assert.deepEqual(f.events,['open']);assert.deepEqual(f.value().source,{kind:'browser',continueWithoutViewer:false});
  assert.deepEqual(await f.offer(),{sourceId:f.input.requestId,answerSdp:'v=0\r\n'});
  assert.equal((await f.service.status({context:f.context,phoneId:f.phoneId,generation:1})).capabilities.browser,true);
});
test('browser heartbeat renews only the exact live source; a lost page expires without a stop request',async()=>{
  const f=browserFixture();await f.start();await f.offer();
  for(let i=0;i<3;i++){f.tick(3000);assert.equal((await f.heartbeat()).expiresInMilliseconds,4000);await f.service.reconcile();}
  assert.equal(f.value().state,'active');f.tick(4001);await f.service.reconcile();
  assert.equal(f.value().state,'stopped');assert.deepEqual(f.events.slice(-2),['close','confirmed']);
  await assert.rejects(f.heartbeat(),{code:'phone_camera_source_stopped'});
});
test('expired browser source cannot be revived by a late heartbeat or retry before the reconciler runs',async()=>{
  for(const action of ['heartbeat','retry']){
    const f=browserFixture();await f.start();f.tick(4001);
    await assert.rejects(action==='heartbeat'?f.heartbeat():f.start(),{code:'phone_camera_source_stopped'});
    assert.equal(f.value().state,'stopped');
  }
});
test('another login, owner, stale generation and caller supplied address cannot renew or negotiate camera',async()=>{
  const f=browserFixture();await f.start();
  for(const context of [{...f.context,sessionId:randomUUID()},{...f.context,identityId:randomUUID()}])await assert.rejects(f.heartbeat(context));
  await assert.rejects(f.service.keepBrowserAlive({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:2,sourceId:f.input.requestId}}));
  await assert.rejects(f.service.browserOffer({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId,offerSdp:'v=0\r\n',allowedAddresses:['10.64.0.20']}}));
  await assert.rejects(f.service.browserOffer({context:f.context,phoneId:f.phoneId,input:{expectedGeneration:1,sourceId:f.input.requestId,offerSdp:'v=0\r\n'}}),{code:'phone_camera_unavailable'});
  assert.equal(f.events.includes('offer'),false);assert.equal(f.value().state,'active');
});
test('browser source logout, removed permission and server restart close rather than resume capture',async()=>{
  for(const mode of ['logout','permission','restart']){
    const f=browserFixture();await f.start();await f.offer();
    if(mode==='logout')f.live(false);if(mode==='permission')f.allowed(false);
    await (mode==='restart'?new PhoneCameraService(f.dependencies):f.service).reconcile();
    assert.equal(f.value().state,'stopped');assert.deepEqual(f.events.slice(-2),['close','confirmed']);
  }
});
test('only one browser negotiation, with no late response after stop or expired page',async()=>{
  const f=browserFixture();await f.start();await f.offer();
  await assert.rejects(f.offer(),{code:'phone_operation_conflict'});
  for(const action of ['stop','expiry']){
    const g=browserFixture();await g.start();let started;
    const entered=new Promise(resolve=>started=resolve);
    g.runtime.browserOffer=async({signal})=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
    const work=g.offer(),rejected=assert.rejects(work);await entered;
    if(action==='expiry'){g.tick(4001);await g.service.reconcile();}
    else await g.service.stop({context:g.context,phoneId:g.phoneId,input:{expectedGeneration:1,sourceId:g.input.requestId}});
    await rejected;assert.equal(g.value().state,'stopped');
  }
});
test('browser source does not persist SDP, host camera labels, audio settings or background authorization',()=>{
  const f=browserFixture();
  for(const patch of [{offerSdp:'private'},{deviceLabel:'camera'},{audio:true},{url:'udp://host'},{continueWithoutViewer:true}]){
    assert.throws(()=>cameraStartInput({...f.input,source:{...f.input.source,...patch}}));
  }
  assert.deepEqual(cameraStartInput(f.input).source,{kind:'browser',continueWithoutViewer:false});
});
