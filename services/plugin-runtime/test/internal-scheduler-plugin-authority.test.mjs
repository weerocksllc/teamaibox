import assert from "node:assert/strict";
import test from "node:test";

import { InternalSchedulerPluginAuthority } from "../src/internal-scheduler-plugin-authority.mjs";

const facts = {
  workerId: "00000000-0000-7000-8000-000000001201",
  nodeId: "00000000-0000-7000-8000-000000001202",
  leaseId: "00000000-0000-7000-8000-000000001203",
  fencingToken: 8,
  workerGeneration: 3,
};

test("only an in-process scheduler authority object verifies", async () => {
  const authority = new InternalSchedulerPluginAuthority();
  const issued = authority.issue(facts);
  assert.deepEqual(await authority.verify(issued), facts);
  for (const untrusted of [facts, structuredClone(facts), { marker: Symbol(), facts }]) {
    await assert.rejects(authority.verify(untrusted), /scheduler authority rejected/);
  }
});

test("plugin lifecycle authority is unforgeable and restricted to its exact plugin revocation", async () => {
  const authority = new InternalSchedulerPluginAuthority();
  const lifecycleFacts = { pluginId: "example.team-notes", pluginGeneration: 7 };
  const issued = authority.issuePluginLifecycle(lifecycleFacts);
  assert.deepEqual(await authority.verify(issued, {
    operation: "revoke-plugin-delegations",
    pluginId: "example.team-notes",
  }), lifecycleFacts);
  await assert.rejects(authority.verify(issued), /scheduler authority rejected/);
  await assert.rejects(authority.verify(issued, {
    operation: "revoke-plugin-delegations",
    pluginId: "example.other-plugin",
  }), /scheduler authority rejected/);
  await assert.rejects(authority.verify(issued, { operation: "list-compute-capabilities" }), /scheduler authority rejected/);
  await assert.rejects(authority.verify({ facts: lifecycleFacts }, {
    operation: "revoke-plugin-delegations",
    pluginId: "example.team-notes",
  }), /scheduler authority rejected/);
});
