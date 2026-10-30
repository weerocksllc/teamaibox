import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { ApplicationCatalogService } from "../src/applications/application-catalog-service.mjs";

function manifest({ dependencies = [], capabilities = ["ocr", "encrypted-objects"], scopes = ["ai:invoke"] } = {}) {
  return {
    entryPoints: { web: { path: "/plugins/official.ocr", integration: "iframe" } },
    ui: { displayNameKey: "app.ocr.name", summaryKey: "app.ocr.description", icon: "scan-text", category: "ai", order: 30 },
    permissions: { platformApiScopes: scopes },
    compatibility: { requiredCapabilities: capabilities, dependencies },
  };
}

function plugin(overrides = {}) {
  return {
    pluginKey: "official.ocr", pluginType: "application", lifecycleState: "enabled",
    currentVersion: "1.2.3", manifest: manifest(), installState: "healthy",
    activeSlot: "blue", slotState: "active", slotHealth: { healthy: true },
    slotUpdatedAt: "2026-08-12T00:00:00.000Z", ...overrides,
  };
}

function fixture({ plugins = [plugin()], capabilities = [{ capabilityKey: "ocr", certified: true, localRoute: true, providerRoute: false, certifiedProfiles: ["ocr.nvfp4"] }], health = [{ targetKind: "core_service", targetKey: "object-service", state: "healthy", observedAt: "2026-08-12T00:00:00.000Z" }], routes = [{ pluginKey: "official.ocr", pathPrefix: "/plugins/official.ocr" }], builtIns = [] } = {}) {
  return new ApplicationCatalogService({
    repository: { async snapshot() { return { plugins, capabilities, health }; },
      async getApplication(key) { return plugins.find((item) => item.pluginKey === key) ?? null; } },
    routeSource: { async routes() { return routes; } },
    builtInSource: { async applications() { return builtIns; } },
    clock: () => new Date("2026-08-12T00:01:00.000Z"),
  });
}

const context = { permissions: ["application:catalog:view", "ai:invoke", "file:read", "file:write"] };

test("virtual phone manifest joins the dynamic member catalog without granting operators user access", async () => {
  const phoneManifest = JSON.parse(await readFile(new URL("../../virtual-phones-plugin/manifest.release-template.json", import.meta.url), "utf8"));
  // Installed-slot facts below are fixtures, not a signed release or a live deployment.
  const phone = plugin({ pluginKey:"official.virtual-phones", currentVersion:"0.1.0", manifest:phoneManifest });
  const service = fixture({ plugins:[phone], capabilities:[], routes:[{
    pluginKey:phone.pluginKey, pathPrefix:"/plugins/official.virtual-phones",
  }] });
  const [item] = (await service.list({context:{permissions:["application:catalog:view","phone:use"]}})).applications;
  assert.equal(item.launchable,true); assert.equal(item.authorized,true);
  assert.equal(item.ui.iconKey,"smartphone"); assert.equal(item.ui.labelKey,"app.virtual-phones.name");
  assert.equal(item.route.pathPrefix,"/plugins/official.virtual-phones");
  const [operator] = (await service.list({context:{permissions:["application:catalog:view","phone:manage"]}})).applications;
  assert.equal(operator.authorized,false); assert.equal(operator.launchable,false);
  assert.equal((await fixture({plugins:[{...phone,lifecycleState:"disabled"}]}).list({context})).applications[0].launchable,false);
});

test("asset access checks only the current plugin and never runs the full model/catalog snapshot", async () => {
  let current = plugin(), routesRead = 0, fetches = 0;
  const service = new ApplicationCatalogService({
    repository: {
      async snapshot() { assert.fail("full model snapshot must not run for a static file"); },
      async getApplication(key) { assert.equal(key, "official.ocr"); return current; },
    },
    routeSource: {
      async routes(options) { routesRead++; assert.deepEqual(options, { pluginKey: "official.ocr" });
        return [{ pluginKey: "official.ocr", pathPrefix: "/plugins/official.ocr", healthy: true,
          transport: "node-agent-mtls-proxy", observedAt: "2026-08-12T00:00:59Z" }]; },
      async fetch() { fetches++; return { status: 200, headers: {}, body: Buffer.from("asset") }; },
    }, clock: () => new Date("2026-08-12T00:01:00Z"),
  });
  const input = { context, pluginKey: "official.ocr", method: "GET", path: "/plugins/official.ocr/app.js" };
  assert.equal((await service.fetchProxyContent(input)).body.toString(), "asset");
  assert.equal(routesRead, 1); assert.equal(fetches, 1);
  for (const changes of [{ lifecycleState: "disabled" }, { installState: "failed" }, { slotState: "staged" },
    { activeSlot: "wrong" }, { manifest: manifest({ scopes: ["model:manage"] }) }]) {
    current = plugin(changes);
    assert.equal(await service.fetchProxyContent(input), null);
  }
  current = plugin();
  assert.equal(await service.fetchProxyContent({ ...input, context: { permissions: [] } }), null);
  assert.equal(await service.fetchProxyContent({ ...input, context: { permissions: ["application:catalog:view"] } }), null);
  assert.equal(routesRead, 1); assert.equal(fetches, 1);
});

test("OCR catalog discloses the exact current profile ID only with the selected local route", async () => {
  const id = "f6ffe978-7a1d-571d-aa6d-d520250dc7a4";
  const capability = { capabilityKey: "ocr", eligible: true, localRoute: true, providerRoute: false,
    selectedProfile: "ocr.main.successor", selectedProfileId: id, localRoutableProfiles: ["ocr.main.successor"] };
  const read = async (changes) => (await fixture({ capabilities: [{ ...capability, ...changes }] })
    .list({ context })).applications[0].models[0].selectedProfileId;
  assert.equal(await read({}), id);
  for (const changes of [{ eligible: false }, { localRoute: false, providerRoute: true },
    { selectedProfile: null }, { selectedProfileId: "bad" }]) assert.equal(await read(changes), null);
});

test("fresh exact plugin readiness replaces stale model-coupled slot health, without bypassing install or model gates", async () => {
  const route = { pluginKey: "official.ocr", pathPrefix: "/plugins/official.ocr", readinessChecked: true,
    healthy: true, version: "1.2.3", observedAt: "2026-08-12T00:00:59.000Z" };
  const p = plugin({ slotHealth: { healthy: false }, slotUpdatedAt: "2026-08-11T00:00:00.000Z" });
  assert.equal((await fixture({ plugins: [p], routes: [route] }).list({ context })).applications[0].launchable, true);
  for (const broken of [{ healthy: false }, { version: "9.0.0" }, { observedAt: "2026-08-11T00:00:00Z" }]) {
    assert.equal((await fixture({ routes: [{ ...route, ...broken }] }).list({ context })).applications[0].launchable, false);
  }
  assert.equal((await fixture({ plugins: [{ ...p, installState: "failed" }], routes: [route] }).list({ context })).applications[0].launchable, false);
  assert.equal((await fixture({ plugins: [p], routes: [route], capabilities: [] }).list({ context })).applications[0].launchable, false);
});

test("protected canonical default replaces obsolete built-in profile and retains validating disclosure", async () => {
  const result = await fixture({ plugins: [], routes: [], builtIns: [{ applicationKey: "official.assistant", installedVersion: "1.0.0",
    requiredPermissions: ["ai:invoke"], requiredCapabilities: ["chat"], requiredCoreServices: [],
    requiredModelProfiles: { chat: "obsolete.aux.profile" }, ui: {}, route: { pathPrefix: "/apps/assistant" } }],
    capabilities: [{ capabilityKey: "chat", protectedDefault: "chat.main.v1", selectedProfile: "chat.main.v1",
      selectedCertificationState: "validating", experimentalProfiles: ["chat.main.v1"], localRoutableProfiles: ["chat.main.v1"] }],
  }).list({ context });
  assert.equal(result.applications[0].launchable, true);
  assert.equal(result.applications[0].models[0].selectedProfile, "chat.main.v1");
  assert.equal(result.applications[0].models[0].selectedCertificationState, "validating");
});

test("returns only installed application versions and derives a launchable route from exact facts", async () => {
  const result = await fixture({ plugins: [plugin(), plugin({ pluginKey: "compute.ocr", pluginType: "compute" })] }).list({ context });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.applications.length, 1);
  assert.deepEqual(result.applications[0].blockers, []);
  assert.equal(result.applications[0].launchable, true);
  assert.equal(result.applications[0].installedVersion, "1.2.3");
  assert.equal(result.applications[0].models[0].route, "local");
});

test("a member can launch Team Drive while privileged sharing remains separately authorized", async () => {
  const teamDrive = plugin({
    pluginKey: "official.team-drive",
    manifest: {
      entryPoints: { web: { path: "/plugins/official.team-drive", integration: "iframe" } },
      permissions: { platformApiScopes: ["files:read", "files:write"] },
      compatibility: { requiredCapabilities: ["encrypted-objects"], dependencies: [] },
    },
  });
  const service = fixture({
    plugins: [teamDrive],
    capabilities: [],
    routes: [{ pluginKey: "official.team-drive", pathPrefix: "/plugins/official.team-drive" }],
  });
  const result = await service.list({ context: { permissions: ["application:catalog:view", "file:read", "file:write"] } });
  assert.equal(result.applications[0].launchable, true);
  assert.equal(result.applications[0].authorized, true);
});

test("fails closed for missing route, unhealthy slot, missing model route, dependency, and authorization", async () => {
  const application = plugin({
    slotHealth: { healthy: false },
    manifest: manifest({
      dependencies: [{ pluginId: "official.base", versionRange: ">=2.0.0 <3.0.0", optional: false }],
      scopes: ["ai:invoke", "files:write"],
    }),
  });
  const result = await fixture({ plugins: [application], capabilities: [], health: [], routes: [] }).list({
    context: { permissions: ["application:catalog:view", "ai:invoke"] },
  });
  assert.equal(result.applications[0].launchable, false);
  assert.deepEqual(result.applications[0].blockers, [
    "route_unavailable", "plugin_unhealthy", "dependency_unavailable",
    "platform_capability_unavailable", "authorization_denied",
  ]);
});

test("hides every application when catalog permission is absent", async () => {
  assert.deepEqual(await fixture().list({ context: { permissions: ["ai:invoke"] } }), { schemaVersion: 1, applications: [] });
});

test("publishes the built-in Assistant only when its certified model and fresh core health routes exist", async () => {
  const builtIn = {
    applicationKey: "official.assistant", installedVersion: "0.1.0",
    route: { pathPrefix: "/apps/assistant", integration: "workbench" },
    requiredPermissions: ["ai:invoke"], requiredCapabilities: ["chat"],
    requiredCoreServices: ["platform-api", "scheduler", "agent-bridge"],
    ui: { categoryKey: "ai-application", labelKey: "app.assistant.name", descriptionKey: "app.assistant.description", iconKey: "sparkles", order: 10, fallbackLabel: "Assistant", official: true },
  };
  const freshHealth = ["platform-api", "scheduler", "agent-bridge"].map((targetKey) => ({ targetKind: "core_service", targetKey, state: "healthy", observedAt: "2026-08-12T00:00:30.000Z" }));
  const service = fixture({
    plugins: [], routes: [], builtIns: [builtIn], health: freshHealth,
    capabilities: [{ capabilityKey: "chat", certified: true, localRoute: false, providerRoute: true, certifiedProfiles: ["llm.large.external"] }],
  });
  const result = await service.list({ context });
  assert.equal(result.applications[0].launchable, true);
  assert.equal(result.applications[0].route.integration, "workbench");
  assert.equal(result.applications[0].models[0].route, "external");
});

test("binds the built-in Assistant to its exact profile instead of another chat route", async () => {
  const builtIn = {
    applicationKey: "official.assistant", installedVersion: "0.1.0",
    route: { pathPrefix: "/apps/assistant", integration: "workbench" },
    requiredPermissions: ["ai:invoke"], requiredCapabilities: ["chat"],
    requiredModelProfiles: { chat: "llm.qwen38.nvfp4" }, requiredCoreServices: [],
    ui: { categoryKey: "ai-application", fallbackLabel: "Assistant" },
  };
  const unavailable = await fixture({
    plugins: [], routes: [], builtIns: [builtIn], health: [],
    capabilities: [{ capabilityKey: "chat", certified: true, eligible: true, localRoute: true,
      providerRoute: false, localRoutableProfiles: ["llm.qwen36.nvfp4"], providerRoutableProfiles: [],
      certifiedProfiles: ["llm.qwen36.nvfp4", "llm.qwen38.nvfp4"], experimentalProfiles: [] }],
  }).list({ context });
  assert.equal(unavailable.applications[0].launchable, false);
  assert.deepEqual(unavailable.applications[0].blockers, ["model_route_unavailable"]);
  assert.equal(unavailable.applications[0].models[0].requiredProfile, "llm.qwen38.nvfp4");
  assert.equal(unavailable.applications[0].models[0].route, null);

  const available = await fixture({
    plugins: [], routes: [], builtIns: [builtIn], health: [],
    capabilities: [{ capabilityKey: "chat", certified: true, eligible: true, localRoute: true,
      providerRoute: true, localRoutableProfiles: ["llm.qwen36.nvfp4"],
      providerRoutableProfiles: ["llm.qwen38.nvfp4"],
      certifiedProfiles: ["llm.qwen36.nvfp4", "llm.qwen38.nvfp4"], experimentalProfiles: [] }],
  }).list({ context });
  assert.equal(available.applications[0].launchable, true);
  assert.equal(available.applications[0].models[0].selectedProfile, "llm.qwen38.nvfp4");
  assert.equal(available.applications[0].models[0].route, "external");
});

test("rejects stale plugin and core health even when the last recorded state says healthy", async () => {
  const result = await fixture({
    plugins: [plugin({ slotUpdatedAt: "2026-08-11T00:00:00.000Z" })],
    health: [{ targetKind: "core_service", targetKey: "object-service", state: "healthy", observedAt: "2026-08-11T00:00:00.000Z" }],
  }).list({ context });
  assert.equal(result.applications[0].launchable, false);
  assert.ok(result.applications[0].blockers.includes("plugin_unhealthy"));
  assert.ok(result.applications[0].blockers.includes("platform_capability_unavailable"));
});

test("uses a fresh live runtime route to launch a stale persisted ApplicationPlugin and resolves its private proxy origin", async () => {
  const route = { pluginKey: "official.ocr", pathPrefix: "/plugins/official.ocr", integration: "iframe",
    transport: "node-agent-mtls-proxy", healthy: true, observedAt: "2026-08-12T00:00:59.000Z" };
  const service = fixture({
    plugins: [plugin({ slotUpdatedAt: "2026-08-11T00:00:00.000Z" })],
    routes: [route],
  });
  const catalog = await service.list({ context });
  assert.equal(catalog.applications[0].launchable, true);
  assert.equal(JSON.stringify(catalog).includes("10.64.0.18"), false);
  assert.deepEqual(await service.resolveProxyRoute({ context, pluginKey: "official.ocr" }), {
    schemaVersion: 1, pluginId: "official.ocr", pathPrefix: "/plugins/official.ocr", integration: "iframe", transport: "platform-authenticated-proxy",
  });
});

test("launches an explicitly administrator-opted development profile without claiming certification", async () => {
  const result = await fixture({
    capabilities: [{
      capabilityKey: "ocr", certified: false, eligible: true, experimental: true,
      localRoute: true, providerRoute: false, certifiedProfiles: [], experimentalProfiles: ["ocr.validation.fp16"],
    }],
  }).list({ context });
  assert.equal(result.applications[0].launchable, true);
  assert.deepEqual(result.applications[0].models[0].certifiedProfiles, []);
  assert.deepEqual(result.applications[0].models[0].experimentalProfiles, ["ocr.validation.fp16"]);
  assert.equal(result.applications[0].models[0].routingClass, "experimental");
});

test("publishes versioned Drawing intents from per-profile routability facts", async () => {
  const drawing = plugin({
    pluginKey: "official.drawing",
    manifest: manifest({ capabilities: ["image-generation", "encrypted-objects"] }),
  });
  drawing.manifest.entryPoints.web.path = "/plugins/official.drawing";
  const result = await fixture({
    plugins: [drawing], routes: [{ pluginKey: "official.drawing", pathPrefix: "/plugins/official.drawing" }],
    capabilities: [{ capabilityKey: "image-generation", certified: false, eligible: true, experimental: true,
      localRoute: true, providerRoute: true,
      localRoutableProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2"],
      providerRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      localActuallyRoutableProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2"],
      providerActuallyRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      certifiedProfiles: [], experimentalProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2",
        "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"] }],
  }).list({ context });
  const router = result.applications[0].models[0].intentRouter;
  assert.equal(router.schema, "teamaibox.drawing-intents.v2");
  assert.deepEqual(router.intents.filter((item) => item.available).map((item) => item.intentKey), ["automatic", "fast"]);
  assert.equal(router.intents.every((item) => item.selectedProfile === "drawing.flux2-klein-4b.bf16.main-protected.v2"), true);
  assert.equal(result.applications[0].models[0].selectedProfile, "drawing.flux2-klein-4b.bf16.main-protected.v2");
  assert.equal(result.applications[0].models[0].route, "local");
  assert.equal("advancedControls" in router, false);
});

test("never publishes removed auxiliary Drawing modes, including to administrators", async () => {
  const drawing = plugin({ pluginKey: "official.drawing",
    manifest: manifest({ capabilities: ["image-generation", "encrypted-objects"] }) });
  drawing.manifest.entryPoints.web.path = "/plugins/official.drawing";
  const service = fixture({ plugins: [drawing],
    routes: [{ pluginKey: "official.drawing", pathPrefix: "/plugins/official.drawing" }],
    capabilities: [{ capabilityKey: "image-generation", certified: false, eligible: true, experimental: true,
      localRoute: true, providerRoute: true,
      localRoutableProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2"],
      providerRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      localActuallyRoutableProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2"],
      providerActuallyRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      certifiedProfiles: [], experimentalProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2",
        "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"] }] });
  const ordinary = await service.list({ context });
  assert.equal(JSON.stringify(ordinary).includes("spark23"), false);
  const administrator = await service.list({ context: { permissions: [...context.permissions, "model:view"] } });
  const router = administrator.applications[0].models[0].intentRouter;
  assert.equal("advancedControls" in router, false);
  assert.equal(JSON.stringify(administrator).includes("spark23"), false);
  assert.deepEqual(router.intents.map(item => item.intentKey), ["automatic", "fast"]);
});

test("does not publish cold-load or degraded Drawing profiles as v2 actually routable", async () => {
  const drawing = plugin({ pluginKey: "official.drawing",
    manifest: manifest({ capabilities: ["image-generation", "encrypted-objects"] }) });
  drawing.manifest.entryPoints.web.path = "/plugins/official.drawing";
  const result = await fixture({ plugins: [drawing],
    routes: [{ pluginKey: "official.drawing", pathPrefix: "/plugins/official.drawing" }],
    capabilities: [{ capabilityKey: "image-generation", certified: false, eligible: true, experimental: true,
      localRoute: true, providerRoute: true,
      localRoutableProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2"],
      providerRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      localActuallyRoutableProfiles: [], providerActuallyRoutableProfiles: [],
      certifiedProfiles: [], experimentalProfiles: ["drawing.flux2-klein-4b.bf16.main-protected.v2",
        "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"] }] }).list({
    context: { permissions: [...context.permissions, "model:view"] },
  });
  const model = result.applications[0].models[0];
  assert.equal(model.intentRouter.intents.every((intent) => intent.available === false), true);
  assert.equal("advancedControls" in model.intentRouter, false);
  assert.equal(model.available, false);
});

test("does not launch or disclose an auxiliary-only Drawing capability to an ordinary user", async () => {
  const drawing = plugin({ pluginKey: "official.drawing",
    manifest: manifest({ capabilities: ["image-generation", "encrypted-objects"] }) });
  drawing.manifest.entryPoints.web.path = "/plugins/official.drawing";
  const service = fixture({ plugins: [drawing],
    routes: [{ pluginKey: "official.drawing", pathPrefix: "/plugins/official.drawing" }],
    capabilities: [{ capabilityKey: "image-generation", certified: false, eligible: true, experimental: true,
      localRoute: false, providerRoute: true, localRoutableProfiles: [],
      providerRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      localActuallyRoutableProfiles: [],
      providerActuallyRoutableProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      certifiedProfiles: [], experimentalProfiles: ["drawing.flux2-klein-4b.nvfp4.spark23.provider.v1"],
      selectedProfile: "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1", selectedCertificationState: "validating" }] });
  const ordinary = await service.list({ context });
  const ordinaryApplication = ordinary.applications[0];
  assert.equal(ordinaryApplication.launchable, false);
  assert.ok(ordinaryApplication.blockers.includes("model_route_unavailable"));
  assert.equal(ordinaryApplication.models[0].available, false);
  assert.equal(ordinaryApplication.models[0].selectedProfile, null);
  assert.equal(ordinaryApplication.models[0].route, null);
  assert.equal(JSON.stringify(ordinaryApplication).includes("spark23"), false);

  const administrator = await service.list({ context: { permissions: [...context.permissions, "model:view"] } });
  const administratorModel = administrator.applications[0].models[0];
  assert.equal(administrator.applications[0].launchable, false);
  assert.equal(administratorModel.intentRouter.intents.every((intent) => intent.available === false), true);
  assert.equal("advancedControls" in administratorModel.intentRouter, false);
  assert.equal(administratorModel.selectedProfile, null);
  assert.equal(administratorModel.route, null);
});
