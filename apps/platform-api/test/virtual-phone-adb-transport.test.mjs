import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID,X509Certificate} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {connect} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {WebSocketServer,createWebSocketStream} from 'ws';
import {NodeAgentHttpsTransport} from '../../../services/scheduler/src/node-agent-https-transport.mjs';
import {ProtectedNodeAgentClient} from '../../../services/scheduler/src/protected-node-agent-client.mjs';
import {phoneAdbURL} from '../tools/phone-adb.mjs';

const execute=promisify(execFile),secret=Buffer.alloc(32,34);
async function fixture(t,{mutual=true}={}) {
  const directory=await mkdtemp(join(tmpdir(),'phone-adb-tls-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'openssl.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=phone-test.local\n[ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:phone-test.local,IP:127.0.0.1\n',{mode:0o600});
  await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',join(directory,'openssl.cnf'),'-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{timeout:15000,maxBuffer:8192});
  const cert=await readFile(join(directory,'cert.pem')),key=await readFile(join(directory,'key.pem'));
  const server=createServer({cert,key,ca:cert,requestCert:mutual,rejectUnauthorized:true,minVersion:'TLSv1.3'}),sockets=new Set();
  server.on('secureConnection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const socket of sockets)socket.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));cert.fill(0);key.fill(0);});
  return {server,directory,origin:`https://127.0.0.1:${server.address().port}`,options:{host:'127.0.0.1',port:server.address().port,expectedServerName:'phone-test.local',
    expectedCertificateFingerprint:`sha256:${createHash('sha256').update(new X509Certificate(cert).raw).digest('hex')}`,ca:cert,certificate:cert,privateKey:key}};
}
function client(transport) {
  return new ProtectedNodeAgentClient({nodeId:randomUUID(),nodeGeneration:7,transport,workerSpecFactory:{buildStartPayload(){}},
    commandSigner:{async sign({body}){const keyId='phone-adb-test',nonce=randomUUID();return {keyId,nonce,signature:createHmac('sha256',secret).update(`${keyId}\n${nonce}\n${body}`).digest('base64url')};}}});
}
function payload(){const id=randomUUID();return {phoneId:randomUUID(),ownerId:randomUUID(),volumeId:randomUUID(),operationId:id,
  poolId:'phone-test-encrypted',baseBuildId:'16102939',generation:1,
  run:{id:randomUUID(),reservationId:randomUUID(),imageDigest:`sha256:${'a'.repeat(64)}`,memoryBytes:6*1024**3,cpuMillis:2000},
  grantId:id,sessionId:randomUUID(),kind:'adb',leaseExpiresAt:Date.now()+4500};}
async function until(check){for(let n=0;n<400;n++){if(check())return;await delay(10);}assert.fail('test condition timeout');}

test('raw ADB upgrade keeps exact mTLS, signed node/run binding and all binary bytes',{timeout:25000},async t=>{
  const f=await fixture(t),requests=[];
  f.server.on('upgrade',(request,socket,head)=>{
    const body=Buffer.from(request.headers['x-teamaibox-command'],'base64url').toString();
    const signature=createHmac('sha256',secret).update(`${request.headers['x-teamaibox-key-id']}\n${request.headers['x-teamaibox-nonce']}\n${body}`).digest('base64url');
    assert.equal(request.socket.authorized,true);assert.equal(request.headers['x-teamaibox-signature'],signature);
    assert.equal(request.headers.cookie,undefined);assert.equal(request.headers.authorization,undefined);
    assert.equal(request.url,'/v1/phone-media/adb');assert.equal(request.socket.getProtocol(),'TLSv1.3');assert.equal(head.length,0);
    requests.push(JSON.parse(body));socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: teamaibox-adb\r\n\r\n');
    socket.pipe(socket);
  });
  for(const wrong of [{expectedCertificateFingerprint:`sha256:${'f'.repeat(64)}`},{expectedServerName:'other.invalid'}]){
    const transport=new NodeAgentHttpsTransport({...f.options,...wrong});
    await assert.rejects(client(transport).connectPhoneADB({payload:payload(),correlationId:'phone:adb-invalid'}));transport.close();
  }
  assert.equal(requests.length,0);
  const transport=new NodeAgentHttpsTransport(f.options),abort=new AbortController(),p=payload();
  const stream=await client(transport).connectPhoneADB({payload:p,correlationId:'phone:adb-test',signal:abort.signal});
  assert.deepEqual(requests[0].payload,p);assert.equal(requests[0].type,'android-phone.media.renew');assert.equal(requests[0].nodeGeneration,7);
  const bytes=Buffer.alloc(512*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const chunks=[];let received=0;stream.on('data',data=>{chunks.push(data);received+=data.length;});
  stream.write(bytes);stream.resume();await until(()=>received===bytes.length);assert.deepEqual(Buffer.concat(chunks),bytes);
  const closed=once(stream,'close');abort.abort();await closed;transport.close();
});

test('downloaded CLI works over trusted WSS and exposes only one local loopback ADB transport',{timeout:25000},async t=>{
  const f=await fixture(t,{mutual:false}),phoneId=randomUUID(),grantId=randomUUID(),token='x'.repeat(43),messages=[];
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:65536});
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
  f.server.on('upgrade',(request,socket,head)=>{
    assert.equal(request.url,new URL(phoneAdbURL({origin:f.origin,phoneId,grantId})).pathname);
    assert.equal(request.headers.cookie,undefined);assert.equal(request.headers.authorization,undefined);
    wss.handleUpgrade(request,socket,head,ws=>{
      ws.on('error',()=>{});ws.once('message',(bytes,binary)=>{
        assert.equal(binary,false);assert.deepEqual(JSON.parse(bytes),{type:'phone.authenticate',token});
        messages.push('authorized');ws.send(JSON.stringify({type:'phone.adb.ready'}));
        const bridge=createWebSocketStream(ws,{highWaterMark:65536});bridge.on('error',()=>{});bridge.pipe(bridge);
      });
    });
  });
  const source=new URL('../../virtual-phones-plugin/src/public/phone-adb-cli.mjs',import.meta.url);
  // Test the actual standalone downloaded bundle, outside node_modules. This
  // CA is generated only for this test; normal TLS verification is never off.
  const cliPath=join(f.directory,'phone-adb-cli.mjs');await writeFile(cliPath,await readFile(source),{mode:0o600});
  const child=spawn(process.execPath,[cliPath,`--origin=${f.origin}`,`--phone=${phoneId}`,`--grant=${grantId}`],{
    cwd:f.directory,env:{PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:join(f.directory,'cert.pem')},stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
  child.stdin.end(token+'\n');
  await until(()=>/adb connect 127\.0\.0\.1:(\d+)/.test(output) || child.exitCode!==null);
  assert.match(output,/adb connect 127\.0\.0\.1:(\d+)/,`exit=${child.exitCode} signal=${child.signalCode} stderr=${errors.replaceAll(token,'[redacted]')}`);
  assert.doesNotMatch(output+errors,new RegExp(token));assert.deepEqual(messages,['authorized']);
  const port=Number(/adb connect 127\.0\.0\.1:(\d+)/.exec(output)[1]);
  const local=connect(port,'127.0.0.1');local.on('error',()=>{});t.after(()=>local.destroy());await once(local,'connect');
  // Backpressure must retain a burst larger than an individual WSS frame.
  const bytes=Buffer.alloc(512*1024,173),chunks=[];let count=0;
  local.on('data',data=>{chunks.push(data);count+=data.length;});local.write(bytes);
  await until(()=>count===bytes.length);assert.deepEqual(Buffer.concat(chunks),bytes);
  const second=connect(port,'127.0.0.1');await assert.rejects(once(second,'connect'));second.destroy();
  const exit=once(child,'exit'),closed=once(local,'close');for(const ws of wss.clients)ws.terminate();await closed;await exit;
  assert.equal(child.exitCode,0);assert.match(errors,/调试连接已关闭/);
});

test('CLI rejects plaintext, targets, URL secrets and malformed identifiers before connection',()=>{
  const p={origin:'https://phone.test',phoneId:randomUUID(),grantId:randomUUID()};
  assert.match(phoneAdbURL(p),/^wss:\/\/phone.test\/api\/v1\/virtual-phones\//);
  for(const origin of ['http://phone.test','https://name:secret@phone.test','https://phone.test/other','https://phone.test/?token=x','https://phone.test/#key'])assert.throws(()=>phoneAdbURL({...p,origin}));
  assert.throws(()=>phoneAdbURL({...p,phoneId:'../../host'}));
});
