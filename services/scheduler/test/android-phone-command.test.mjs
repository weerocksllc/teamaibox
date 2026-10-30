import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validateAndroidPhoneCommand, validateAndroidPhoneResult } from "../src/android-phone-command.mjs";
import { ProtectedNodeAgentClient } from "../src/protected-node-agent-client.mjs";
import { ManagedNodeAgentRouter } from "../src/managed-node-agent-router.mjs";

const NODE = "00000000-0000-4000-8000-000000000101";
function payload() { return { phoneId: randomUUID(), ownerId: randomUUID(), volumeId: randomUUID(), operationId: randomUUID(),
  poolId: "phones-luks", baseBuildId: "16102939", generation: 1,
  run: { id: randomUUID(), reservationId: randomUUID(), imageDigest: `sha256:${"a".repeat(64)}`, memoryBytes: 6*1024**3, cpuMillis: 2000 } }; }
function reply(p, action = "start") {
  const { run, ...identity } = p;
  return { ...identity, ...(run ? { runId: run.id } : {}), ...(action === "start" ? { containerId: "b".repeat(64) } : {}),
    storageReady: action !== "delete", androidReady: action === "start", mediaReady: action === "start",
    runtimeStopped: action !== "start", cleanShutdown: action === "stop", dataDeleted: action === "delete" };
}
test("phone commands close all client-selected runtime options and fix resources", () => {
  const p = payload(); assert.deepEqual(validateAndroidPhoneCommand("start", p), p);
  for (const key of ["hostPath", "command", "devices", "network", "docker", "privileged", "url"]) {
    assert.throws(() => validateAndroidPhoneCommand("start", { ...p, [key]: "/host" }), TypeError);
  }
  for (const run of [{ ...p.run, memoryBytes: p.run.memoryBytes + 1 }, { ...p.run, cpuMillis: 1 },
    { ...p.run, imageDigest: "latest" }, { ...p.run, ownerId: p.ownerId }]) {
    assert.throws(() => validateAndroidPhoneCommand("start", { ...p, run }), TypeError);
  }
  assert.throws(() => validateAndroidPhoneCommand("shell", p), TypeError);
  assert.throws(() => validateAndroidPhoneCommand("provision", p), TypeError);
  const { run, ...creation } = p; creation.generation = 0;
  assert.deepEqual(validateAndroidPhoneCommand("provision", creation), creation);
  assert.throws(() => validateAndroidPhoneCommand("delete", { ...creation, run: null }), TypeError);
});
test("phone results bind identity and readiness, never accepting a process as a ready Android", () => {
  const p = payload(), value = reply(p);
  assert.deepEqual(validateAndroidPhoneResult("start", p, value), value);
  for (const mutation of [{ ownerId: randomUUID() }, { runId: randomUUID() }, { operationId: randomUUID() }, { generation: 2 },
    { androidReady: false }, { mediaReady: false }, { runtimeStopped: true }, { containerId: "running" }, { url: "https://other" }]) {
    assert.throws(() => validateAndroidPhoneResult("start", p, { ...value, ...mutation }), { code: "node_agent_protocol_mismatch" });
  }
  assert.throws(() => validateAndroidPhoneResult("stop", p, value), { code: "node_agent_protocol_mismatch" });
  assert.equal(validateAndroidPhoneResult("stop", p, reply(p, "stop")).runtimeStopped, true);
  for (const reason of ["memory_margin", "memory_pressure", "swap_out"]) {
    const result = { ...reply(p, "stop"), protectionReason: reason };
    assert.equal(validateAndroidPhoneResult("stop", p, result).protectionReason, reason);
  }
  for (const reason of ["", "all_workers_stopped", null, {}, 42]) {
    assert.throws(() => validateAndroidPhoneResult("stop", p, { ...reply(p, "stop"), protectionReason: reason }), { code: "node_agent_protocol_mismatch" });
  }
});
test("phone commands use existing signed transport and phone-scoped generation fences", async () => {
  const posted = [], signed = [];
  let alter = false;
  const client = new ProtectedNodeAgentClient({ nodeId: NODE, nodeGeneration: 7,
    commandSigner: { async sign(request) { signed.push(request); return { keyId: "scheduler-a", nonce: "nonce-phone-test", signature: "fixture" }; } },
    workerSpecFactory: { buildStartPayload() { throw Error("must not build generic worker"); } },
    transport: { async postCommand(request) {
      posted.push(request); const e = JSON.parse(request.body);
      return { commandId: e.commandId, nodeId: NODE, nodeGeneration: 7, fencingToken: e.fencingToken, status: "succeeded",
        payload: { ...reply(e.payload), ...(alter ? { runId: randomUUID() } : {}) } };
    } },
  });
  const p = payload(); const result = await client.executePhoneCommand({ action: "start", payload: p, correlationId: "phone:protocol-test" });
  assert.equal(result.runId, p.run.id);
  const envelope = JSON.parse(posted[0].body);
  assert.equal(envelope.type, "android-phone.start"); assert.equal(envelope.leaseId, p.phoneId);
  assert.equal(envelope.fencingToken, p.generation + 1); assert.deepEqual(envelope.payload, p);
  assert.equal(signed[0].body, posted[0].body); assert.equal(posted[0].timeoutMilliseconds, 600_000);
  assert.equal(posted[0].maximumResponseBytes, 16 << 10);
  alter = true;
  await assert.rejects(client.executePhoneCommand({ action: "start", payload: p, correlationId: "phone:protocol-test" }), { code: "node_agent_protocol_mismatch" });
  await assert.rejects(client.executePhoneCommand({ action: "start", payload: { ...p, devices: ["/dev/kvm"] }, correlationId: "phone:protocol-test" }), TypeError);
  assert.equal(posted.length, 2);
});
test("phone routing uses registered node certificate, refuses starts while draining, permits exact stop", async () => {
  const node = { nodeId: NODE, nodeKey: "spark-phone-aux", generation: 7, lifecycleState: "ready", certificateFingerprint: `sha256:${"c".repeat(64)}` };
  const routes = []; let calls = 0, closes = 0;
  const router = new ManagedNodeAgentRouter({ localNodeId: NODE, nodeRepository: { async findNode() { return node; } },
    async connectorFactory(route) { routes.push(route); return {
      startWorker() {}, workerHealth() {}, workerControl() {}, stopWorker() {},
      async executePhoneCommand({ action, payload }) { calls++; return reply(payload, action); }, close() { closes++; },
    }; } });
  const p = payload(); const request = { nodeId: NODE, nodeGeneration: 7, action: "start", payload: p };
  await router.executePhoneCommand(request);
  assert.equal(routes[0].expectedServerName, node.nodeKey);
  assert.equal(routes[0].expectedCertificateFingerprint, node.certificateFingerprint);
  node.lifecycleState = "draining";
  await assert.rejects(router.executePhoneCommand(request), { code: "managed_node_not_ready" });
  await router.executePhoneCommand({ ...request, action: "stop" });
  await router.executePhoneCommand({ ...request, nodeGeneration: 6, action: "stop" });
  assert.equal(routes.at(-1).nodeGeneration,7);
  await assert.rejects(router.executePhoneCommand({ ...request, nodeGeneration: 8, action: "stop" }), { code: "stale_node_generation" });
  assert.equal(calls, 3); assert.equal(closes, 3);
});
