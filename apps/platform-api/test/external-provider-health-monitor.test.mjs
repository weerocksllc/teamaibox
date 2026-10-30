import assert from "node:assert/strict";
import { test } from "node:test";

import { ExternalProviderHealthMonitor } from "../src/providers/external-provider-health-monitor.mjs";

const NOW = new Date("2026-08-24T04:00:00.000Z");

function provider(overrides = {}) {
  return {
    providerId: "11111111-1111-4111-8111-111111111111",
    providerKey: "spark-23-gemma",
    endpoint: "https://provider.test/v1",
    lifecycleState: "healthy",
    auth: { scheme: "bearer", headerName: "Authorization" },
    credentialSecretKey: "provider.auth",
    caSecretKey: "provider.ca",
    trust: { mode: "custom_ca", serverName: "provider.test" },
    contract: { state: "passed" },
    healthCheck: { path: "/models", intervalSeconds: 30, timeoutMilliseconds: 1_000, failureThreshold: 2 },
    health: { state: "healthy", consecutiveFailures: 0 },
    ...structuredClone(overrides),
  };
}

function monitor({ status = 200, providerValue = provider(), transportError = null } = {}) {
  const records = [], secrets = [];
  return {
    records,
    value: new ExternalProviderHealthMonitor({
      repository: {
        async list() { return [providerValue]; },
        async recordHealth(providerId, observation) {
          records.push({ providerId, observation });
          return { ...providerValue, lifecycleState: observation.lifecycleState, health: observation.health };
        },
      },
      secretStore: { async withSecret(name, reader, callback) { secrets.push({ name, reader }); return callback(Buffer.from(name.endsWith("ca") ? "ca" : "credential")); } },
      transport: { async request(input) { if (transportError) throw transportError; return { status, latencyMilliseconds: 17, input }; } },
      clock: () => new Date(NOW),
      intervalMilliseconds: 1_000,
    }),
    secrets,
  };
}

test("refreshes a passed Provider health observation without changing configuration revision", async () => {
  const subject = monitor();
  await subject.value.tick();
  assert.equal(subject.records.length, 1);
  assert.equal(subject.records[0].observation.lifecycleState, "healthy");
  assert.deepEqual(subject.records[0].observation.health, {
    state: "healthy", latencyMilliseconds: 17, errorCode: null, observedAt: NOW, consecutiveFailures: 0,
  });
  assert.equal(subject.secrets.length, 2);
});

test("does not probe a retired auxiliary provider from legacy inventory", async () => {
  const records = [], calls = [];
  const managed = provider({ providerKind: "managed_node", providerKey: "managed.hunyuan" });
  const value = new ExternalProviderHealthMonitor({
    repository: {
      async list() { calls.push("external"); return []; },
      async listRoutable() { calls.push("routable"); return [managed]; },
      async recordHealth(providerId, observation) {
        records.push({ providerId, observation });
        return { ...managed, lifecycleState: observation.lifecycleState, health: observation.health };
      },
    },
    secretStore: { async withSecret(name, reader, callback) { return callback(Buffer.from(name)); } },
    transport: { async request() { return { status: 200, latencyMilliseconds: 4 }; } },
    clock: () => new Date(NOW), intervalMilliseconds: 1_000,
  });
  await value.tick();
  assert.deepEqual(calls, ["routable"]);
  assert.equal(records.length, 0);
});

test("degrades before the failure threshold and becomes unavailable at the threshold", async () => {
  const first = monitor({ status: 503 });
  await first.value.tick();
  assert.equal(first.records[0].observation.lifecycleState, "degraded");
  assert.equal(first.records[0].observation.health.consecutiveFailures, 1);

  const second = monitor({ transportError: Object.assign(new Error("offline"), { code: "provider_timeout" }),
    providerValue: provider({ health: { state: "degraded", consecutiveFailures: 1 } }) });
  await second.value.tick();
  assert.equal(second.records[0].observation.lifecycleState, "unavailable");
  assert.equal(second.records[0].observation.health.errorCode, "provider_timeout");
});

test("native TLS and network failures persist database-safe health error classes", async () => {
  for (const [code, expected] of [
    ["CERT_HAS_EXPIRED", "provider_tls_certificate_expired"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "provider_tls_identity_mismatch"],
    ["ECONNREFUSED", "provider_connection_refused"],
    ["ECONNRESET", "provider_connection_reset"],
    ["ETIMEDOUT", "provider_timeout"],
    ["ENOTFOUND", "provider_dns_failed"],
    ["ABORT_ERR", "provider_request_aborted"],
    ["provider_credential_unavailable", "provider_credential_unavailable"],
    ["constructor", "constructor"],
    ["__proto__", "provider_health_probe_failed"],
    ["untrusted message containing credentials", "provider_health_probe_failed"],
    ["x".repeat(193), "provider_health_probe_failed"],
    [undefined, "provider_health_probe_failed"],
  ]) {
    const subject = monitor({ transportError: Object.assign(new Error("private endpoint and credential"), { code }),
      providerValue: provider({ health: { consecutiveFailures: 1 } }) });
    await subject.value.tick();
    assert.equal(subject.records.length, 1);
    const value = subject.records[0].observation;
    assert.equal(value.lifecycleState, "unavailable");
    assert.equal(value.health.errorCode, expected);
    assert.match(value.health.errorCode, /^[a-z][a-z0-9_:.-]{1,191}$/);
    assert.doesNotMatch(JSON.stringify(value), /private endpoint|credentials/);
  }
});

test("persistence failure reports sanitized facts without canceling other observations", async () => {
  const failures = [], records = [];
  const bad = provider(), good = provider({ providerId: "22222222-2222-4222-8222-222222222222" });
  const value = new ExternalProviderHealthMonitor({
    repository: {
      async list() { return [bad, good]; },
      async recordHealth(id, observation) {
        if (id === bad.providerId) throw Object.assign(new Error("private SQL and parameters"), { code: "23514" });
        records.push(id); return { ...good, health: observation.health };
      },
    },
    secretStore: { async withSecret(name, reader, callback) { return callback(Buffer.from("test")); } },
    transport: { async request() { return { status: 200, latencyMilliseconds: 3 }; } },
    onObservationError: async (facts) => { failures.push(facts); throw new Error("logger failure"); },
    clock: () => new Date(NOW), intervalMilliseconds: 1_000,
  });
  await value.tick();
  assert.deepEqual(records, [good.providerId]);
  assert.deepEqual(failures, [{ providerId: bad.providerId, errorCode: "provider_health_probe_failed" }]);
});

test("does not probe disabled or untested Providers", async () => {
  const subject = monitor({ providerValue: provider({ lifecycleState: "disabled" }) });
  await subject.value.tick();
  assert.equal(subject.records.length, 0);
  assert.equal(subject.secrets.length, 0);
});

test("starts all due Provider probes concurrently and isolates one failing observation", async () => {
  const first = provider({ providerId: "11111111-1111-4111-8111-111111111111", providerKey: "slow" });
  const second = provider({ providerId: "22222222-2222-4222-8222-222222222222", providerKey: "fast" });
  const started = [];
  const recorded = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const value = new ExternalProviderHealthMonitor({
    repository: {
      async list() { return [first, second]; },
      async recordHealth(providerId, observation) {
        recorded.push(providerId);
        if (providerId === first.providerId) throw new Error("isolated database failure");
        return { ...second, lifecycleState: observation.lifecycleState, health: observation.health };
      },
    },
    secretStore: { async withSecret(name, reader, callback) { return callback(Buffer.from(name)); } },
    transport: { async request({ provider: current }) {
      started.push(current.providerId);
      if (current.providerId === first.providerId) await slow;
      return { status: 200, latencyMilliseconds: 3 };
    } },
    clock: () => new Date(NOW),
    intervalMilliseconds: 1_000,
  });
  const tick = value.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [first.providerId, second.providerId]);
  releaseSlow();
  await tick;
  assert.deepEqual(new Set(recorded), new Set([first.providerId, second.providerId]));
});
