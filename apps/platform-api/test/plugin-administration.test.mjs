import assert from "node:assert/strict";
import test from "node:test";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { PluginImportError } from "../../../services/plugin-runtime/src/plugin-import-service.mjs";
import { PluginLifecycleError } from "../../../services/plugin-runtime/src/plugin-lifecycle-service.mjs";
import { PluginAdministrationHttpApi, matchesPluginAdministrationHttpRoute } from "../src/plugins/plugin-administration-http-api.mjs";
import { PluginAdministrationService } from "../src/plugins/plugin-administration-service.mjs";

const context = Object.freeze({ identityId: "00000000-0000-4000-8000-000000000001", permissions: ["plugin:view", "plugin:manage"] });
const imported = Object.freeze({ schemaVersion: 1, pluginId: "example.notes", pluginType: "ApplicationPlugin", version: "1.0.0",
  sourceKind: "marketplace", manifestPayloadDigest: `sha256:${"1".repeat(64)}`, bundlePayloadDigest: `sha256:${"2".repeat(64)}`,
  imageDigests: [`sha256:${"3".repeat(64)}`], supplyChain: { vulnerabilityStatus: "passed" }, state: "verified", verifiedAt: "2026-08-14T00:00:00.000Z" });
const installed = Object.freeze({ pluginId: "example.notes", pluginType: "ApplicationPlugin", publisherId: "example", protectedOfficial: false,
  lifecycleState: "enabled", currentVersion: "1.0.0", activeSlot: "blue", generation: 1, data: { retentionState: "retained" },
  versions: { "1.0.0": { version: "1.0.0", installState: "healthy", slot: "blue", health: { healthy: true, consecutive: 3 } } }, updatedAt: "2026-08-14T00:00:00.000Z" });

function fixture({ importFailure = null, lifecycleFailure = null } = {}) {
  const calls = [], audits = [];
  const importService = {
    async importFromMarketplace(input) { calls.push(["marketplace", input]); if (importFailure) throw importFailure; return imported; },
    async importFromPrivateRegistry(input) { calls.push(["registry", input]); return { ...imported, sourceKind: "private-registry" }; },
    async importOfflineBundle(input) { calls.push(["offline", input]); return { ...imported, sourceKind: "offline-bundle" }; },
  };
  const lifecycleService = Object.fromEntries(["install", "upgrade", "enable", "disable", "uninstall"].map((operation) => [operation, async (input) => {
    calls.push([operation, input]); if (lifecycleFailure) throw lifecycleFailure; return { ...installed, operationKey: input.operationKey };
  }]));
  const service = new PluginAdministrationService({
    imports: { async list() { return [imported]; } },
    lifecycleRepository: { async listPlugins() { return [installed]; } },
    importService, lifecycleService, audit: async (event) => audits.push(event),
  });
  return { service, api: new PluginAdministrationHttpApi({ service }), calls, audits };
}

test("plugin administration overview exposes bounded public lifecycle and supply-chain facts", async () => {
  const result = await fixture().service.overview({ context });
  assert.equal(result.architecture, "linux/arm64/v8");
  assert.deepEqual(result.supportedPluginTypes, ["ApplicationPlugin", "ComputePlugin"]);
  assert.equal(result.imports[0].supplyChain.vulnerabilityStatus, "passed");
  assert.equal(result.plugins[0].versions[0].health.consecutive, 3);
  assert.equal(Object.hasOwn(result.imports[0], "manifest"), false);
  await assert.rejects(fixture().service.overview({ context: { ...context, permissions: [] } }), (error) => error instanceof PlatformError && error.status === 403);
});

test("all plugin sources pass through the verified import service and emit bounded audit", async () => {
  const setup = fixture();
  await setup.service.importPlugin({ context, sourceKind: "marketplace", pluginId: "example.notes", version: "1.0.0" });
  await setup.service.importPlugin({ context, sourceKind: "private-registry", reference: "registry.example.test/example.notes@sha256:12345678" });
  await setup.service.importPlugin({ context, sourceKind: "offline-bundle", bundleId: "object-0001", expectedBundleDigest: `sha256:${"2".repeat(64)}` });
  assert.deepEqual(setup.calls.map((item) => item[0]), ["marketplace", "registry", "offline"]);
  assert.deepEqual(setup.audits.map((item) => item.action), ["plugin.imported", "plugin.imported", "plugin.imported"]);
  assert.equal(JSON.stringify(setup.audits).includes("reference"), false);
});

test("plugin lifecycle uses administrator context and idempotency key for every public action", async () => {
  const setup = fixture();
  for (const operation of ["install", "upgrade", "enable", "disable", "uninstall"]) {
    await setup.service.lifecycle({ context, pluginId: "example.notes", operation, version: new Set(["install", "upgrade"]).has(operation) ? "1.0.0" : null,
      operationKey: `${operation}-operation-0001` });
  }
  assert.deepEqual(setup.calls.map((item) => item[0]), ["install", "upgrade", "enable", "disable", "uninstall"]);
  assert.equal(setup.calls.every((item) => item[1].context === context), true);
});

test("plugin HTTP API routes overview, imports, lifecycle and maps fail-closed service errors", async () => {
  assert.equal(matchesPluginAdministrationHttpRoute("GET", "/api/v1/admin/plugins"), true);
  assert.equal(matchesPluginAdministrationHttpRoute("POST", "/api/v1/admin/plugins/example.notes/upgrade"), true);
  assert.equal(matchesPluginAdministrationHttpRoute("DELETE", "/api/v1/admin/plugins"), false);
  const setup = fixture();
  assert.equal((await setup.api.handle({ method: "GET", pathname: "/api/v1/admin/plugins", context })).status, 200);
  assert.equal((await setup.api.handle({ method: "POST", pathname: "/api/v1/admin/plugins/imports", context,
    body: { sourceKind: "marketplace", pluginId: "example.notes", version: "1.0.0" } })).status, 201);
  await setup.api.handle({ method: "POST", pathname: "/api/v1/admin/plugins/example.notes/upgrade", context,
    body: { version: "2.0.0" }, requestId: "request-operation-0001" });
  assert.equal(setup.calls.at(-1)[1].operationKey, "request-operation-0001");

  const importDenied = fixture({ importFailure: new PluginImportError("signature_verification_failed", "manifest-signature", "invalid") });
  await assert.rejects(importDenied.api.handle({ method: "POST", pathname: "/api/v1/admin/plugins/imports", context,
    body: { sourceKind: "marketplace", pluginId: "example.notes", version: "1.0.0" } }),
  (error) => error instanceof PlatformError && error.status === 400 && error.details.gate === "manifest-signature");
  const lifecycleDenied = fixture({ lifecycleFailure: new PluginLifecycleError("plugin_operation_in_progress", "busy", {
    retryable: true, stage: "health", causeCode: "node_agent_transport_unavailable" }) });
  await assert.rejects(lifecycleDenied.api.handle({ method: "POST", pathname: "/api/v1/admin/plugins/example.notes/enable", context,
    body: { operationKey: "enable-operation-0001" } }),
  (error) => error instanceof PlatformError && error.status === 503 && error.details.stage === "health"
    && error.details.causeCode === "node_agent_transport_unavailable");
});
