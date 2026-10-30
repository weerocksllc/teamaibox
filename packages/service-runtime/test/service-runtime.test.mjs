import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import {
  StartupCoordinator,
  createHealthHandler,
  loadServiceRuntimeConfiguration,
} from "../src/index.mjs";

test("starts dependencies in order and stops them in reverse order", async () => {
  const events = [];
  const coordinator = new StartupCoordinator();
  coordinator.register({
    name: "platform-api",
    dependsOn: ["postgres", "event-bus"],
    start: async () => events.push("start:api"),
    check: async () => true,
    stop: async () => events.push("stop:api"),
  });
  coordinator.register({
    name: "event-bus",
    dependsOn: ["postgres"],
    start: async () => events.push("start:nats"),
    check: async () => true,
    stop: async () => events.push("stop:nats"),
  });
  coordinator.register({
    name: "postgres",
    start: async () => events.push("start:postgres"),
    check: async () => true,
    stop: async () => events.push("stop:postgres"),
  });

  await coordinator.start();
  assert.equal(coordinator.state, "running");
  assert.deepEqual(events, ["start:postgres", "start:nats", "start:api"]);
  assert.equal((await coordinator.readiness()).ready, true);
  coordinator.beginDrain();
  assert.equal((await coordinator.readiness()).reason, "draining");
  await coordinator.stop();
  assert.deepEqual(events.slice(3), ["stop:api", "stop:nats", "stop:postgres"]);
});

test("rolls back started components when a dependency never becomes ready", async () => {
  const events = [];
  const coordinator = new StartupCoordinator();
  coordinator.register({
    name: "postgres",
    start: async () => events.push("start:postgres"),
    check: async () => ({ ready: false, reason: "database_recovery" }),
    stop: async () => events.push("stop:postgres"),
    startupTimeoutMs: 15,
    probeTimeoutMs: 5,
    pollIntervalMs: 2,
  });
  coordinator.register({
    name: "platform-api",
    dependsOn: ["postgres"],
    start: async () => events.push("start:api"),
  });

  await assert.rejects(coordinator.start(), (error) => error.code === "dependency_not_ready");
  assert.equal(coordinator.state, "failed");
  assert.deepEqual(events, ["start:postgres", "stop:postgres"]);
  const readiness = await coordinator.readiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "dependency_not_ready");
});

test("rejects missing dependencies and cycles before starting", async () => {
  const missing = new StartupCoordinator();
  missing.register({ name: "platform-api", dependsOn: ["postgres"] });
  await assert.rejects(missing.start(), (error) => error.code === "missing_dependency");

  const cycle = new StartupCoordinator();
  cycle.register({ name: "platform-api", dependsOn: ["event-bus"] });
  cycle.register({ name: "event-bus", dependsOn: ["platform-api"] });
  await assert.rejects(cycle.start(), (error) => error.code === "dependency_cycle");
});

test("serves liveness, startup, and readiness with correlation IDs", async (t) => {
  const coordinator = new StartupCoordinator();
  coordinator.register({ name: "platform-api" });
  const server = http.createServer(createHealthHandler({
    service: "platform-api",
    version: "0.1.0",
    coordinator,
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;

  const live = await fetch(origin + "/health/live", {
    headers: { "x-correlation-id": "request-12345678" },
  });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("x-correlation-id"), "request-12345678");
  assert.equal((await live.json()).status, "ok");

  const before = await fetch(origin + "/health/ready");
  assert.equal(before.status, 503);
  await coordinator.start();
  const ready = await fetch(origin + "/health/ready");
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).components[0].name, "platform-api");
  const missing = await fetch(origin + "/missing");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
});

test("validates the shared runtime environment before startup", () => {
  const value = loadServiceRuntimeConfiguration({
    TEAMAIBOX_SERVICE_NAME: "platform-api",
    TEAMAIBOX_PORT: "8080",
    TEAMAIBOX_VERSION: "0.1.0",
    TEAMAIBOX_SHUTDOWN_GRACE_MS: "15000",
  });
  assert.equal(value.serviceName, "platform-api");
  assert.equal(value.shutdownGraceMs, 15000);
  assert.throws(() => loadServiceRuntimeConfiguration({
    TEAMAIBOX_SERVICE_NAME: "bad service",
    TEAMAIBOX_PORT: "80",
  }), (error) => error.code === "invalid_configuration");
});
