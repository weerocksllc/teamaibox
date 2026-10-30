import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { VirtualPhoneService } from "../src/virtual-phones/virtual-phone-service.mjs";

function fixture() {
  const ownerId = randomUUID(), phones = Array.from({ length: 2 }, () => ({ id: randomUUID(), ownerId, generation: 1,
    revision: 4, state: "running", runningCharged: true }));
  const runs = new Map(phones.map(p => [p.id, { id: randomUUID(), generation: 1 }]));
  const queued = [], observed = [], state = new Map();
  const repository = { requestCreate() {}, completeOperation() {},
    async chargedOwners() { return [ownerId]; }, async list(id) { assert.equal(id, ownerId); return phones; },
    async currentRun(id, phoneId) { assert.equal(id, ownerId); return runs.get(phoneId); },
    async requestAction(request) { queued.push(request); if (queued.length > 1) throw Object.assign(new Error(), { code: "phone_operation_conflict" }); } };
  const runtime = { provision() {}, start() {}, stop() {}, deleteData() {}, revokeAccess() {},
    async inspect({ phone, run, operationId }) {
      assert.equal(operationId, run.id); observed.push(phone.id);
      const response = state.get(phone.id);
      if (response instanceof Error) throw response;
      return { runId: run.id, generation: run.generation, runtimeStopped: false, ...response };
    } };
  const capacity = { placement() {}, acquireRun() {}, status() {}, releaseRun() { assert.fail("inspection must not release"); } };
  const service = new VirtualPhoneService({ repository, runtime, capacity, directory: { authorization() {} }, policy: { enabled: true } });
  return { service, phones, runs, queued, state, observed };
}

test("confirmed node-side stop becomes a durable normal stop operation, not a blind resource release", async () => {
  const f = fixture(), p = f.phones[0];
  f.state.set(p.id, { runtimeStopped: true, protectionReason: "memory_margin" });
  assert.deepEqual(await f.service.reconcileRuntime(), { checked: 2, stopping: 1 });
  assert.deepEqual(f.queued[0], { ownerId: p.ownerId, phoneId: p.id, action: "stop", input: { expectedRevision: p.revision },
    key: `reconcile-${f.runs.get(p.id).id}-${p.revision}`, policy: (await import("../src/virtual-phones/contracts.mjs")).validatePolicy({ enabled: true }), allowInactive: true });
  assert.equal(p.runningCharged, true);
  assert.deepEqual(await f.service.reconcileRuntime(), { checked: 2, stopping: 0 });
});
test("unreachable, changed-run and malformed stop observations keep resources and do not block another phone", async () => {
  for (const bad of [Object.assign(new Error(), { code: "phone_node_unavailable" }), { runtimeStopped: true, runId: randomUUID() },
    { runtimeStopped: true, generation: 2 }, { runtimeStopped: "true" }]) {
    const f = fixture(); f.state.set(f.phones[0].id, bad); f.state.set(f.phones[1].id, { runtimeStopped: true });
    await f.service.reconcileRuntime(); assert.equal(f.queued.length, 1); assert.equal(f.queued[0].phoneId, f.phones[1].id);
    assert.ok(f.phones.every(p => p.runningCharged));
  }
});
test("ongoing lifecycle work and stopped phones are not inspected or raced by reconciliation", async () => {
  const f = fixture(); f.phones[0].state = "starting"; f.phones[1].runningCharged = false;
  assert.deepEqual(await f.service.reconcileRuntime(), { checked: 0, stopping: 0 });
  assert.deepEqual(f.observed, []);
});
