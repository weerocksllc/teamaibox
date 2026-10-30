import assert from "node:assert/strict";
import {createHash,createHmac,randomUUID,X509Certificate} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:https";
import {once} from "node:events";
import {test} from "node:test";
import WebSocket,{WebSocketServer} from "ws";
import {NodeAgentHttpsTransport} from "../../../services/scheduler/src/node-agent-https-transport.mjs";
import {ProtectedNodeAgentClient} from "../../../services/scheduler/src/protected-node-agent-client.mjs";
import {ManagedNodeAgentRouter} from "../../../services/scheduler/src/managed-node-agent-router.mjs";
import {phoneMediaGrant,validatePhoneMediaCommand,validatePhoneMediaResult} from "../../../services/scheduler/src/android-phone-media-command.mjs";

const execute=promisify(execFile),secret=Buffer.alloc(32,45),nodeId=randomUUID();
function payload(){const id=randomUUID();return {phoneId:randomUUID(),ownerId:randomUUID(),volumeId:randomUUID(),operationId:id,
  poolId:"phone-test-encrypted",baseBuildId:"16102939",generation:1,
  run:{id:randomUUID(),reservationId:randomUUID(),imageDigest:`sha256:${"a".repeat(64)}`,memoryBytes:6*1024**3,cpuMillis:2000},
  grantId:id,sessionId:randomUUID(),kind:"control",leaseExpiresAt:Date.now()+4500};}

async function tlsFixture(t,mediaHeaders={}){
  const directory=await mkdtemp(join(tmpdir(),"teamaibox-phone-tls-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  // Only generated loopback test credentials are written; no deployed key is read.
  await writeFile(join(directory,"openssl.cnf"),`[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=phone-test.local\n[ext]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:phone-test.local,IP:127.0.0.1\n`,{mode:0o600});
  await execute("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-config",join(directory,"openssl.cnf"),
    "-keyout",join(directory,"key.pem"),"-out",join(directory,"cert.pem")],{timeout:15000,maxBuffer:8192});
  const cert=await readFile(join(directory,"cert.pem")),key=await readFile(join(directory,"key.pem"));
  const fingerprint=`sha256:${createHash("sha256").update(new X509Certificate(cert).raw).digest("hex")}`;
  const connections=new Set(),requests=[],server=createServer({cert,key,ca:cert,requestCert:true,rejectUnauthorized:true,minVersion:"TLSv1.3"});
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:262144});
  wss.on("headers",headers=>{for(const [key,value] of Object.entries(mediaHeaders))headers.push(`${key}: ${value}`);});
  server.on("upgrade",(request,socket,head)=>{
    const body=Buffer.from(request.headers["x-teamaibox-command"]??"","base64url").toString("utf8");
    const signature=createHmac("sha256",secret).update(`${request.headers["x-teamaibox-key-id"]}\n${request.headers["x-teamaibox-nonce"]}\n${body}`).digest("base64url");
    if(!request.socket.authorized || request.url!=="/v1/phone-media/signal" || request.headers["x-teamaibox-signature"]!==signature){socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return;}
    requests.push({body,headers:request.headers,protocol:request.socket.getProtocol()});
    wss.handleUpgrade(request,socket,head,ws=>{connections.add(ws);ws.on("error",()=>{});ws.on("close",()=>connections.delete(ws));
      ws.on("message",bytes=>{ws.send(bytes.toString("utf8"));});});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{for(const ws of connections)ws.terminate();wss.close();await new Promise(resolve=>server.close(resolve));cert.fill(0);key.fill(0);});
  return {requests,connections,options:{host:"127.0.0.1",port:server.address().port,expectedServerName:"phone-test.local",
    expectedCertificateFingerprint:fingerprint,ca:cert,certificate:cert,privateKey:key}};
}
function protectedClient(transport){return new ProtectedNodeAgentClient({nodeId,nodeGeneration:7,transport,
  workerSpecFactory:{buildStartPayload(){throw Error("not a worker operation");}},commandSigner:{async sign({body}){
    const keyId="phone-test-key",nonce=randomUUID();return {keyId,nonce,signature:createHmac("sha256",secret).update(`${keyId}\n${nonce}\n${body}`).digest("base64url")};}}});}

test("actual WSS transport keeps exact mTLS identity and signed phone envelope until disconnect",{timeout:20000},async t=>{
  const f=await tlsFixture(t),transport=new NodeAgentHttpsTransport(f.options),client=protectedClient(transport),p=payload();
  let closed=0,received;const message=new Promise(resolve=>{received=resolve;}),abort=new AbortController();
  const peer=await client.connectPhoneSignal({payload:p,correlationId:"phone:signal-test",signal:abort.signal,
    createWebSocket:(url,options)=>new WebSocket(url,options),onMessage:received,onClose:()=>closed++});
  peer.send({message_type:"connect",device_id:`phone-${p.phoneId}`});assert.deepEqual(await message,{message_type:"connect",device_id:`phone-${p.phoneId}`});
  const e=JSON.parse(f.requests[0].body);assert.equal(e.type,"android-phone.media.renew");assert.equal(e.nodeGeneration,7);
  assert.equal(e.leaseId,p.phoneId);assert.equal(e.fencingToken,2);assert.deepEqual(e.payload,p);
  assert.equal(Date.parse(e.deadlineAt)-Date.parse(e.issuedAt),4000);assert.equal(f.requests[0].protocol,"TLSv1.3");
  assert.equal(f.requests[0].headers.cookie,undefined);assert.equal(f.requests[0].headers.authorization,undefined);
  const upstreamClosed=once([...f.connections][0],"close");abort.abort();await upstreamClosed;peer.close();assert.equal(closed,1);transport.close();
});

test("verified WSS metadata maps only the installed phone slot, not other private sockets",{timeout:20000},async t=>{
  const f=await tlsFixture(t,{"X-Teamaibox-Phone-Media-Node":"10.64.0.19","X-Teamaibox-Phone-Media-Container":"172.30.0.2","X-Teamaibox-Phone-Media-Range":"20000-20049"});
  // Main-appliance control traffic uses an internal DNS alias while browsers
  // must receive the authenticated LAN media address.
  const transport=new NodeAgentHttpsTransport({...f.options,host:"local-node-agent"}),seen=[];
  const peer=await protectedClient(transport).connectPhoneSignal({payload:payload(),correlationId:"phone:signal-lan",
    // This fixture dials only its generated loopback TLS server, not the live box.
    createWebSocket:(url,options)=>{assert.equal(new URL(url).hostname,"local-node-agent");return new WebSocket(url.replace("local-node-agent","127.0.0.1"),options);},
    onMessage:value=>seen.push(value),onClose:()=>{}});
  const ws=[...f.connections][0],message=(address,port)=>({message_type:"device_msg",payload:{type:"ice-candidate",candidate:`candidate:a 1 udp 123 ${address} ${port} typ host generation 0`}});
  ws.send(JSON.stringify(message("192.168.246.1",20001)));ws.send(JSON.stringify(message("172.30.0.2",8463)));
  ws.send(JSON.stringify(message("172.30.0.2",20101)));ws.send(JSON.stringify(message("172.30.0.2",20001)));
  const marker=new Promise(resolve=>{const timer=setInterval(()=>{if(seen.length){clearInterval(timer);resolve();}},10);t.after(()=>clearInterval(timer));});
  await marker;
  assert.deepEqual(seen,[message("10.64.0.19",20001)]);peer.close();transport.close();
});

test("WSS rejects partial or unsafe installed network metadata before delivering messages",{timeout:20000},async t=>{
  for(const change of [{"X-Teamaibox-Phone-Media-Node":"203.0.113.23"},{"X-Teamaibox-Phone-Media-Node":"127.0.0.1"},{"X-Teamaibox-Phone-Media-Range":"20000-20149"},{"X-Teamaibox-Phone-Media-Container":"127.0.0.1"},{"X-Teamaibox-Phone-Media-Range":undefined}]) {
    const headers={"X-Teamaibox-Phone-Media-Node":"10.64.0.19","X-Teamaibox-Phone-Media-Container":"172.30.0.2","X-Teamaibox-Phone-Media-Range":"20000-20049",...change};
    for(const key of Object.keys(headers))if(headers[key]===undefined)delete headers[key];
    const f=await tlsFixture(t,headers),transport=new NodeAgentHttpsTransport({...f.options,host:"10.64.0.19"});let closed=0;
    await assert.rejects(protectedClient(transport).connectPhoneSignal({payload:payload(),correlationId:"phone:signal-lan-invalid",
      createWebSocket:(url,options)=>new WebSocket(url.replace("10.64.0.19","127.0.0.1"),options),onMessage:()=>assert.fail("invalid mapping delivered"),onClose:()=>closed++}));
    assert.equal(closed,1);transport.close();
  }
});
test("actual WSS transport rejects certificate drift, a wrong DNS identity and binary data",{timeout:20000},async t=>{
  const f=await tlsFixture(t);
  for(const override of [{expectedCertificateFingerprint:`sha256:${"f".repeat(64)}`},{expectedServerName:"other.invalid"}]){
    const transport=new NodeAgentHttpsTransport({...f.options,...override});let closed=0;
    await assert.rejects(protectedClient(transport).connectPhoneSignal({payload:payload(),correlationId:"phone:signal-negative",
      createWebSocket:(url,options)=>new WebSocket(url,options),onMessage:()=>assert.fail("unverified operator message"),onClose:()=>closed++}));
    assert.equal(closed,1);transport.close();
  }
  assert.equal(f.requests.length,0);
  const transport=new NodeAgentHttpsTransport(f.options);let closed=0;
  const peer=await protectedClient(transport).connectPhoneSignal({payload:payload(),correlationId:"phone:signal-binary",
    createWebSocket:(url,options)=>new WebSocket(url,options),onMessage:()=>assert.fail("binary reached policy"),onClose:()=>closed++});
  const ws=[...f.connections][0],ended=once(ws,"close");ws.send(Buffer.from([1,2,3]));await ended;
  assert.equal(closed,1);peer.close();transport.close();
});
test("managed signal router holds node credentials only for the live stream and fences removed nodes",async()=>{
  const node={nodeId,nodeKey:"phone-test.local",generation:7,lifecycleState:"ready",certificateFingerprint:`sha256:${"c".repeat(64)}`};
  let retired=0,closed=0,routed=0,upstreamClose;
  const router=new ManagedNodeAgentRouter({ localNodeId: node.nodeId,nodeRepository:{async findNode(){return node;}},async connectorFactory(route){
    routed++;assert.equal(route.expectedCertificateFingerprint,node.certificateFingerprint);return {
      startWorker(){},stopWorker(){},workerHealth(){},workerControl(){},close(){retired++;},
      async connectPhoneSignal({onClose}){upstreamClose=onClose;return {send(){},close(){onClose();}};}};}});
  const input={nodeId,nodeGeneration:7,payload:payload(),onClose:()=>closed++};
  const peer=await router.connectPhoneSignal(input);assert.equal(retired,0);peer.close();upstreamClose();assert.equal(retired,1);assert.equal(closed,1);
  node.lifecycleState="draining";await assert.rejects(router.connectPhoneSignal(input),{code:"managed_node_not_ready"});
  node.lifecycleState="ready";node.generation++;const recovered=await router.connectPhoneSignal(input);recovered.close();assert.equal(routed,2);
  node.lifecycleState="removed";await assert.rejects(router.connectPhoneSignal(input),{code:"managed_node_not_ready"});assert.equal(routed,2);
});
test("media command leases and acknowledgements cannot widen the phone control contract",()=>{
  const p=payload();assert.deepEqual(validatePhoneMediaCommand("open",p),p);
  for(const mutation of [{url:"https://arbitrary.invalid"},{leaseExpiresAt:Date.now()+6000},{grantId:randomUUID()},{kind:"shell"}])assert.throws(()=>validatePhoneMediaCommand("renew",{...p,...mutation}));
  const ack={...phoneMediaGrant(p),peerOpen:true,leaseExpiresAt:p.leaseExpiresAt};assert.deepEqual(validatePhoneMediaResult("renew",p,ack),ack);
  for(const mutation of [{peerOpen:false},{runId:randomUUID()},{peerClosed:true},{leaseExpiresAt:p.leaseExpiresAt+1}])assert.throws(()=>validatePhoneMediaResult("renew",p,{...ack,...mutation}));
});
