import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ManagedNodePhoneRuntime } from "../src/virtual-phones/managed-node-phone-runtime.mjs";
import { PHONE_SPEC } from "../src/virtual-phones/contracts.mjs";

function fixture() {
  const node = { nodeId: randomUUID(), nodeGeneration: 7, imageDigest: `sha256:${"a".repeat(64)}`, poolId: "phones-luks", maximumPhones: 2 };
  const phone = { id: randomUUID(), ownerId: randomUUID(), volumeId: randomUUID(), poolId: node.poolId, nodeId: node.nodeId,
    baseBuildId: PHONE_SPEC.buildId, specId: PHONE_SPEC.id, storageBytes: PHONE_SPEC.storageBytes, generation: 1, name: "private name" };
  const run = { id: randomUUID(), reservationId: randomUUID(), phoneId: phone.id, ownerId: phone.ownerId,
    nodeId: node.nodeId, nodeGeneration: node.nodeGeneration, imageDigest: node.imageDigest,
    generation: 1, memoryBytes: PHONE_SPEC.memoryBytes, cpuMillis: PHONE_SPEC.cpuMillis };
  const calls = [], revocations = [];
  const dependencies = { approvedNodes: [node], nodeAgentRouter: {
    async resolvePhoneNode(){return {nodeId:node.nodeId,nodeGeneration:node.nodeGeneration};}, async executePhoneCommand(request) {
    calls.push(request); const { run, ...identity } = request.payload;
    const action = request.action;
    return { ...identity, ...(run ? { runId: run.id } : {}), ...(action === "start" ? { containerId: "b".repeat(64) } : {}),
      storageReady: action !== "delete", runtimeStopped: action !== "start", androidReady: action === "start",
      mediaReady: action === "start", cleanShutdown: action === "stop", dataDeleted: action === "delete" };
  } }, accessRevoker: { async revokePhoneAccess(request) {
    revocations.push(request); return { accessRevoked: true, phoneId: request.phoneId, runId: request.runId };
  } } };
  return { phone, run, node, calls, revocations, dependencies, runtime: new ManagedNodePhoneRuntime(dependencies) };
}
test("phone runtime projects persisted identities only and preserves operation across retries", async () => {
  const f = fixture(), operationId = randomUUID();
  const input = { phone: f.phone, run: f.run, operationId };
  await f.runtime.start(input); await f.runtime.start(input);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[0].payload.run.id, f.run.id); assert.equal(f.calls[0].payload.operationId, operationId);
  assert.equal(f.calls[0].payload.name, undefined); assert.equal(f.calls[0].payload.nodeId, undefined);
  assert.equal(f.calls[0].nodeGeneration, 7);
  const stop = await f.runtime.stop(input); assert.equal(stop.runtimeStopped, true);
});
test("phone runtime requires real revocation integration, and validates revocation outcome", async () => {
  const f = fixture();
  assert.throws(() => new ManagedNodePhoneRuntime({ ...f.dependencies, accessRevoker: null }), TypeError);
  const loginSessionId = randomUUID();
  await f.runtime.revokeAccess({ phone: f.phone, run: f.run, loginSessionId, reason: "sign_out" });
  assert.equal(f.revocations[0].loginSessionId, loginSessionId);
  assert.equal(f.revocations[0].ownerId, f.phone.ownerId);
  f.dependencies.accessRevoker.revokePhoneAccess = async () => ({ accessRevoked: false });
  await assert.rejects(f.runtime.revokeAccess({ phone: f.phone, run: f.run }), { code: "phone_grant_invalid" });
  assert.equal(f.calls.length, 0);
});
test("phone runtime rejects owner, run, storage, node generation and resource substitution before transport", async () => {
  const f = fixture();
  for (const mutation of [{ ownerId: randomUUID() }, { phoneId: randomUUID() }, { nodeId: randomUUID() },
    { nodeGeneration: 8 }, { generation: 2 }, { imageDigest: `sha256:${"f".repeat(64)}` }, { memoryBytes: 120*1024**3 }, { cpuMillis: 4000 }]) {
    await assert.rejects(f.runtime.start({ phone: f.phone, run: { ...f.run, ...mutation }, operationId: randomUUID() }), { code: "phone_stale_run" });
  }
  await assert.rejects(f.runtime.start({ phone: { ...f.phone, poolId: "lab-unencrypted" }, run: f.run, operationId: randomUUID() }), { code: "phone_node_unavailable" });
  assert.equal(f.calls.length, 0);
});
test("runtime and admission share one installed declaration without an invented two-phone cap", () => {
  const f=fixture();
  assert.doesNotThrow(()=>new ManagedNodePhoneRuntime({...f.dependencies,approvedNodes:[{...f.node,maximumPhones:3}]}));
  assert.doesNotThrow(()=>new ManagedNodePhoneRuntime({...f.dependencies,approvedNodes:[{...f.node,maximumPhones:null}]}));
  for (const nodes of [[{...f.node,maximumPhones:0}],[{...f.node,hostPath:"/"}],
    [{...f.node,nodeGeneration:0}],[f.node,f.node],Array(257).fill(f.node),[{...f.node,maximumPhones:undefined}]]) {
    assert.throws(()=>new ManagedNodePhoneRuntime({...f.dependencies,approvedNodes:nodes}),TypeError);
  }
});
test("provision and deletion do not pass a run or a caller-selected path", async () => {
  const f = fixture(); const operationId = randomUUID();
  assert.equal((await f.runtime.provision({ phone: { ...f.phone, generation: 0 }, operationId })).storageReady, true);
  assert.equal((await f.runtime.deleteData({ phone: f.phone, operationId })).dataDeleted, true);
  assert.equal(f.calls[0].payload.run, undefined); assert.equal(f.calls[1].payload.run, undefined);
  assert.deepEqual(Object.keys(f.calls[1].payload).sort(), ["phoneId", "ownerId", "volumeId", "poolId", "baseBuildId", "operationId", "generation"].sort());
});

test("fresh authority can inspect and control the same old run without rewriting its identity", async () => {
  const f=fixture();f.node.nodeGeneration=8;
  await f.runtime.provision({phone:{...f.phone,generation:0},operationId:randomUUID()});
  assert.equal(f.calls[0].nodeGeneration,8);
  for (const method of ['inspect','start','stop']) {
    await f.runtime[method]({phone:f.phone,run:f.run,operationId:randomUUID()});
    assert.equal(f.calls.at(-1).nodeGeneration,8);
    assert.equal(f.calls.at(-1).payload.run.id,f.run.id);
    assert.equal(f.calls.at(-1).payload.run.reservationId,f.run.reservationId);
  }
  assert.equal(f.run.nodeGeneration,7);
  await assert.rejects(f.runtime.inspect({phone:f.phone,run:{...f.run,nodeGeneration:9},operationId:randomUUID()}),{code:'phone_stale_run'});
});
