import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createHmac,randomUUID,X509Certificate} from 'node:crypto';
import {createServer} from 'node:https';
import {Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NodeAgentHttpsTransport} from '../../../services/scheduler/src/node-agent-https-transport.mjs';
import {ProtectedNodeAgentClient} from '../../../services/scheduler/src/protected-node-agent-client.mjs';
import {validatePhoneFileCommand,readPhoneFileResponse,PHONE_FILE_END} from '../../../services/scheduler/src/android-phone-file-command.mjs';
const secret=Buffer.alloc(32,42),execute=promisify(execFile);
function job(action='upload') {return {phoneId:randomUUID(),ownerId:randomUUID(),volumeId:randomUUID(),operationId:randomUUID(),poolId:'phone-test-encrypted',baseBuildId:'16102939',generation:1,
  run:{id:randomUUID(),reservationId:randomUUID(),imageDigest:'sha256:'+'a'.repeat(64),memoryBytes:6*1024**3,cpuMillis:2000},action,deadline:Date.now()+100000,
  ...(action==='list'?{}:{name:'会议.txt'}),...(['upload','install'].includes(action)?{sizeBytes:262144,sha256:'a'.repeat(64)}:{})};}
const ack=p=>({phoneId:p.phoneId,runId:p.run.id,generation:p.generation,transferId:p.operationId});
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'phone-files-tls-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'config'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=phone.local\n[ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:phone.local\n',{mode:0o600});
  await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(dir,'config'),'-keyout',join(dir,'key'),'-out',join(dir,'cert')],{timeout:15000,maxBuffer:8192});
  const cert=await readFile(join(dir,'cert')),key=await readFile(join(dir,'key'));
  const server=createServer({cert,key,ca:cert,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3'}),sockets=new Set();
  server.on('secureConnection',s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));cert.fill(0);key.fill(0);});
  return {server,options:{host:'127.0.0.1',port:server.address().port,expectedServerName:'phone.local',
    expectedCertificateFingerprint:'sha256:'+createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),ca:cert,certificate:cert,privateKey:key}};
}
function client(transport){return new ProtectedNodeAgentClient({nodeId:randomUUID(),nodeGeneration:2,transport,workerSpecFactory:{buildStartPayload(){}},
  commandSigner:{async sign({body}){const keyId='files-test',nonce=randomUUID();return {keyId,nonce,signature:createHmac('sha256',secret).update(`${keyId}\n${nonce}\n${body}`).digest('base64url')};}}});}

test('file transfer validates metadata and exact bounded response framing',async()=>{
  const p=job('download'),bytes=Buffer.from([0,255,4,3]),value={...ack(p),name:p.name,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const wire=Buffer.concat([Buffer.from(JSON.stringify(value)+'\n'),bytes,PHONE_FILE_END]);
  const result=await readPhoneFileResponse(Readable.from([...wire].map(x=>Buffer.from([x]))),p),chunks=[];
  for await(const chunk of result.chunks)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
  for(const corrupted of [wire.subarray(0,wire.length-1),Buffer.concat([wire,Buffer.from('extra')])]){
    const value=await readPhoneFileResponse(Readable.from([corrupted]),p);await assert.rejects(async()=>{for await(const _ of value.chunks){};});
  }
  await assert.rejects(readPhoneFileResponse(Readable.from([Buffer.from(JSON.stringify({...value,runId:randomUUID()})+'\n')]),p),/phone_stale_run/);
  assert.equal(validatePhoneFileCommand(job()).action,'upload');
  for(const bad of [{...job(),hostPath:'/etc/passwd'},{...job(),sizeBytes:Number.MAX_SAFE_INTEGER+1},{...job(),deadline:Date.now()+121000},{...job(),name:'../x'},{...job(),action:'exec'}])assert.throws(()=>validatePhoneFileCommand(bad));
});

test('real mTLS file transport preserves binary data, signed fences and rejects wrong certificates',{timeout:25000},async t=>{
  const f=await fixture(t),received=[],bytes=Buffer.alloc(262144,197);
  f.server.on('request',async(req,res)=>{
    try{
      const body=Buffer.from(req.headers['x-teamaibox-command'],'base64url').toString(),e=JSON.parse(body),p=e.payload;
      assert.equal(req.socket.authorized,true);assert.equal(req.socket.getProtocol(),'TLSv1.3');assert.equal(req.url,'/v1/phone-files');
      assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);
      assert.equal(req.headers['x-teamaibox-signature'],createHmac('sha256',secret).update(`${req.headers['x-teamaibox-key-id']}\n${req.headers['x-teamaibox-nonce']}\n${body}`).digest('base64url'));
      assert.equal(e.type,'android-phone.file.transfer');assert.equal(e.commandId,p.operationId);assert.equal(e.leaseId,p.phoneId);assert.equal(e.fencingToken,2);received.push(p.action);
      const data=[];for await(const chunk of req)data.push(chunk);
      res.setHeader('content-type','application/octet-stream');
      if(p.action==='upload'){assert.deepEqual(Buffer.concat(data),Buffer.concat([bytes,PHONE_FILE_END]));res.end(JSON.stringify({...ack(p),stored:true,name:p.name,sizeBytes:bytes.length,sha256:p.sha256})+'\n');}
      else {assert.equal(Buffer.concat(data).length,0);res.write(JSON.stringify({...ack(p),name:p.name,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})+'\n');res.end(Buffer.concat([bytes,PHONE_FILE_END]));}
    }catch(e){res.destroy(e);}
  });
  for(const overrides of [{expectedServerName:'wrong.invalid'},{expectedCertificateFingerprint:'sha256:'+'f'.repeat(64)}]){
    const transport=new NodeAgentHttpsTransport({...f.options,...overrides});await assert.rejects(client(transport).transferPhoneFile({payload:job('download'),correlationId:'phone-file:test'}));transport.close();
  }
  assert.equal(received.length,0);
  const transport=new NodeAgentHttpsTransport(f.options),c=client(transport),p=job();p.sha256=createHash('sha256').update(bytes).digest('hex');
  const result=await c.transferPhoneFile({payload:p,chunks:(async function*(){for(let i=0;i<bytes.length;i+=16384)yield bytes.subarray(i,i+16384);})(),correlationId:'phone-file:upload'});
  assert.equal(result.stored,true);
  const download=await c.transferPhoneFile({payload:job('download'),correlationId:'phone-file:download'}),output=[];
  for await(const chunk of download.chunks)output.push(chunk);assert.deepEqual(Buffer.concat(output),bytes);assert.deepEqual(received,['upload','download']);transport.close();
});

test('mTLS cancellation stops downloads; a live transfer may outlast command admission',{timeout:20000},async t=>{
  const f=await fixture(t),transport=new NodeAgentHttpsTransport(f.options),c=client(transport);
  t.after(()=>transport.close());let closed=0;
  f.server.on('request',(req,res)=>{
    const p=JSON.parse(Buffer.from(req.headers['x-teamaibox-command'],'base64url')).payload;
    req.resume();res.once('close',()=>closed++);
    res.setHeader('content-type','application/octet-stream');
    res.write(JSON.stringify({...ack(p),name:p.name,sizeBytes:1024,sha256:'a'.repeat(64)})+'\n');
    res.write(Buffer.alloc(16,4)); // Explicit partial response; deliberately never completed.
  });
  for(const reason of ['cancel','deadline']){
    const p=job('download'),controller=new AbortController();if(reason==='deadline')p.deadline=Date.now()+800;
    const result=await c.transferPhoneFile({payload:p,signal:controller.signal,correlationId:'phone-file:'+reason});
    const iterator=result.chunks[Symbol.asyncIterator]();assert.equal((await iterator.next()).value.length,16);
    const start=Date.now();
    if(reason==='deadline'){
      await new Promise(resolve=>setTimeout(resolve,1000));
      assert.equal(controller.signal.aborted,false);
    }
    controller.abort();
    await assert.rejects(iterator.next());assert.ok(Date.now()-start<1500,'bounded stream was closed');
  }
  for(let n=0;closed<2&&n<50;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(closed,2,'both TLS responses released');
});

test('file progress is run-bound and lists can exceed the old 64 KiB header',async()=>{
  const p=job('list'),files=Array.from({length:2500},(_,i)=>({name:'file-'+i+'.txt',sizeBytes:i}));
  const raw=Buffer.from(JSON.stringify({...ack(p),progress:true})+'\n'+JSON.stringify({...ack(p),files})+'\n');
  assert.ok(raw.length>65536);let progress=0;
  const result=await readPhoneFileResponse(Readable.from([raw]),p,{progress:()=>progress++});
  assert.equal(result.files.length,2500);assert.equal(progress,1);
  await assert.rejects(readPhoneFileResponse(Readable.from([Buffer.from(JSON.stringify({...ack(p),progress:true,runId:randomUUID()})+'\n')]),p),/phone_stale_run/);
});

test('real mTLS operation completes after admission expiry while progress continues',{timeout:15000},async t=>{
  const f=await fixture(t),transport=new NodeAgentHttpsTransport(f.options),c=client(transport);t.after(()=>transport.close());
  f.server.on('request',(req,res)=>{
    const p=JSON.parse(Buffer.from(req.headers['x-teamaibox-command'],'base64url')).payload;req.resume();
    res.setHeader('content-type','application/octet-stream');
    res.write(JSON.stringify({...ack(p),progress:true})+'\n');
    setTimeout(()=>res.end(JSON.stringify({...ack(p),files:[]})+'\n'),900);
  });
  const p=job('list');p.deadline=Date.now()+400;
  const result=await c.transferPhoneFile({payload:p,correlationId:'phone-file:after-admission'});
  assert.deepEqual(result.files,[]);assert.ok(Date.now()>p.deadline);
});
