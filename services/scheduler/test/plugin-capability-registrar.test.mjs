import assert from "node:assert/strict";
import test from "node:test";

import { SchedulerPluginCapabilityRegistrar } from "../src/plugin-capability-registrar.mjs";

const worker = {
  workerId: "00000000-0000-4000-8000-000000001501",
  nodeId: "00000000-0000-4000-8000-000000001502",
  controlLeaseId: "00000000-0000-4000-8000-000000001503",
  modelProfileId: "00000000-0000-4000-8000-000000001504",
  controlFencingToken: 7,
  generation: 2,
  lifecycleState: "ready",
  health: { state: "healthy" },
};

test("scheduler registrar is the only adapter that receives the in-process authority issuer", async () => {
  const calls = [];
  const authority = { issue(facts) { calls.push(["issue", facts]); return { authority: facts }; } };
  const registrationService = {
    async register(input) { calls.push(["register", input]); return [{ registrationId: "registration-1" }]; },
    async listForScheduler(input) { calls.push(["list", input]); return []; },
    async retireWorker(input) { calls.push(["retire", input]); return { count: 1 }; },
  };
  const registrar = new SchedulerPluginCapabilityRegistrar({ registrationService, schedulerAuthority: authority });
  assert.equal((await registrar.registerReadyWorker({ pluginId: "example.text-transform", worker,
    operations: ["responses", "chat"] }))[0].registrationId, "registration-1");
  assert.deepEqual(calls.find(([kind]) => kind === "register")[1].claims,
    [{ modelProfileId: worker.modelProfileId, operations: ["chat", "responses"] }]);
  assert.deepEqual(await registrar.available(), []);
  assert.equal((await registrar.retireWorker({ workerId: worker.workerId, workerGeneration: 2, worker })).count, 1);
});

test("non-ready, unhealthy, or mismatched retirement facts fail before registration service", async () => {
  const registrar = new SchedulerPluginCapabilityRegistrar({ registrationService: {
    async register() { throw new Error("must not reach service"); }, async listForScheduler() { return []; }, async retireWorker() { throw new Error("must not reach service"); },
  }, schedulerAuthority: { issue() { return {}; } } });
  await assert.rejects(registrar.registerReadyWorker({ pluginId: "example.text-transform",
    worker: { ...worker, lifecycleState: "busy" }, operations: ["chat"] }), TypeError);
  await assert.rejects(registrar.retireWorker({ workerId: worker.workerId, workerGeneration: 3, worker }), TypeError);
});
