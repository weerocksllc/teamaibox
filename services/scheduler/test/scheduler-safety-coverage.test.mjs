import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("./", import.meta.url);
const required = new Set([
  "cold_model_loading",
  "insufficient_memory",
  "fair_share_limits",
  "priority_inversion",
  "cancellation_races",
  "expired_leases",
  "worker_crashes",
  "exclusive_jobs",
  "realtime_batch_coexistence",
  "core_service_reserve",
]);

test("the scheduler safety matrix maps every required scenario to an executable exact test", async () => {
  const coverage = JSON.parse(await readFile(new URL("scenario-coverage.v1.json", root), "utf8"));
  assert.equal(coverage.schemaVersion, 1);
  assert.deepEqual(new Set(coverage.scenarios.map((entry) => entry.key)), required);
  assert.equal(new Set(coverage.scenarios.map((entry) => entry.key)).size, coverage.scenarios.length);
  for (const scenario of coverage.scenarios) {
    assert.match(scenario.file, /^[a-z][a-z0-9-]*\.test\.mjs$/);
    assert.equal(typeof scenario.test, "string");
    assert.ok(scenario.test.length >= 16 && scenario.test.length <= 160);
    const source = await readFile(new URL(scenario.file, root), "utf8");
    assert.ok(
      source.includes(`test(${JSON.stringify(scenario.test)}`),
      `${scenario.key} does not point to an exact executable test name`,
    );
  }
});
