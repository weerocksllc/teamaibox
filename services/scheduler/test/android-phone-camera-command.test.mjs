import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {validatePhoneCameraCommand,validatePhoneCameraResult,phoneCameraGrant,PHONE_CAMERA_END} from '../src/android-phone-camera-command.mjs';
import {NodeAgentHttpsTransport} from '../src/node-agent-https-transport.mjs';
const payload=(action='open')=>({phoneId:randomUUID(),ownerId:randomUUID(),volumeId:randomUUID(),poolId:'phone-pool',baseBuildId:'16102939',generation:1,
  run:{id:randomUUID(),reservationId:randomUUID(),imageDigest:'sha256:'+'a'.repeat(64),memoryBytes:6*1024**3,cpuMillis:2000},
  ...(()=>{const id=randomUUID();return {operationId:id,grantId:id};})(),sourceId:randomUUID(),sourceKind:'image',sessionId:randomUUID(),action,
  deadline:Date.now()+4000,...(['open','renew'].includes(action)?{leaseExpiresAt:Date.now()+4000}:{})});
const response=p=>({...phoneCameraGrant(p),state:p.action==='image'?'receiving':p.action==='close'?'stopped':'waiting',resourceScope:'phone-run',
  ...(['open','renew'].includes(p.action)?{leaseExpiresAt:p.leaseExpiresAt}:p.action==='close'?{retainedFrameBytes:0}:{})});
test('network camera accepts only explicit node listener and source CIDRs; waiting is not a fake frame',()=>{
  const p={...payload('udp'),sourceKind:'udp',udpPolicy:{listenAddress:'10.64.0.19',listenPort:24100,allowedSources:['192.168.0.0/16']}};
  validatePhoneCameraCommand(p);validatePhoneCameraResult(p,response(p));validatePhoneCameraResult(p,{...response(p),state:'receiving'});
  for(const patch of [{listenAddress:'0.0.0.0'},{listenPort:80},{allowedSources:['0.0.0.0/0']},{allowedSources:['192.168.1.1/24']},
    {allowedSources:['224.0.0.0/24']},{allowedSources:[]},{url:'http://camera'}])assert.throws(()=>validatePhoneCameraCommand({...p,udpPolicy:{...p.udpPolicy,...patch}}));
  for(const patch of [{sourceKind:'usb'},{udpPolicy:undefined},{deviceId:randomUUID()},{sizeBytes:1},{action:'open',leaseExpiresAt:Date.now()+4000}])assert.throws(()=>validatePhoneCameraCommand({...p,...patch}));
  validatePhoneCameraCommand({...payload('renew'),sourceKind:'udp'});
});
test('camera command accepts only installed fixed resources, bounded image and exact current grant',()=>{
  const p=payload();validatePhoneCameraCommand(p);validatePhoneCameraResult(p,response(p));
  for(const patch of [{kind:'adb'},{sourceKind:'unknown'},{host:'/dev/video0'},{deadline:Date.now()+20000},{leaseExpiresAt:Date.now()+6000},{sizeBytes:1},
    {run:{...p.run,memoryBytes:8*1024**3}},{operationId:randomUUID()}])assert.throws(()=>validatePhoneCameraCommand({...p,...patch}));
  for(const patch of [{ownerId:randomUUID()},{resourceScope:'host'},{unexpected:true},{state:'stopped'}])assert.throws(()=>validatePhoneCameraResult(p,{...response(p),...patch}));
  const close=payload('close');validatePhoneCameraResult(close,response(close));assert.throws(()=>validatePhoneCameraResult(close,{...response(close),retainedFrameBytes:1}));
});
test('USB source uses a same-run grant and device identity, never a host pathname',()=>{
  const p={...payload('usb'),sourceKind:'usb',deviceId:randomUUID(),attachmentId:'a'.repeat(64)};
  validatePhoneCameraCommand(p);validatePhoneCameraResult(p,{...response(p),state:'receiving'});
  validatePhoneCameraCommand({...p,deadline:Date.now()+14000});
  assert.throws(()=>validatePhoneCameraCommand({...p,deadline:Date.now()+16000}));
  for(const patch of [{deviceId:'/dev/video0'},{attachmentId:'old'},{sourceKind:'image'},{sizeBytes:1},{host:'/dev/video0'}])
    assert.throws(()=>validatePhoneCameraCommand({...p,...patch}));
  for(const action of ['image','video','open','close','status'])assert.throws(()=>validatePhoneCameraCommand({...p,action}));
  validatePhoneCameraCommand({...payload('open'),sourceKind:'usb'});
});
test('video transport requires an exact video grant, bounded bytes and explicit boolean loop',()=>{
  const p={...payload('video'),sourceKind:'video',sizeBytes:64*1024**2,sha256:'a'.repeat(64),loop:false,deadline:Date.now()+14000};
  validatePhoneCameraCommand(p);validatePhoneCameraResult(p,{...response(p),state:'receiving'});
  for(const patch of [{sourceKind:'image'},{sourceKind:'browser'},{sizeBytes:Number.MAX_SAFE_INTEGER+1},{loop:undefined},{loop:0},{peerAddress:'10.64.0.19'},{url:'file:///tmp/source'}])
    assert.throws(()=>validatePhoneCameraCommand({...p,...patch}));
  for(const action of ['open','renew','image','close','status'])assert.throws(()=>validatePhoneCameraCommand({...payload(action),loop:false}));
  assert.throws(()=>validatePhoneCameraResult(p,{...response(p),state:'waiting'}));
});
test('camera HTTPS streams bounded input with TLS pinning and does not forward any user cookie',async()=>{
  const cert=Buffer.from('synthetic-certificate'),p={...payload('image'),sizeBytes:5,sha256:createHash('sha256').update('image').digest('hex')};
  let options;const sent=[];
  const transport=new NodeAgentHttpsTransport({host:'127.0.0.1',expectedServerName:'node.test',expectedCertificateFingerprint:'sha256:'+createHash('sha256').update(cert).digest('hex'),
    ca:Buffer.alloc(32),certificate:Buffer.alloc(32),privateKey:Buffer.alloc(32),checkServerIdentityImplementation:()=>undefined,
    requestImplementation:(settings,callback)=>{options=settings;const request=new EventEmitter();request.destroy=()=>{};
      request.write=(chunk,done)=>{sent.push(Buffer.from(chunk));done();return true;};request.end=chunk=>{if(chunk)sent.push(Buffer.from(chunk));const incoming=new EventEmitter();incoming.destroy=()=>{};
        incoming.statusCode=200;callback(incoming);incoming.emit('data',Buffer.from(JSON.stringify(response(p))));incoming.emit('end');};return request;}});
  const headers={'x-teamaibox-key-id':'key','x-teamaibox-nonce':'nonce','x-teamaibox-signature':'signature'};
  const result=await transport.executePhoneCamera({body:JSON.stringify({payload:p}),payload:p,headers,chunks:(async function*(){yield Buffer.from('image');})()});
  assert.equal(result.state,'receiving');assert.equal(Buffer.concat(sent).toString(),'image'+PHONE_CAMERA_END.toString());
  assert.equal(options.path,'/v1/phone-camera');assert.equal(options.rejectUnauthorized,true);assert.equal(options.minVersion,'TLSv1.3');assert.equal(options.maxVersion,'TLSv1.3');
  assert.equal(options.headers.cookie,undefined);assert.equal(options.checkServerIdentity('node.test',{raw:cert}),undefined);
  assert.ok(options.checkServerIdentity('node.test',{raw:Buffer.from('wrong')}));
  await assert.rejects(transport.executePhoneCamera({body:'{}',payload:p,headers:{...headers,cookie:'private'},chunks:(async function*(){})()}));
  transport.close();
});
test('browser commands cannot change phone resources, request arbitrary endpoints or add SDP to controls',()=>{
  const p={...payload('browser-offer'),sourceKind:'browser',sizeBytes:8,sha256:'a'.repeat(64),peerAddress:'10.64.0.8'};
  validatePhoneCameraCommand(p);
  for(const patch of [{sourceKind:'image'},{peerAddress:'169.254.169.254'},{peerAddress:'8.8.8.8'},{peerAddress:'camera.local'},
    {peerAddress:'::ffff:10.64.0.8'},{sizeBytes:65537},{offerSdp:'private'},{run:{...p.run,cpuMillis:4000}}])assert.throws(()=>validatePhoneCameraCommand({...p,...patch}));
  for(const action of ['status','close','open','renew'])assert.throws(()=>validatePhoneCameraCommand({...payload(action),sourceKind:'browser',peerAddress:'10.64.0.8'}));
  const r={...response(p),answerSdp:'v=0\r\n',containerAddress:'172.18.0.2',nodeAddress:'10.64.0.19',firstPort:20040,lastPort:20049};
  validatePhoneCameraResult(p,r);
  for(const patch of [{firstPort:20000},{lastPort:20149},{nodeAddress:r.containerAddress},{answerSdp:'x'.repeat(65537)},{sourceId:randomUUID()}])
    assert.throws(()=>validatePhoneCameraResult(p,{...r,...patch}));
  const status=payload('status');assert.throws(()=>validatePhoneCameraResult(status,{...response(status),answerSdp:'v=0\r\n'}));
});
test('USB busy and detached errors survive transport without exposing private errors',async()=>{
  const p={...payload('usb'),sourceKind:'usb',deviceId:randomUUID(),attachmentId:'a'.repeat(64)};
  let code='phone_camera_usb_busy';
  const transport=new NodeAgentHttpsTransport({host:'10.64.0.19',expectedServerName:'node.test',expectedCertificateFingerprint:'sha256:'+'a'.repeat(64),ca:Buffer.alloc(32),certificate:Buffer.alloc(32),privateKey:Buffer.alloc(32),
    requestImplementation:(_,callback)=>{const request=new EventEmitter();request.destroy=()=>{};
      request.end=()=>{const incoming=new EventEmitter();incoming.destroy=()=>{};incoming.statusCode=409;callback(incoming);
        incoming.emit('data',Buffer.from(JSON.stringify({error:{code}})));incoming.emit('end');};return request;}});
  const call=()=>transport.executePhoneCamera({body:JSON.stringify({payload:p}),payload:p,headers:{'x-teamaibox-key-id':'key','x-teamaibox-nonce':'nonce','x-teamaibox-signature':'signature'}});
  for(const value of ['phone_camera_usb_busy','phone_camera_usb_device_changed']){code=value;await assert.rejects(call(),{message:value});}
  code='/private/path';await assert.rejects(call(),{message:'phone_camera_input_rejected'});transport.close();
});
test('browser SDP is bounded and mapped only from the exact inspected phone last ten ports',async()=>{
  const p={...payload('browser-offer'),sourceKind:'browser',sizeBytes:8,sha256:'a'.repeat(64),peerAddress:'10.64.0.8'};
  let patch={};const base={...response(p),answerSdp:'v=0\r\nc=IN IP4 172.18.0.2\r\na=candidate:123 1 UDP 1234 172.18.0.2 20043 typ host\r\n',containerAddress:'172.18.0.2',nodeAddress:'10.64.0.19',firstPort:20040,lastPort:20049};
  const transport=new NodeAgentHttpsTransport({host:'10.64.0.19',expectedServerName:'node.test',expectedCertificateFingerprint:'sha256:'+'a'.repeat(64),ca:Buffer.alloc(32),certificate:Buffer.alloc(32),privateKey:Buffer.alloc(32),
    requestImplementation:(_,callback)=>{const request=new EventEmitter();request.destroy=()=>{};request.write=(_,done)=>{done();return true;};
      request.end=()=>{const incoming=new EventEmitter();incoming.destroy=err=>incoming.emit('error',err);incoming.statusCode=200;callback(incoming);
        incoming.emit('data',Buffer.from(JSON.stringify({...base,...patch})));incoming.emit('end');};return request;}});
  const call=()=>transport.executePhoneCamera({body:JSON.stringify({payload:p}),payload:p,headers:{'x-teamaibox-key-id':'key','x-teamaibox-nonce':'nonce','x-teamaibox-signature':'signature'},chunks:(async function*(){yield Buffer.from('v=0\r\nabc');})()});
  assert.match((await call()).answerSdp,/192\.168\.10\.19 20043 typ host/);
  for(const value of [{nodeAddress:'10.64.0.23'},{answerSdp:base.answerSdp.replace('20043','20003')},
    {answerSdp:base.answerSdp.replaceAll('172.18.0.2','172.18.0.3')},{answerSdp:'v=0\r\n'}]){patch=value;await assert.rejects(call());}
  transport.close();
});
