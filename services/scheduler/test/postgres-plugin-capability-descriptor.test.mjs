import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPluginCapabilityDescriptorResolver } from "../src/postgres-plugin-capability-descriptor.mjs";

const pluginId = "00000000-0000-7000-8000-000000001401";
const profileId = "00000000-0000-7000-8000-000000001402";

test("PostgreSQL resolver binds an enabled verified ComputePlugin to sorted profile operations", async () => {
  let captured;
  const resolver = new PostgresPluginCapabilityDescriptorResolver({ database: { async query(sql, values) {
    captured = [sql, values];
    return { rows: [{ plugin_key: "example.text-transform", api_operations: ["responses", "chat.completions"] }] };
  } } });
  assert.deepEqual(await resolver.resolve({ computePluginId: pluginId, modelProfileId: profileId }), {
    pluginId: "example.text-transform", operations: ["chat.completions", "responses"],
  });
  assert.deepEqual(captured[1], [pluginId, profileId]);
  assert.match(captured[0], /plugin\.plugin_type = 'compute'/);
  assert.match(captured[0], /plugin\.lifecycle_state = 'enabled'/);
  assert.match(captured[0], /version\.supply_chain_state = 'verified'/);
  assert.match(captured[0], /capability\.lifecycle_state = 'active'/);
});

test("PostgreSQL resolver fails closed for missing or malformed capability facts", async () => {
  const missing = new PostgresPluginCapabilityDescriptorResolver({ database: { async query() { return { rows: [] }; } } });
  assert.equal(await missing.resolve({ computePluginId: pluginId, modelProfileId: profileId }), null);
  const malformed = new PostgresPluginCapabilityDescriptorResolver({ database: { async query() {
    return { rows: [{ plugin_key: "example.text-transform", api_operations: ["valid.operation", "bad operation"] }] };
  } } });
  assert.equal(await malformed.resolve({ computePluginId: pluginId, modelProfileId: profileId }), null);
  await assert.rejects(missing.resolve({ computePluginId: "plugin", modelProfileId: profileId }), /identity is invalid/);
});
