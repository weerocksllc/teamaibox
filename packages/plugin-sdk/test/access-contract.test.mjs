import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/access-v1.d.ts", import.meta.url), "utf8");

test("public SDK distinguishes delegated ApplicationPlugin access from scheduler registration", () => {
  assert.match(source, /ApplicationPluginDelegationV1/);
  assert.match(source, /taibp_v1_/);
  assert.match(source, /ComputeWorkerCapabilityClaimV1/);
  assert.match(source, /Only the scheduler can turn it into a registry entry/);
  const compute = source.slice(source.indexOf("export interface ComputeWorkerCapabilityClaimV1"));
  assert.equal(/token|endpoint|nodeId|gpuId/i.test(compute), false);
  assert.equal(source.includes("registerCapability("), false);
});
