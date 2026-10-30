import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProductionCoordinator,
  productionRuntimeConfiguration,
  validateProductionModule,
} from "../../../deploy/runtime/production-service.mjs";

const environment = {
  NODE_ENV: "production",
  TEAMAIBOX_SERVICE_NAME: "messaging",
  TEAMAIBOX_SERVICE_PORT: "8080",
  TEAMAIBOX_REQUIRED_SCHEMA_VERSION: "54",
  TEAMAIBOX_EVENT_BUS_HEALTH_URL: "http://event-bus:8222/healthz?js-enabled-only=true",
};

test("production configuration rejects development mode and non-internal event-bus targets", () => {
  assert.equal(productionRuntimeConfiguration(environment).service, "messaging");
  assert.throws(
    () => productionRuntimeConfiguration({ ...environment, NODE_ENV: "development" }),
    /NODE_ENV=production/,
  );
  assert.throws(
    () => productionRuntimeConfiguration({
      ...environment,
      TEAMAIBOX_EVENT_BUS_HEALTH_URL: "https://example.invalid/healthz",
    }),
    /internal event-bus/,
  );
});

test("every production service binds a real module export", async () => {
  for (const service of [
    "object-service", "scheduler", "plugin-runtime", "agent-bridge",
    "messaging", "source-gateway", "observability",
  ]) {
    const result = await validateProductionModule(service);
    assert.equal(result.service, service);
    assert.ok(result.exports.length > 0);
  }
});

test("readiness requires the exact PostgreSQL migration and JetStream", async () => {
  const probes = [];
  const database = {
    async ready() { probes.push("database-ready"); },
    async query() { probes.push("schema"); return { rows: [{ version: 54 }] }; },
    async close() { probes.push("database-close"); },
  };
  const configuration = productionRuntimeConfiguration(environment);
  const coordinator = await createProductionCoordinator(configuration, environment, {
    databaseFactory: async () => database,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { status: "ok" }; },
    }),
  });
  await coordinator.start();
  assert.equal((await coordinator.readiness()).ready, true);
  await coordinator.stop();
  assert.deepEqual(probes, ["database-ready", "schema", "schema", "database-close"]);
});

test("readiness fails closed on a stale schema", async () => {
  const configuration = productionRuntimeConfiguration(environment);
  const coordinator = await createProductionCoordinator(configuration, environment, {
    databaseFactory: async () => ({
      async ready() {},
      async query() { return { rows: [{ version: 53 }] }; },
      async close() {},
    }),
    fetchImpl: async () => ({ ok: true, async json() { return { status: "ok" }; } }),
    startupTimeoutMs: 5,
    pollIntervalMs: 1,
  });
  await assert.rejects(() => coordinator.start(), /dependency did not become ready/);
});
