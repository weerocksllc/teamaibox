import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runtimeDependenciesFromEnvironment,
  startPlatformApiProcess,
} from "../server/main.mjs";
import {
  createProtectedOfficeSetProductionBoundaryFromEnvironment,
} from "../server/protected-office-set-production-boundary.mjs";

const protectedOfficeV5Environment = Object.freeze({
  PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID: "teamaibox.protected-office-set-deployment.v5",
  PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT: "/run/teamaibox/protected-office-set/bundle",
  PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE:
    "/run/teamaibox/protected-office-set/bundle/bundle-manifest.json",
  PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT: "/run/teamaibox/protected-office-set/bundle",
  PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE:
    "/run/teamaibox/protected-office-set/bundle/deploy/compute/protected-office-set-deployment.v5.json",
  PLATFORM_PROTECTED_OFFICE_SET_NODE_ID: "00000000-0000-5000-8000-000000000001",
  PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION: "4",
  PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID: "00000000-0000-5000-8000-000000000002",
  PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID: "00000000-0000-5000-8000-000000000003",
  PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE: "/run/secrets/protected-office-set-probe",
  PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE:
    "/run/teamaibox/protected-office-set/production-boundary.v1.json",
  PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE:
    "/run/teamaibox/maintenance-keys/protected-office.ed25519.json",
  PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: "/opt/teamaibox/config/maintenance-runtime.json",
  PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY: "spark-local",
  PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST: `sha256:${"a".repeat(64)}`,
  PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_ID: "protected-office-set-v5",
  PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST: `sha256:${"b".repeat(64)}`,
  PLATFORM_PROTECTED_OFFICE_SET_TARGET_POLICY_DIGEST: `sha256:${"c".repeat(64)}`,
});

test("keeps the development preview memory-backed unless postgres is explicit", async () => {
  const runtime = await runtimeDependenciesFromEnvironment({});
  assert.deepEqual(runtime.dependencies, {});
  await runtime.close();
  await assert.rejects(runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "unknown",
  }), /memory or postgres/);
  await assert.rejects(runtimeDependenciesFromEnvironment({
    NODE_ENV: "production",
  }), /must be explicit in production/);
  const explicitPreview = await runtimeDependenciesFromEnvironment({
    NODE_ENV: "production",
    PLATFORM_API_PERSISTENCE: "memory",
  });
  assert.deepEqual(explicitPreview.dependencies, {});
});

test("loads a protected audit key only after PostgreSQL readiness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-main-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x5a).toString("base64url") + "\n", { mode: 0o600 });
  const calls = [];
  const database = {
    async ready() { calls.push("ready"); },
    async close() { calls.push("close"); },
  };
  const runtime = await runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE: "/run/config/plugin-runtime.json",
  }, {
    async databaseFactory() { calls.push("factory"); return database; },
  });
  assert.deepEqual(calls, ["factory", "ready"]);
  assert.equal(runtime.dependencies.database, database);
  assert.equal(typeof runtime.dependencies.pluginRuntimeFactory, "function");
  assert.deepEqual(runtime.dependencies.auditSigningKey, Buffer.alloc(32, 0x5a));
  await runtime.close();
  assert.deepEqual(calls, ["factory", "ready", "close"]);
});

test("registers the exact v5 protected-office runtime factory only for a complete bundle boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-protected-office-v5-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x6a).toString("base64url") + "\n", { mode: 0o600 });
  const database = { async ready() {}, async close() {} };
  const boundaryFactory = async () => ({});
  const environment = {
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    ...protectedOfficeV5Environment,
  };
  const runtime = await runtimeDependenciesFromEnvironment(environment, {
    async databaseFactory() { return database; },
    protectedOfficeSetProductionBoundaryFactory: boundaryFactory,
  });
  assert.equal(typeof runtime.dependencies.protectedOfficeSetRuntimeFactory, "function");
  assert.equal(runtime.dependencies.protectedOfficeSetProductionBoundaryFactory, boundaryFactory);
  await runtime.close();
});

test("registers the concrete production boundary by default and preserves the injected override", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-protected-office-default-boundary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x6c).toString("base64url"), { mode: 0o600 });
  const runtime = await runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    ...protectedOfficeV5Environment,
  }, {
    async databaseFactory() { return { async ready() {}, async close() {} }; },
  });
  assert.equal(runtime.dependencies.protectedOfficeSetProductionBoundaryFactory,
    createProtectedOfficeSetProductionBoundaryFromEnvironment);
  await runtime.close();
});

test("rejects every missing exact v5 scenario or boundary setting after closing PostgreSQL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-protected-office-exact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x6d).toString("base64url"), { mode: 0o600 });
  for (const name of [
    "PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT",
    "PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION",
    "PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE",
    "PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE",
    "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY",
    "PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST",
    "PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_ID",
    "PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST",
    "PLATFORM_PROTECTED_OFFICE_SET_TARGET_POLICY_DIGEST",
  ]) {
    const environment = { ...protectedOfficeV5Environment };
    delete environment[name];
    let closed = false;
    await assert.rejects(runtimeDependenciesFromEnvironment({
      PLATFORM_API_PERSISTENCE: "postgres",
      PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
      ...environment,
    }, {
      async databaseFactory() {
        return { async ready() {}, async close() { closed = true; } };
      },
    }), /complete and exact/, name);
    assert.equal(closed, true, name);
  }
});

test("rejects protected-office v5 under memory persistence", async () => {
  await assert.rejects(runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "memory",
    ...protectedOfficeV5Environment,
  }), /requires PostgreSQL persistence/);
});

test("does not mistake the shared maintenance runtime setting for a partial v5 request", async () => {
  const runtime = await runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "memory",
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: "/opt/teamaibox/config/maintenance-runtime.json",
  });
  assert.deepEqual(runtime.dependencies, {});
  await runtime.close();
});

test("keeps an existing PostgreSQL maintenance runtime independent of v5", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-maintenance-without-v5-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x6f).toString("base64url"), { mode: 0o600 });
  const database = { async ready() {}, async close() {} };
  const runtime = await runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: "/opt/teamaibox/config/maintenance-runtime.json",
  }, { async databaseFactory() { return database; } });
  assert.equal(runtime.dependencies.database, database);
  assert.equal(typeof runtime.dependencies.maintenanceRuntimeFactory, "function");
  assert.equal(runtime.dependencies.protectedOfficeSetRuntimeFactory, undefined);
  await runtime.close();
});

test("rejects a partial v5 protected-office bundle environment and closes PostgreSQL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-protected-office-v5-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x6b).toString("base64url") + "\n", { mode: 0o600 });
  let closed = false;
  await assert.rejects(runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID: "teamaibox.protected-office-set-deployment.v5",
  }, {
    async databaseFactory() {
      return { async ready() {}, async close() { closed = true; } };
    },
  }), /runtime bundle environment must be complete and exact/);
  assert.equal(closed, true);
});

test("treats any standalone v5 boundary variable as a fail-closed partial request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-protected-office-v5-boundary-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x6e).toString("base64url"), { mode: 0o600 });
  let closed = false;
  await assert.rejects(runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres", PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST: `sha256:${"b".repeat(64)}`,
  }, { async databaseFactory() { return { async ready() {}, async close() { closed = true; } }; } }),
  /complete and exact/);
  assert.equal(closed, true);
});

test("enables the durable provider registry only with a protected master key and ciphertext directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-provider-secrets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  const providerKeyFile = join(directory, "provider-key");
  const ciphertextDirectory = join(directory, "ciphertext");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x41).toString("base64url"), { mode: 0o600 });
  await writeFile(providerKeyFile, Buffer.alloc(32, 0x42).toString("base64url"), { mode: 0o600 });
  await mkdir(ciphertextDirectory, { mode: 0o700 });
  await chmod(ciphertextDirectory, 0o700);
  const database = { async ready() {}, async close() {} };
  const runtime = await runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    PLATFORM_PROVIDER_SECRET_MASTER_KEY_FILE: providerKeyFile,
    PLATFORM_PROVIDER_SECRET_CIPHERTEXT_DIR: ciphertextDirectory,
  }, { async databaseFactory() { return database; } });
  assert.ok(runtime.dependencies.secretStore);
  const writer = { service: "platform-api", permissions: ["secrets:write"] };
  await runtime.dependencies.secretStore.putInitial("provider.00000000-0000-4000-8000-000000000010.auth", Buffer.from("provider-plaintext-secret"), ["provider-adapter"], writer);
  const files = await readdir(ciphertextDirectory);
  assert.equal(files.length, 1);
  assert.equal((await readFile(join(ciphertextDirectory, files[0]), "utf8")).includes("provider-plaintext-secret"), false);
  await runtime.close();
  await assert.rejects(() => runtime.dependencies.secretStore.putInitial("provider.closed.auth", Buffer.from("x"), ["provider-adapter"], writer), { code: "store_closed" });
});

test("rejects partial or malformed provider secret configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-provider-secret-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x51).toString("base64url"), { mode: 0o600 });
  const database = { async ready() {}, async close() {} };
  await assert.rejects(runtimeDependenciesFromEnvironment({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    PLATFORM_PROVIDER_SECRET_CIPHERTEXT_DIR: join(directory, "ciphertext"),
  }, { async databaseFactory() { return database; } }), /must both be absolute paths/);
});

test("closes the database when API startup fails and clears key material", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-main-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x31).toString("base64url"), { mode: 0o600 });
  let closed = false;
  let observedKey;
  await assert.rejects(startPlatformApiProcess({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
  }, {
    async databaseFactory() {
      return { async ready() {}, async close() { closed = true; } };
    },
    async start(_environment, dependencies) {
      observedKey = dependencies.auditSigningKey;
      throw new Error("startup failed");
    },
  }), /startup failed/);
  assert.equal(closed, true);
  assert.deepEqual(observedKey, Buffer.alloc(32));
});

test("closes PostgreSQL after the HTTP server closes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "teamaibox-api-main-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditKeyFile = join(directory, "audit-key");
  await writeFile(auditKeyFile, Buffer.alloc(32, 0x32).toString("base64url"), { mode: 0o600 });
  const server = new EventEmitter();
  server.close = () => server.emit("close");
  let closed = false;
  const started = await startPlatformApiProcess({
    PLATFORM_API_PERSISTENCE: "postgres",
    PLATFORM_AUDIT_SIGNING_KEY_FILE: auditKeyFile,
  }, {
    async databaseFactory() {
      return { async ready() {}, async close() { closed = true; } };
    },
    async start() { return server; },
  });
  started.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});
