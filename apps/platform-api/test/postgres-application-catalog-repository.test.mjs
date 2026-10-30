import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresApplicationCatalogRepository } from "../src/applications/postgres-application-catalog-repository.mjs";

test("local application health uses the enrolled node's live observations, not fixture rows", async () => {
  const nodeId = "ad1fc10b-9812-41cc-a559-8e8a19d00001";
  let health;
  await new PostgresApplicationCatalogRepository({ localNodeId: nodeId, database: { async query(sql, values) {
    if (sql.includes('FROM platform.health_signals')) health = { sql, values };
    return { rows: [] };
  } } }).snapshot();
  assert.deepEqual(health.values, [nodeId]);
  assert.match(health.sql, /starts_with\(target_key,\$1::text \|\| '\/'\)/);
  assert.match(health.sql, /substring\(target_key FROM length\(\$1::text\)\+2\)/);
  assert.match(health.sql, /observed_at >= statement_timestamp\(\)-interval '120 seconds'/);
  assert.throws(() => new PostgresApplicationCatalogRepository({ database: { query() {} }, localNodeId: 'developer-box' }));
});

test("single-application authorization reads only plugin tables and binds the requested key", async () => {
  const calls = [];
  const repository = new PostgresApplicationCatalogRepository({ database: { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ plugin_key: "official.ocr", plugin_type: "application", lifecycle_state: "enabled",
      current_version: "1.0.0", manifest: {}, install_state: "healthy", active_slot: "blue", slot_state: "active" }] };
  } } });
  assert.equal((await repository.getApplication("official.ocr")).pluginKey, "official.ocr");
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].values, ["official.ocr"]);
  assert.doesNotMatch(calls[0].sql, /compute\.|health_signals/);
  assert.match(calls[0].sql, /WHERE plugin.plugin_key=\$1/);
});

test("reads plugin, route-capability, and latest health facts without mutable process state", async () => {
  const calls = [];
  const database = { async query(sql) {
    calls.push(sql);
    if (sql.includes("FROM plugins.plugins")) return { rows: [{
      plugin_key: "official.ocr", plugin_type: "application", lifecycle_state: "enabled",
      current_version: "1.0.0", manifest: { entryPoints: {} }, install_state: "healthy",
      active_slot: "blue", slot_state: "active", slot_health: { healthy: true }, slot_updated_at: new Date("2026-08-12T00:00:00Z"),
    }] };
    if (sql.includes("FROM compute.capabilities")) return { rows: [{ capability_key: "ocr", certified: true, eligible: true, experimental: false, local_route: true, provider_route: false, local_routable_profiles: ["ocr.nvfp4"], provider_routable_profiles: [], local_actually_routable_profiles: ["ocr.nvfp4"], provider_actually_routable_profiles: [], certified_profiles: ["ocr.nvfp4"], experimental_profiles: [], selected_profile: "ocr.nvfp4", selected_certification_state: "certified" }] };
    return { rows: [{ target_kind: "core_service", target_key: "object-service", health_state: "healthy", reason_code: null, observed_at: new Date("2026-08-12T00:00:00Z") }] };
  } };
  const result = await new PostgresApplicationCatalogRepository({ database }).snapshot();
  assert.equal(calls.length, 3);
  assert.equal(result.plugins[0].pluginKey, "official.ocr");
  assert.deepEqual(result.capabilities[0].certifiedProfiles, ["ocr.nvfp4"]);
  assert.equal(result.capabilities[0].eligible, true);
  assert.equal(result.capabilities[0].selectedProfile, "ocr.nvfp4");
  assert.equal(result.capabilities[0].selectedCertificationState, "certified");
  assert.deepEqual(result.capabilities[0].localRoutableProfiles, ["ocr.nvfp4"]);
  assert.deepEqual(result.capabilities[0].providerRoutableProfiles, []);
  assert.deepEqual(result.capabilities[0].localActuallyRoutableProfiles, ["ocr.nvfp4"]);
  assert.deepEqual(result.capabilities[0].providerActuallyRoutableProfiles, []);
  assert.ok(calls.some((sql) => sql.includes("selected_routes")));
  assert.ok(calls.some((sql) => sql.includes("model_experimental_routing_opt_ins")));
  assert.ok(calls.some((sql) => sql.includes("model_capability_bindings")));
  assert.ok(calls.some((sql) => sql.includes("model_capability_binding_opt_ins")));
  assert.equal(result.health[0].state, "healthy");
  assert.ok(calls.some((sql) => sql.includes("provider_model_profiles")));
  assert.ok(calls.some((sql) => sql.includes("local_routable_profiles")));
  assert.ok(calls.some((sql) => sql.includes("provider_routable_profiles")));
  assert.ok(calls.some((sql) => sql.includes("local_actually_routable_profiles")));
  assert.ok(calls.some((sql) => sql.includes("provider_actually_routable_profiles")));
  assert.ok(calls.some((sql) => sql.includes("worker.lifecycle_state IN ('ready','busy')")));
  assert.ok(calls.some((sql) => sql.includes("provider.lifecycle_state='healthy'")));
  assert.ok(calls.some((sql) => sql.includes("provider.health->>'loaded'='true'")));
  // A healthy managed on-demand endpoint is usable before its model is loaded;
  // still require its explicit node binding and a fresh, ready enrolled node.
  assert.ok(calls.some((sql) => sql.includes("provider.provider_kind='external_openai'")));
  assert.equal(calls.some((sql) => sql.includes('residency_node')), false);
  assert.ok(calls.some((sql) => sql.includes("jsonb_array_elements_text(mapping.operations)")));
  assert.ok(calls.some((sql) => sql.includes("capability.capability_key='translation' AND operation='chat.completions'")));
  assert.ok(calls.some((sql) => sql.includes("DISTINCT ON (target_kind,target_key)")));
  const healthQuery = calls.find((sql) => sql.includes('FROM platform.health_signals'));
  // A per-row volatile clock forces a historical table scan on each page load.
  // A statement-stable cutoff uses the existing observed_at index while still
  // excluding stale health at the start of this request (not a cached result).
  assert.match(healthQuery, /observed_at >= statement_timestamp\(\)-interval '120 seconds'/);
  assert.doesNotMatch(healthQuery, /clock_timestamp/);
});
