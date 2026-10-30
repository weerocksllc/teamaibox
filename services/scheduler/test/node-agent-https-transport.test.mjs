import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import {PassThrough} from 'node:stream';

import { NodeAgentHttpsTransport } from "../src/node-agent-https-transport.mjs";

const certificate = Buffer.from("certificate-material-for-test-000000000000000000000000");

test('computer and Android binary tunnels retain exact TLS identity, selected endpoint and cancellation',async()=>{
  for(const kind of ['rdp','console','audio','adb']){
    let observed;const socket=new PassThrough();socket.setTimeout=()=>socket;
    const fingerprint=`sha256:${createHash('sha256').update(certificate).digest('hex')}`;
    const transport=new NodeAgentHttpsTransport({host:'10.64.0.23',expectedServerName:'auxiliary.local',expectedCertificateFingerprint:fingerprint,
      ca:Buffer.alloc(64,1),certificate:Buffer.alloc(64,2),privateKey:Buffer.alloc(64,3),checkServerIdentityImplementation:()=>undefined,
      requestImplementation(options){observed=options;const req=new EventEmitter();req.destroy=()=>{};
        req.end=()=>queueMicrotask(()=>req.emit('upgrade',{statusCode:101,headers:{upgrade:kind==='adb'?'teamaibox-adb':'teamaibox-computer'}},socket,Buffer.from([0,255])));return req;}});
    const controller=new AbortController(),args={body:'{}',headers:{'x-teamaibox-key-id':'key','x-teamaibox-nonce':'nonce','x-teamaibox-signature':'signature'},signal:controller.signal,kind};
    const opened=await (kind==='adb'?transport.openPhoneADB(args):transport.openComputerDesktop(args));
    assert.equal(observed.path,kind==='adb'?'/v1/phone-media/adb':'/v1/computer-desktop/'+kind);
    assert.equal(observed.rejectUnauthorized,true);assert.equal(observed.minVersion,'TLSv1.3');assert.equal(observed.agent,false);
    assert.equal(observed.checkServerIdentity('auxiliary.local',{raw:certificate}),undefined);
    assert.ok(observed.checkServerIdentity('auxiliary.local',{raw:Buffer.from('wrong certificate')}));
    assert.deepEqual(opened.read(),Buffer.from([0,255]));controller.abort();assert.equal(opened.destroyed,true);transport.close();
  }
});

test("HTTPS transport requires TLS 1.3, mTLS, exact pin, and a bounded JSON response", async () => {
  let observed;
  const requestImplementation = (options, callback) => {
    observed = options;
    const outgoing = new EventEmitter(); outgoing.end = () => {
      const incoming = new EventEmitter(); incoming.statusCode = 200; incoming.destroy = (error) => incoming.emit("error", error);
      callback(incoming); incoming.emit("data", Buffer.from('{"status":"succeeded"}')); incoming.emit("end");
    }; return outgoing;
  };
  const fingerprint = `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
  const transport = new NodeAgentHttpsTransport({ host: "10.64.0.18", expectedServerName: "spark-worker-02.local",
    expectedCertificateFingerprint: fingerprint, ca: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), privateKey: Buffer.alloc(64, 3),
    requestImplementation, checkServerIdentityImplementation: () => undefined });
  assert.deepEqual(await transport.postCommand({ path: "/v1/commands", body: "{}", headers: { "content-type": "application/json" },
    timeoutMilliseconds: 600_000 }), { status: "succeeded" });
  assert.equal(observed.minVersion, "TLSv1.3"); assert.equal(observed.maxVersion, "TLSv1.3");
  assert.equal(observed.rejectUnauthorized, true);
  assert.equal(observed.timeout, 600_000);
  assert.equal(observed.checkServerIdentity("spark-worker-02.local", { raw: certificate }), undefined);
  assert.match(observed.checkServerIdentity("spark-worker-02.local", { raw: Buffer.from("other-certificate") }).message, /fingerprint/);
});

test("certificate overlap accepts exactly the frozen old or successor pin", async () => {
  let observed;
  const oldRaw = Buffer.from("old-certificate-material-for-overlap");
  const nextRaw = Buffer.from("next-certificate-material-for-overlap");
  const pins = [oldRaw, nextRaw].map((raw) => `sha256:${createHash("sha256").update(raw).digest("hex")}`);
  const transport = new NodeAgentHttpsTransport({ host: "10.64.0.19", expectedServerName: "auxiliary.local",
    expectedCertificateFingerprints: pins, ca: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), privateKey: Buffer.alloc(64, 3),
    checkServerIdentityImplementation: () => undefined,
    requestImplementation(options, callback) {
      observed = options;
      const outgoing = new EventEmitter(); outgoing.end = () => {
        const incoming = new EventEmitter(); incoming.statusCode = 200; incoming.destroy = (error) => incoming.emit("error", error);
        callback(incoming); incoming.emit("data", Buffer.from('{"status":"succeeded"}')); incoming.emit("end");
      }; return outgoing;
    } });
  await transport.postCommand({ path: "/v1/commands", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(observed.checkServerIdentity("auxiliary.local", { raw: oldRaw }), undefined);
  assert.equal(observed.checkServerIdentity("auxiliary.local", { raw: nextRaw }), undefined);
  assert.match(observed.checkServerIdentity("auxiliary.local", { raw: Buffer.from("other") }).message, /fingerprint/);
  transport.close();
});

test("HTTPS transport permits a bounded protected-set cold-start window beyond ten minutes", async () => {
  const raw = Buffer.from("node-agent-cert");
  const fingerprint = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  let timeout;
  const transport = new NodeAgentHttpsTransport({
    host: "127.0.0.1", port: 9443, expectedServerName: "spark-local",
    expectedCertificateFingerprint: fingerprint,
    ca: Buffer.alloc(32, 1), certificate: Buffer.alloc(32, 2), privateKey: Buffer.alloc(32, 3),
    requestImplementation(options, callback) {
      timeout = options.timeout;
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from('{"status":"succeeded"}'));
        response.emit("end");
      });
      const request = new EventEmitter();
      request.end = () => {};
      return request;
    },
    checkServerIdentityImplementation: (_name, certificate) => certificate.raw.equals(raw) ? undefined : new Error("bad cert"),
  });
  await transport.postCommand({ path: "/v1/commands", body: "{}", headers: { "content-type": "application/json" },
    timeoutMilliseconds: 1_002_000 });
  assert.equal(timeout, 1_002_000);
  transport.close();
});
