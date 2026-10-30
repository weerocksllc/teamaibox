import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { ExternalProviderExecutionRouter } from "../src/providers/external-provider-execution-router.mjs";

const CAPABILITY = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const LONGCAT_PROFILE = "c6799c69-7c01-5031-94c3-45d3785e7e43";
const AUX_FLUX_PROFILE = "bc266009-bf57-589e-b8c4-dcf9ec892692";
const PROVIDER = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-08-24T03:00:00.000Z");

function provider(overrides = {}) {
  return {
    providerId: PROVIDER,
    providerKind: 'external_openai',
    providerKey: "spark-23-gemma",
    endpoint: "https://provider.test/v1",
    lifecycleState: "healthy",
    auth: { scheme: "bearer", headerName: "Authorization" },
    credentialSecretKey: "provider.spark23.auth",
    trust: { mode: "custom_ca", serverName: "provider.test" },
    caSecretKey: "provider.spark23.ca",
    allowedDataClasses: ["confidential"],
    timeouts: { requestMilliseconds: 120_000 },
    healthCheck: { path: "/models", intervalSeconds: 30, timeoutMilliseconds: 5_000 },
    health: { state: "healthy", observedAt: new Date(NOW.getTime() - 1_000) },
    contract: { state: "passed" },
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "gemma-nvfp4", operations: ["chat.completions"], routingWeight: 100, enabled: true }],
    ...structuredClone(overrides),
  };
}

function createRouter({ routing = {}, providerValue = provider(), requestResult = null,
  schedule = undefined, cancelSchedule = undefined, managedModelResidencyCoordinator = null,
  profileDocument = { dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" } } } = {}) {
  const calls = [];
  const secrets = new Map([
    ["provider.spark23.auth", Buffer.from("secret-token")],
    ["provider.spark23.ca", Buffer.from("test-ca")],
  ]);
  const transport = {
    async request(input) {
      calls.push(["request", input]);
      if (typeof requestResult === "function") return requestResult(input);
      return { status: 200, headers: {}, body: { object: "list", data: [] } };
    },
    async stream(input) { calls.push(["stream", input]); return { status: 200, headers: {}, body: Readable.from([]) }; },
  };
  const router = new ExternalProviderExecutionRouter({
    database: { async query(statement, parameters) {
      calls.push(["query", statement, parameters]);
      if (statement.includes("FROM compute.capabilities")) {
        assert.match(statement, /WHERE capability_key=\$1$/);
        assert.deepEqual(parameters, ["ocr"]);
        return { rows: [{ id: CAPABILITY }] };
      }
      return { rows: [{ profile_id: providerValue.modelMappings[0]?.modelProfileId ?? PROFILE,
        profile_document: profileDocument }] };
    } },
    providerRepository: { async list() { return [providerValue]; } },
    routingPolicyRegistry: { async resolve() { return { mode: "external_first", allowExternal: true, externalProcessingApproved: true,
      pinnedTargetId: null, pinnedProfileId: null, targetWeights: {}, policyId: null, policyRevision: 1, ...routing }; } },
    secretStore: { async withSecret(name, reader, callback) { calls.push(["secret", name, reader]); return callback(Buffer.from(secrets.get(name))); } },
    transport,
    clock: () => new Date(NOW),
    audit: async (event) => calls.push(["audit", event]),
    ...(schedule ? { schedule } : {}),
    ...(cancelSchedule ? { cancelSchedule } : {}),
    ...(managedModelResidencyCoordinator ? { managedModelResidencyCoordinator } : {}),
  });
  return { router, calls };
}

function drawingAuthorization({ modelAlias, operation, profileId }) {
  return { x_teamaibox: { routing_authorization: {
    schema: "teamaibox.drawing-route-authorization.v2",
    policy_version: "protected-main-default.v1",
    selection_class: "advanced-explicit",
    model_alias: modelAlias,
    operation,
    model_profile_id: profileId,
  } } };
}

function job(overrides = {}) {
  return { jobId: "55555555-5555-4555-8555-555555555555", ownerIdentityId: OWNER,
    capabilityId: CAPABILITY, operation: "chat.completions", profileId: null, dataClass: "confidential", ...overrides };
}

test("selects a fresh approved Provider route and unwraps secrets only around transport", async () => {
  const { router, calls } = createRouter();
  const resolved = await router.resolve({ job: job(), request: {}, localAvailable: true });
  assert.equal(resolved.selected.provider.providerId, PROVIDER);
  assert.equal(resolved.selected.mapping.providerModelName, "gemma-nvfp4");
  await router.request(resolved.selected, { method: "POST", path: "/chat/completions", body: { model: "gemma-nvfp4" }, timeoutMilliseconds: 1_000 });
  const sent = calls.find((entry) => entry[0] === "request")[1];
  assert.equal(sent.credential.toString(), "secret-token");
  assert.equal(sent.customCa.toString(), "test-ca");
  assert.deepEqual(calls.filter((entry) => entry[0] === "secret").map((entry) => entry[2]), [
    { service: "provider-adapter", permissions: ["secrets:read"] },
    { service: "provider-adapter", permissions: ["secrets:read"] },
  ]);
});

test("local-only and stale Provider observations fail closed", async () => {
  const first = createRouter();
  const denied = await first.router.resolve({ job: job(), request: { x_teamaibox: { extensions: { routing: { localOnly: true } } } }, localAvailable: false });
  assert.equal(denied.selected, null);
  assert.equal(denied.reasonCode, "routing.local_only");

  const stale = createRouter({ providerValue: provider({ health: { state: "healthy", observedAt: new Date(NOW.getTime() - 121_000) } }) });
  const unavailable = await stale.router.resolve({ job: job(), request: {}, localAvailable: false });
  assert.equal(unavailable.selected, null);
  assert.equal(unavailable.reasonCode, "routing.no_external_target");
});

test("rejects retired auxiliary providers even when pinned as an internal target", async () => {
  const providerValue = provider({ providerKind: "managed_node", dataPolicy: "internal_only",
    credentialSecretKey: null, caSecretKey: null,
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "hunyuanocr-1.5-bf16-dflash",
      operations: ["ocr"], routingWeight: 100, enabled: true }] });
  const { router, calls } = createRouter({ providerValue,
    routing: { mode: "pinned", allowExternal: false, externalProcessingApproved: false,
      pinnedTargetId: PROVIDER, pinnedProfileId: PROFILE },
    profileDocument: { executionKind: "managed_node", exclusive: true,
      dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "forbidden" } } });
  const resolved = await router.resolve({ job: job({ operation: "ocr" }),
    request: { x_teamaibox: { extensions: { routing: { localOnly: true } } } }, localAvailable: true });
  assert.equal(resolved.selected, null);
  assert.equal(resolved.reasonCode, "routing.local_only");
  assert.equal(calls.some((entry) => entry[0] === "audit"), false);
});

test("maps queued transcription operation to the OpenAI Provider contract name", async () => {
  const providerValue = provider({ modelMappings: [{ modelProfileId: PROFILE, providerModelName: "whisper", operations: ["audio.transcriptions"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue });
  const resolved = await router.resolve({ job: job({ operation: "transcriptions" }), request: {}, localAvailable: false });
  assert.equal(resolved.selected.mapping.providerModelName, "whisper");
});

test("maps the composed translation operation to its Chat Completions Provider adapter", async () => {
  const providerValue = provider({ modelMappings: [{ modelProfileId: PROFILE, providerModelName: "lmt-nvfp4", operations: ["chat.completions"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue });
  const resolved = await router.resolve({ job: job({ operation: "translations" }), request: {}, localAvailable: false });
  assert.equal(resolved.selected.mapping.providerModelName, "lmt-nvfp4");
});

test("resolves a composed OCR stage through its own capability policy", async () => {
  const providerValue = provider({ modelMappings: [{ modelProfileId: PROFILE, providerModelName: "hunyuan-ocr",
    operations: ["ocr"], routingWeight: 100, enabled: true }] });
  const { router, calls } = createRouter({ providerValue });
  const resolved = await router.resolveCapability({
    parentJob: job({ operation: "translations" }), capabilityKey: "ocr", operation: "ocr",
    request: {}, localAvailable: false,
  });
  assert.equal(resolved.selected.mapping.providerModelName, "hunyuan-ocr");
  const audit = calls.find((entry) => entry[0] === "audit")[1];
  assert.equal(audit.jobId, job().jobId);
  assert.equal(audit.operation, "ocr");
});

test("selects external drawing generation and edit operations without a local Worker", async () => {
  const providerValue = provider({ modelMappings: [{ modelProfileId: PROFILE, providerModelName: "sdxl-fp16", operations: ["images.generations", "images.edits"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue });
  const generated = await router.resolve({ job: job({ operation: "images.generations" }), request: {}, localAvailable: false });
  const edited = await router.resolve({ job: job({ operation: "images.edits" }), request: {}, localAvailable: false });
  assert.equal(generated.selected.mapping.providerModelName, "sdxl-fp16");
  assert.equal(edited.selected.mapping.providerModelName, "sdxl-fp16");
});

test("never turns an ordinary Drawing intent into Provider fallback", async () => {
  const providerValue = provider({ modelMappings: [{ modelProfileId: PROFILE, providerModelName: "qwen-image",
    operations: ["images.generations"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue, profileDocument: {
    dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" },
    extensions: { intent_roles: ["automatic", "fast", "text"] },
  } });
  const automatic = await router.resolve({ job: job({ operation: "images.generations", model: "drawing.automatic" }),
    request: {}, localAvailable: false });
  const infographic = await router.resolve({ job: job({ operation: "images.generations", model: "drawing.infographic" }),
    request: {}, localAvailable: false });
  assert.equal(automatic.selected, null);
  assert.equal(automatic.reasonCode, "routing.no_external_target");
  assert.equal(infographic.selected, null);
  assert.equal(infographic.reasonCode, "routing.no_external_target");
});

test("retired advanced auxiliary Drawing authorization cannot create a route", async () => {
  const providerValue = provider({ providerKind: "managed_node", modelMappings: [{ modelProfileId: AUX_FLUX_PROFILE, providerModelName: "flux-edit",
    operations: ["images.edits"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue, profileDocument: {
    executionKind: "managed_node",
    dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" },
    extensions: { intent_aliases: ["drawing.edit"] },
  } });
  const resolved = await router.resolve({
    job: job({ operation: "images.edits", model: "drawing.edit", profileId: AUX_FLUX_PROFILE }),
    request: drawingAuthorization({ modelAlias: "drawing.edit", operation: "images.edits", profileId: AUX_FLUX_PROFILE }),
    localAvailable: false,
  });
  assert.equal(resolved.selected, null);
});

test("fails advanced Drawing closed without an exact server authorization tuple", async () => {
  const providerValue = provider({ providerKind: "managed_node", modelMappings: [{ modelProfileId: LONGCAT_PROFILE,
    providerModelName: "longcat", operations: ["images.generations"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue, profileDocument: {
    executionKind: "managed_node",
    dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" },
    extensions: { intent_roles: ["quality"] },
  } });
  const selectedJob = job({ operation: "images.generations", model: "drawing.high-quality",
    profileId: LONGCAT_PROFILE });
  const missing = await router.resolve({ job: selectedJob, request: {}, localAvailable: false });
  assert.equal(missing.selected, null);
  const forged = await router.resolve({
    job: selectedJob,
    request: drawingAuthorization({ modelAlias: "drawing.chinese-poster", operation: "images.generations",
      profileId: LONGCAT_PROFILE }),
    localAvailable: false,
  });
  assert.equal(forged.selected, null);
});

test("does not treat an arbitrary exact Drawing profile UUID as authorization", async () => {
  const providerValue = provider({ providerKind: "managed_node", modelMappings: [{ modelProfileId: PROFILE,
    providerModelName: "arbitrary-image", operations: ["images.generations"], routingWeight: 100, enabled: true }] });
  const { router } = createRouter({ providerValue, profileDocument: {
    executionKind: "managed_node",
    dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" },
  } });
  const resolved = await router.resolve({
    job: job({ operation: "images.generations", model: "local/image", profileId: PROFILE }),
    request: {}, localAvailable: false,
  });
  assert.equal(resolved.selected, null);
  assert.equal(resolved.reasonCode, "routing.no_external_target");
});

test("deduplicates concurrent model preparation and unloads only after every active drawing releases", async () => {
  const timers = [];
  const cancelled = [];
  const providerValue = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
      statusPath: "/models/status", idleSeconds: 180 },
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "sdxl-fp16",
      operations: ["images.generations"], routingWeight: 100, enabled: true }],
  });
  const { router, calls } = createRouter({
    providerValue,
    requestResult(input) {
      if (input.path === "/models/prepare") return { status: 200, headers: {}, body: { status: "ready", loaded: true, model: "sdxl-fp16" } };
      if (input.path === "/models/unload") return { status: 200, headers: {}, body: { status: "unloaded", loaded: false, model: "sdxl-fp16" } };
      return { status: 200, headers: {}, body: {} };
    },
    schedule(operation, milliseconds) {
      const timer = { operation, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancelSchedule(timer) { cancelled.push(timer); },
  });
  const route = (await router.resolve({ job: job({ operation: "images.generations" }), request: {}, localAvailable: false })).selected;
  const prepared = await Promise.all([router.prepareModel(route), router.prepareModel(route)]);
  assert.equal(prepared.every((value) => value.controlled && value.loaded), true);
  assert.equal(calls.filter((entry) => entry[0] === "request" && entry[1].path === "/models/prepare").length, 1);
  assert.equal(router.releaseModel(route).scheduled, false);
  const release = router.releaseModel(route);
  assert.deepEqual(release, { controlled: true, scheduled: true, idleSeconds: 180 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, 180_000);
  await timers[0].operation();
  assert.equal(calls.filter((entry) => entry[0] === "request" && entry[1].path === "/models/unload").length, 1);
  assert.equal(cancelled.length, 0);
});

test("a new drawing request cancels pending idle unload and reuses the prepared model", async () => {
  const timers = [];
  const cancelled = [];
  const providerValue = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
      statusPath: "/models/status", idleSeconds: 10 },
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "sdxl-fp16",
      operations: ["images.generations"], routingWeight: 100, enabled: true }],
  });
  const { router, calls } = createRouter({
    providerValue,
    requestResult(input) {
      return input.path === "/models/prepare"
        ? { status: 200, headers: {}, body: { status: "ready", loaded: true, model: "sdxl-fp16" } }
        : input.path === "/models/status"
        ? { status: 200, headers: {}, body: { status: "ready", loaded: true, model: "sdxl-fp16" } }
        : { status: 200, headers: {}, body: { status: "unloaded", loaded: false, model: "sdxl-fp16" } };
    },
    schedule(operation, milliseconds) { const timer = { operation, milliseconds, unref() {} }; timers.push(timer); return timer; },
    cancelSchedule(timer) { cancelled.push(timer); },
  });
  const route = (await router.resolve({ job: job({ operation: "images.generations" }), request: {}, localAvailable: false })).selected;
  await router.prepareModel(route);
  router.releaseModel(route);
  const warm = await router.prepareModel(route);
  assert.equal(warm.warmReuse, true);
  assert.equal(cancelled.length, 1);
  assert.equal(calls.filter((entry) => entry[0] === "request" && entry[1].path === "/models/prepare").length, 1);
  assert.equal(calls.filter((entry) => entry[0] === "request" && entry[1].path === "/models/status").length, 1);
  router.close();
});

test("stale in-memory residency is rechecked and prepared again before reuse", async () => {
  let loaded = false;
  const providerValue = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
      statusPath: "/models/status", idleSeconds: 10 },
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "sdxl-fp16",
      operations: ["images.generations"], routingWeight: 100, enabled: true }],
  });
  const { router, calls } = createRouter({
    providerValue,
    requestResult(input) {
      if (input.path === "/models/prepare") {
        loaded = true;
        return { status: 200, headers: {}, body: { status: "ready", loaded: true, model: "sdxl-fp16" } };
      }
      if (input.path === "/models/status") {
        return { status: 200, headers: {}, body: { status: loaded ? "ready" : "unloaded", loaded, model: "sdxl-fp16" } };
      }
      return { status: 200, headers: {}, body: { status: "unloaded", loaded: false, model: "sdxl-fp16" } };
    },
    schedule(operation, milliseconds) { return { operation, milliseconds, unref() {} }; },
  });
  const route = (await router.resolve({ job: job({ operation: "images.generations" }), request: {}, localAvailable: false })).selected;
  await router.prepareModel(route);
  router.releaseModel(route);
  loaded = false;
  const prepared = await router.prepareModel(route);
  assert.equal(prepared.warmReuse, false);
  assert.equal(calls.filter((entry) => entry[0] === "request" && entry[1].path === "/models/status").length, 1);
  assert.equal(calls.filter((entry) => entry[0] === "request" && entry[1].path === "/models/prepare").length, 2);
  router.close();
});

test("external drawing never acquires local exclusive residency", async () => {
  const timers = [];
  const residency = [];
  const coordinator = {
    async acquire(input) { residency.push(["acquire", input]); return { jobId: input.jobId, nodeExclusive: true }; },
    async release(input) { residency.push(["release", input.outcome]); },
  };
  const providerValue = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
      statusPath: "/models/status", idleSeconds: 10 },
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "sdxl-fp16",
      operations: ["images.generations"], routingWeight: 100, enabled: true }],
  });
  const { router, calls } = createRouter({ providerValue, managedModelResidencyCoordinator: coordinator,
    profileDocument: { exclusive: true, dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" } },
    requestResult(input) {
      return input.path === "/models/prepare"
        ? { status: 200, headers: {}, body: { status: "ready", loaded: true, model: "sdxl-fp16" } }
        : { status: 200, headers: {}, body: { status: "unloaded", loaded: false, model: "sdxl-fp16" } };
    },
    schedule(operation, milliseconds) { const timer = { operation, milliseconds, unref() {} }; timers.push(timer); return timer; },
  });
  const selectedJob = job({ operation: "images.generations" });
  const route = (await router.resolve({ job: selectedJob, request: {}, localAvailable: false })).selected;
  await assert.rejects(() => router.prepareModel(route, undefined, { jobId: selectedJob.jobId, ownerIdentityId: OWNER }),
    {code:'provider_model_exclusive_unavailable'});
  assert.deepEqual(residency, []);
  assert.equal(calls.filter((entry) => entry[0] === "request").length, 0);
  assert.equal(timers.length, 0);
});

test("exclusive drawing fails closed when managed residency is unavailable", async () => {
  const providerValue = provider({
    resourceControl: { mode: "model_api", preparePath: "/models/prepare", unloadPath: "/models/unload",
      statusPath: "/models/status", idleSeconds: 10 },
    modelMappings: [{ modelProfileId: PROFILE, providerModelName: "sdxl-fp16",
      operations: ["images.generations"], routingWeight: 100, enabled: true }],
  });
  const { router } = createRouter({ providerValue,
    profileDocument: { exclusive: true, dataPolicy: { allowedDataClasses: ["confidential"], externalProcessing: "approved_only" } },
  });
  const selectedJob = job({ operation: "images.generations" });
  const route = (await router.resolve({ job: selectedJob, request: {}, localAvailable: false })).selected;
  await assert.rejects(() => router.prepareModel(route, undefined, { jobId: selectedJob.jobId }),
    { code: "provider_model_exclusive_unavailable" });
});
