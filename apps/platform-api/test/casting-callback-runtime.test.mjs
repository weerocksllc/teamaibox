import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:https";
import { connect } from "node:tls";
import { createServer } from "node:net";
import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { castingCallbackConfigured, createCastingCallbackRuntime, createCastingCallbackRuntimeFromEnvironment }
  from "../server/casting-callback-runtime.mjs";
import { startPlatformApi } from "../server/platform-api.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";

const execute = promisify(execFile), SESSION = "10000000-0000-4000-8000-000000000001";
const SERVICE = "60000000-0000-4000-8000-000000000001";
const PAIR = `/internal/v1/casting/sessions/${SESSION}/source/pair`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "casting-private-callback-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const openssl = (...args) => execute("openssl", args, { cwd: root, timeout: 10000 });
  await openssl("req", "-x509", "-sha256", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Ephemeral callback test CA", "-keyout", "ca.key", "-out", "ca.crt",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash");
  let serial = 2;
  for (const [name, san, usage] of [["server", "DNS:localhost", "serverAuth"],
    ["media", "URI:spiffe://teamaibox.local/service/trusted-media/" + SERVICE, "clientAuth"],
    ["wrong", "URI:spiffe://teamaibox.local/service/trusted-media/60000000-0000-4000-8000-000000000002", "clientAuth"]]) {
    await openssl("req", "-new", "-sha256", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN="+name,
      "-keyout", name+".key", "-out", name+".csr");
    await writeFile(join(root,name+".ext"), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\nextendedKeyUsage=${usage}\nsubjectAltName=${san}\n`);
    await openssl("x509", "-req", "-sha256", "-days", "1", "-in", name+".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-set_serial", String(serial++), "-extfile", name+".ext", "-out", name+".crt");
  }
  const files = Object.fromEntries(await Promise.all(["ca.crt","server.crt","server.key","media.crt","media.key","wrong.crt","wrong.key"]
    .map(async name => [name, await readFile(join(root,name))])));
  const contract = JSON.parse(await readFile(new URL("../../../deploy/casting/trusted-media-callback-contract.v1.json", import.meta.url)));
  contract.status = "runtime-bound";
  contract.serviceIdentity.certificateFingerprint = "sha256:"+createHash("sha256").update(new X509Certificate(files["media.crt"]).raw).digest("hex");
  contract.activationGate = { bound:true, blockers:[] }; contract.claimBoundary.runtimeBound = true;
  const calls = [];
  const service = { async pairSource(input) { calls.push(input); return {paired:true, state:"paired"}; },
    async markStreaming() { return {sessionId:SESSION,state:"streaming",stateRevision:3}; },
    async authorizeMediaConnection() { throw new PlatformError("cast_view_denied", "PRIVATE credential must never be returned", {status:403}); } };
  for (const method of ["startSession","currentSession","getSession","updateAudience","stopSession","forceStop",
    "health","createInvitation","listInvitations","acceptInvitation","declineInvitation","join","createMediaConnection",
    "leave","listViewers","removeViewer"]) service[method]=async()=>{throw new Error("unexpected public service call");};
  const config = { service, contract, host:"127.0.0.1",port:0,ca:files["ca.crt"],cert:files["server.crt"],key:files["server.key"] };
  const runtime = createCastingCallbackRuntime(config); await runtime.listen(); t.after(() => runtime.close());
  async function post({ path=PAIR, identity="media", body={pin:"1234",source_connection_id:randomUUID()}, headers={}, port=runtime.address().port }={}) {
    const raw=Buffer.from(JSON.stringify(body));
    return new Promise((resolve,reject) => {
      const req=request({hostname:"127.0.0.1",port,servername:"localhost",method:"POST",path,
        ca:files["ca.crt"], ...(identity?{cert:files[identity+".crt"],key:files[identity+".key"]}:{}),
        minVersion:"TLSv1.3",maxVersion:"TLSv1.3",agent:false,
        headers:{"content-type":"application/json","content-length":String(raw.length),
          "x-teamaibox-callback-id":randomUUID(),"x-teamaibox-callback-issued-at":new Date().toISOString(),...headers}},res=>{
        let data=""; res.on("data",c=>data+=c);res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(data),headers:res.headers}));
      });req.once("error",reject);req.setTimeout(3000,()=>req.destroy(Error("test timeout")));req.end(raw);
    });
  }
  return {root,files,contract,service,calls,config,runtime,post};
}

async function environment(f, port) {
  await writeFile(join(f.root,"contract.json"),JSON.stringify(f.contract));
  return {PLATFORM_CASTING_CALLBACK_HOST:"127.0.0.1",PLATFORM_CASTING_CALLBACK_PORT:String(port),
    PLATFORM_CASTING_CALLBACK_CONTRACT_FILE:join(f.root,"contract.json"),PLATFORM_CASTING_CALLBACK_CA_FILE:join(f.root,"ca.crt"),
    PLATFORM_CASTING_CALLBACK_CERT_FILE:join(f.root,"server.crt"),PLATFORM_CASTING_CALLBACK_KEY_FILE:join(f.root,"server.key")};
}
async function freePort() {
  const probe=createServer(); await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;
}

test("private callback settings reject partial, wildcard, public, DNS and invalid ports", () => {
  assert.equal(castingCallbackConfigured({}),false);
  const env={PLATFORM_CASTING_CALLBACK_HOST:"127.0.0.1",PLATFORM_CASTING_CALLBACK_PORT:"17444",
    PLATFORM_CASTING_CALLBACK_CONTRACT_FILE:"/run/private/contract.json",PLATFORM_CASTING_CALLBACK_CA_FILE:"/run/private/ca",
    PLATFORM_CASTING_CALLBACK_CERT_FILE:"/run/private/cert",PLATFORM_CASTING_CALLBACK_KEY_FILE:"/run/private/key"};
  assert.equal(castingCallbackConfigured(env),true);
  for (const host of ["0.0.0.0","8.8.8.8","example.com","::","169.254.1.1"])
    assert.throws(()=>castingCallbackConfigured({...env,PLATFORM_CASTING_CALLBACK_HOST:host}));
  for (const port of ["0","-1","65536","123x"])
    assert.throws(()=>castingCallbackConfigured({...env,PLATFORM_CASTING_CALLBACK_PORT:port}));
  assert.throws(()=>castingCallbackConfigured({PLATFORM_CASTING_CALLBACK_HOST:"127.0.0.1"}),/together/);
});

test("actual TLS 1.3 callbacks pair and stream; replay and pre-boot callbacks are denied", async t => {
  const f=await fixture(t), callbackId=randomUUID(), headers={"x-teamaibox-callback-id":callbackId};
  const result=await f.post({headers});assert.equal(result.status,200);assert.equal(result.body.paired,true);
  assert.equal(result.headers["cache-control"],"no-store");
  assert.equal((await f.post({headers})).status,409);
  assert.equal((await f.post({headers:{"x-teamaibox-callback-issued-at":new Date(Date.now()-60000).toISOString()}})).status,401);
  assert.equal((await f.post({path:PAIR.replace("pair","streaming"),body:{source_connection_id:randomUUID()}})).body.state,"streaming");
  assert.equal(f.calls.length,1);
});

test("no certificate, wrong service, forwarded identity and TLS downgrade cannot pair", async t => {
  const f=await fixture(t);
  await assert.rejects(f.post({identity:null}));
  assert.equal((await f.post({identity:"wrong",headers:{"x-forwarded-client-cert":"trusted-media", "x-teamaibox-service-id":SERVICE}})).status,401);
  await new Promise(resolve=>{
    const socket=connect({host:"127.0.0.1",port:f.runtime.address().port,servername:"localhost",ca:f.files["ca.crt"],
      cert:f.files["media.crt"],key:f.files["media.key"],minVersion:"TLSv1.2",maxVersion:"TLSv1.2"});
    socket.on("secureConnect",()=>assert.fail("TLS downgrade accepted"));socket.on("error",()=>resolve());
  });
  assert.equal(f.calls.length,0);
});

test("unknown routes, oversized or encoded input are denied; errors never echo secrets",async t=>{
  const f=await fixture(t);
  for(const path of ["/api/auth/sign-in",PAIR+"?debug=secret",PAIR.replace("/internal/","/api/")])
    assert.equal((await f.post({path})).status,404);
  assert.equal((await f.post({body:{pin:"9".repeat(17000)}})).status,400);
  assert.equal((await f.post({headers:{"content-encoding":"gzip"}})).status,400);
  const denied=await f.post({path:PAIR.replace("source/pair","viewers/authorize"),body:{viewer_identity_id:SESSION,
    browser_instance_id:"test-browser-instance-0001",media_credential:"never-return-this-secret"}});
  assert.equal(denied.status,403);assert.deepEqual(denied.body,{error:{code:"cast_view_denied"}});
  assert.equal(f.calls.length,0);
});

test("shutdown closes listener and is idempotent; startup failure can clean up",async t=>{
  const f=await fixture(t), second=createCastingCallbackRuntime({...f.config,port:f.runtime.address().port});
  await assert.rejects(second.listen(),e=>e.code==="EADDRINUSE");await second.close();
  const port=f.runtime.address().port;await f.runtime.close();await f.runtime.close();
  assert.equal(f.runtime.listening(),false);
  assert.equal(f.runtime.address(),null);
  const successor=createCastingCallbackRuntime({...f.config,port});await successor.listen();await successor.close();
});

test("protected config construction binds exact certificate; partial file setup creates no listener",async t=>{
  const f=await fixture(t), env=await environment(f,17444);
  const owner=await createCastingCallbackRuntimeFromEnvironment(env,{service:f.service});
  assert.equal(owner.listening(),false);await owner.close();
  await assert.rejects(createCastingCallbackRuntimeFromEnvironment({...env,PLATFORM_CASTING_CALLBACK_KEY_FILE:f.root},{service:f.service}));
});

test("actual receiver Python client interoperates with the private Node listener and pins before sending",async t=>{
  const f=await fixture(t), fingerprint="sha256:"+createHash("sha256").update(new X509Certificate(f.files["server.crt"]).raw).digest("hex");
  f.service.authorizeMediaConnection=async input=>({sessionId:input.sessionId,viewerIdentityId:input.viewerIdentityId,
    grantId:randomUUID(),audienceRevision:1,expiresAt:new Date(Date.now()+60000).toISOString(),muted:false,
    maximumViewers:8,publisherEncodeRenditions:1});
  const {stdout}=await execute(process.env.CASTING_TEST_PYTHON || "python3",["-c",`
import json,sys,socket
from pathlib import Path
from uuid import uuid4
from services.trusted_media_service.callback_client import TrustedMediaCallbackClient, callback_context, CallbackError
root,port,pin,session=sys.argv[1:]
p=Path(root)
ctx=callback_context(certificate=p/'media.crt',private_key=p/'media.key',server_ca=p/'ca.crt')
# Diagnose the ephemeral fixture handshake before the production client
# deliberately sanitizes transport failures.
with socket.create_connection(('127.0.0.1',int(port)),timeout=5) as connection_probe:
    with ctx.wrap_socket(connection_probe,server_hostname='localhost') as tls_probe:
        assert tls_probe.version() == 'TLSv1.3'
def client(fingerprint):
    return TrustedMediaCallbackClient(address='127.0.0.1',port=int(port),server_name='localhost',certificate_fingerprint=fingerprint,tls_context=ctx)
c=client(pin)
connection=str(uuid4())
assert c.pair_source(session_id=session,source_connection_id=connection,pin='1234')['paired']
assert c.mark_streaming(session_id=session,source_connection_id=connection)['state']=='streaming'
assert c.authorize_viewer(session_id=session,viewer_identity_id=session,browser_instance_id='callback-browser-instance-01',media_credential='ephemeral-component-credential')['authorized']
try:
    client('sha256:'+'0'*64).pair_source(session_id=session,source_connection_id=str(uuid4()),pin='1234')
except CallbackError:
    pass
else:
    raise AssertionError('unpinned peer accepted')
print(json.dumps({'pair':True,'stream':True,'viewer':True,'wrongPeerDenied':True}))
`,f.root,String(f.runtime.address().port),fingerprint,SESSION],{cwd:new URL("../../../",import.meta.url),timeout:15000});
  assert.deepEqual(JSON.parse(stdout),{pair:true,stream:true,viewer:true,wrongPeerDenied:true});
  assert.equal(f.calls.length,1);
});

test("Platform owns its private callback listener; public routes cannot proxy it and shutdown releases it",async t=>{
  const f=await fixture(t), callbackPort=f.runtime.address().port;await f.runtime.close();
  const port=await freePort(), env={...await environment(f,callbackPort),PLATFORM_API_HOST:"127.0.0.1",
    PLATFORM_API_PORT:String(port),PLATFORM_API_PUBLIC_ORIGIN:"https://spark.test",
    PLATFORM_APPLIANCE_NODE_ID:SESSION};
  const dependencies={castingRuntime:{},castingService:f.service,identityRepository:new MemoryIdentityRepository()};
  const server=await startPlatformApi(env,dependencies);t.after(()=>server.close());
  assert.equal((await f.post({port:callbackPort})).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}${PAIR}`,{method:"POST"})).status,404);
  await new Promise(resolve=>server.close(resolve));
  await assert.rejects(f.post({port:callbackPort}));
  const successor=createCastingCallbackRuntime({...f.config,port:callbackPort});await successor.listen();await successor.close();
});

test("failed public bind closes the newly opened callback listener",async t=>{
  const f=await fixture(t), callbackPort=f.runtime.address().port;await f.runtime.close();
  const occupied=createServer();await new Promise(resolve=>occupied.listen(0,"127.0.0.1",resolve));t.after(()=>occupied.close());
  await assert.rejects(startPlatformApi({...await environment(f,callbackPort),PLATFORM_API_HOST:"127.0.0.1",
    PLATFORM_API_PORT:String(occupied.address().port),PLATFORM_API_PUBLIC_ORIGIN:"https://spark.test",
    PLATFORM_APPLIANCE_NODE_ID:SESSION},
  {castingRuntime:{},castingService:f.service,identityRepository:new MemoryIdentityRepository()}),e=>e.code==="EADDRINUSE");
  const successor=createCastingCallbackRuntime({...f.config,port:callbackPort});await successor.listen();await successor.close();
});

test("development activation cannot omit accounting, callback, signalling or durable state",async()=>{
  await assert.rejects(startPlatformApi({PLATFORM_API_PUBLIC_ORIGIN:"https://spark.test",
    PLATFORM_CASTING_ACTIVATION_MODE:"development"}),/complete durable private runtime/);
  await assert.rejects(startPlatformApi({PLATFORM_API_PUBLIC_ORIGIN:"https://spark.test",
    PLATFORM_CASTING_ACTIVATION_MODE:"enabled"}),/Unsupported casting activation/);
});

test("optional casting startup failure leaves ordinary office HTTP available without a callback",async t=>{
  const f=await fixture(t), callbackPort=f.runtime.address().port;await f.runtime.close();
  const env={...await environment(f,callbackPort),PLATFORM_API_HOST:"127.0.0.1",
    PLATFORM_API_PORT:String(await freePort()),PLATFORM_API_PUBLIC_ORIGIN:"https://spark.test",
    PLATFORM_APPLIANCE_NODE_ID:SESSION,PLATFORM_CASTING_FAILURE_POLICY:"isolate"};
  // Cold-boot fixture: the optional casting identity is not available yet.
  env.PLATFORM_CASTING_CALLBACK_KEY_FILE += ".missing";
  const server=await startPlatformApi(env,{castingRuntime:{},castingService:f.service,
    identityRepository:new MemoryIdentityRepository()});
  t.after(()=>server.close());
  assert.equal((await fetch(`http://127.0.0.1:${env.PLATFORM_API_PORT}/health/ready`)).status,200);
  await assert.rejects(f.post({port:callbackPort}));
  assert.equal((await fetch(`http://127.0.0.1:${env.PLATFORM_API_PORT}${PAIR}`,{method:"POST"})).status,404);
  const successor=createCastingCallbackRuntime({...f.config,port:callbackPort});await successor.listen();await successor.close();
});

test("occupied private casting port is isolated without releasing or replacing its owner",async t=>{
  const f=await fixture(t),callbackPort=f.runtime.address().port;
  const env={...await environment(f,callbackPort),PLATFORM_API_HOST:"127.0.0.1",
    PLATFORM_API_PORT:String(await freePort()),PLATFORM_API_PUBLIC_ORIGIN:"https://spark.test",
    PLATFORM_APPLIANCE_NODE_ID:SESSION,PLATFORM_CASTING_FAILURE_POLICY:"isolate"};
  const server=await startPlatformApi(env,{castingRuntime:{},castingService:f.service,
    identityRepository:new MemoryIdentityRepository()});t.after(()=>server.close());
  assert.equal((await fetch(`http://127.0.0.1:${env.PLATFORM_API_PORT}/health/ready`)).status,200);
  assert.equal((await f.post({port:callbackPort})).status,200);
});
