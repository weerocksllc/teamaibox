import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import {
  createProtectedOfficeSetControlHandler,
  createProtectedOfficeSetDeploymentDriver,
  createProtectedOfficeSetProductionRuntime,
  inspectProtectedOfficeSetDeployment,
  protectedOfficeSetControlRoutes,
} from "../server/protected-office-set-deployment-runtime.mjs";
import { protectedOfficeDeploymentActions } from "../../../services/scheduler/src/protected-office-set-deployment-driver.mjs";

const KEY_PATH = "/run/teamaibox/protected-office-set/office-set-control.key";
const KEY = Buffer.alloc(32, 19).toString("base64url");
const ENVIRONMENT = Object.freeze({
  PLATFORM_APPLIANCE_NODE_ID: "00000000-0000-4000-8000-000000000101",
  PLATFORM_PROTECTED_OFFICE_SET_CONTROL_ORIGIN: "http://127.0.0.1:18081",
  PLATFORM_PROTECTED_OFFICE_SET_CONTROL_KEY_FILE: KEY_PATH,
  PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE:
    "/run/teamaibox/maintenance-keys/protected-office.ed25519.json",
});
const NODE_ID = "00000000-0000-4000-8000-000000000101";
const RUN_ID = "protected-office-set-deployment-20260905-a1";

function keyFileSystem({ resolved = KEY_PATH, symbolic = false, value = KEY } = {}) {
  return Object.freeze({
    async realpath() { return resolved; },
    async lstat() {
      return Object.freeze({ isFile: () => true, isSymbolicLink: () => symbolic, size: value.length + 1 });
    },
    async readFile() { return Buffer.from(`${value}\n`, "utf8"); },
  });
}

function jsonResponse(value, { status = 200, contentType = "application/json" } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return Object.freeze({
    status,
    headers: Object.freeze({ get(name) { return name.toLowerCase() === "content-type" ? contentType : null; } }),
    async arrayBuffer() { return bytes; },
  });
}

function passed(kind, result) {
  return {
    schemaVersion: 1,
    protocol: "teamaibox.protected-office-set-control.v1",
    kind,
    status: "passed",
    result,
  };
}

test("production loopback transport waits for delayed headers and bounds the complete response", async (t) => {
  let behavior = "delayed";
  const server = createServer((request, response) => {
    assert.equal(request.headers["x-teamaibox-protected-office-control"], KEY);
    request.resume();
    if (behavior === "redirect") { response.writeHead(302, { location: "http://10.64.0.23/" }); response.end(); return; }
    if (behavior === "oversized") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.alloc(8 * 1024 * 1024 + 1)); return;
    }
    if (behavior === "timeout") return;
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(passed("action", { state: "healthy" })));
    }, 150);
    response.once("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const driver = await createProtectedOfficeSetDeploymentDriver({
    environment: { ...ENVIRONMENT,
      PLATFORM_PROTECTED_OFFICE_SET_CONTROL_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      PLATFORM_PROTECTED_OFFICE_SET_CONTROL_TIMEOUT_MS: "1000" },
    fileSystem: keyFileSystem(),
  });
  assert.deepEqual(await driver.preflight({ runId: RUN_ID }), { state: "healthy" });
  for (behavior of ["redirect", "oversized", "timeout"]) {
    const started = performance.now();
    await assert.rejects(driver.preflight({ runId: RUN_ID }), /control transport failed/);
    assert.ok(performance.now() - started < 2500);
  }
});

test("adapter-facing driver uses only authenticated loopback control and preserves the exact action", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(passed("action", { proof: { source: "postgres" }, state: "ok" }));
  };
  const driver = await createProtectedOfficeSetDeploymentDriver({
    environment: ENVIRONMENT, fetcher, fileSystem: keyFileSystem(),
  });
  const input = { runId: RUN_ID, marker: "exact" };
  assert.deepEqual(await driver["cold-boot"](input), {
    proof: { source: "postgres" }, state: "ok",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18081/internal/v1/protected-office-set/action");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["x-teamaibox-protected-office-control"], KEY);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: "cold-boot", input });
  assert.deepEqual(protectedOfficeDeploymentActions.filter((action) => typeof driver[action] !== "function"), []);
});

test("adapter-facing inspection is loopback-only and fails closed on unsafe key or response", async () => {
  const result = await inspectProtectedOfficeSetDeployment({
    runId: RUN_ID,
    nonce: "abcdefghijklmnopqrstuvwxyz",
    plan: { schemaVersion: 1 },
    environment: ENVIRONMENT,
    fileSystem: keyFileSystem(),
    fetcher: async () => jsonResponse(passed("inspection", {
      readOnly: true, mutationCount: 0, proof: { source: "independent" },
    })),
  });
  assert.equal(result.readOnly, true);
  await assert.rejects(createProtectedOfficeSetDeploymentDriver({
    environment: { ...ENVIRONMENT, PLATFORM_PROTECTED_OFFICE_SET_CONTROL_ORIGIN: "http://10.64.0.20:18081" },
    fileSystem: keyFileSystem(),
  }), /loopback-only/);
  const driver = await createProtectedOfficeSetDeploymentDriver({
    environment: ENVIRONMENT,
    fileSystem: keyFileSystem({ resolved: "/run/teamaibox/protected-office-set/other.key" }),
    fetcher: async () => jsonResponse(passed("action", { proof: {} })),
  });
  await assert.rejects(driver.preflight({ runId: RUN_ID }), /symbolic link/);
  const bad = await createProtectedOfficeSetDeploymentDriver({
    environment: ENVIRONMENT, fileSystem: keyFileSystem(),
    fetcher: async () => jsonResponse(passed("inspection", { proof: {} })),
  });
  await assert.rejects(bad.preflight({ runId: RUN_ID }), /response is invalid/);
});

test("production factory builds only PostgreSQL, protected Node Agent, memory, maintenance and realtime components", () => {
  const database = { async query() { return { rows: [] }; }, async transaction(callback) { return callback(this); } };
  const nodeAgentRouter = Object.fromEntries([
    "startWorker", "workerHealth", "executeProtectedMaintenanceTransaction", "executeProtectedSetTransition",
  ].map((name) => [name, async () => { throw new Error(`${name} not used by construction`); }]));
  const actionExecutor = Object.fromEntries(protectedOfficeDeploymentActions.map((action) => [action, async () => ({
    proof: { audit: { chainVerified: true } }, action,
  })]));
  actionExecutor.recoverInterruptedAction = async () => {};
  let captured;
  const runtime = createProtectedOfficeSetProductionRuntime({
    environment: ENVIRONMENT,
    database,
    nodeAgentRouter,
    nodeId: NODE_ID,
    nodeGeneration: 3,
    bindingFactory: async () => ({}),
    maintenanceTargetFactory: async () => ({}),
    protectedSetProvider: async () => [],
    realtimePlacementResolver: { async resolve() { return []; } },
    coreServiceProbe: async () => ({ healthy: true }),
    actionExecutorFactory(components) { captured = components; return actionExecutor; },
    inspectionSourceFactory() {
      return Object.fromEntries([
        "postgres-protected-set-transaction", "postgres-protected-set-state",
        "postgres-cluster-metric-raw-snapshot", "postgres-realtime-reservation",
        "casting-session", "mtls-node-agent-inspection", "authenticated-public-https",
      ].map((name) => [name, async () => ({ readOnly: true, mutationCount: 0, name })]));
    },
    resultAssembler: async () => ({ proof: { audit: { chainVerified: true } } }),
  });
  assert.equal(runtime.components, captured);
  assert.equal(runtime.components.actionRepository.constructor.name,
    "PostgresProtectedOfficeDeploymentActionRepository");
  assert.equal(runtime.components.setRepository.constructor.name, "PostgresProtectedOfficeSetRepository");
  assert.equal(runtime.components.placementRepository.constructor.name, "PostgresAppliancePlacementRepository");
  assert.equal(runtime.components.clusterMetricRepository.constructor.name, "PostgresClusterMetricRepository");
  assert.equal(runtime.components.realtimeReservationRepository.constructor.name,
    "PostgresRealtimeReservationRepository");
  assert.equal(runtime.components.realtimeReservationManager.constructor.name, "RealtimeReservationManager");
  assert.equal(runtime.components.maintenanceVerifier.constructor.name,
    "ProductionProtectedMaintenanceSignatureVerifier");
  assert.equal(runtime.components.nodeAgentRuntime.constructor.name, "ProtectedOfficeSetNodeAgentRuntime");
  assert.equal(runtime.components.coordinator.constructor.name, "ProtectedOfficeSetCoordinator");
  assert.throws(() => createProtectedOfficeSetProductionRuntime({}), /database is incomplete/);
});

test("framework-neutral control handler authenticates exact key and loopback peer before dispatch", async () => {
  const calls = [];
  const handler = await createProtectedOfficeSetControlHandler({
    environment: ENVIRONMENT,
    fileSystem: keyFileSystem(),
    runtime: {
      async dispatchAction(action, input) { calls.push({ action, input }); return { proof: {}, state: "ok" }; },
      async inspect(input) { calls.push({ inspect: input }); return { proof: {}, readOnly: true, mutationCount: 0 }; },
    },
  });
  const action = await handler.handle({
    method: "POST", path: protectedOfficeSetControlRoutes.action, remoteAddress: "127.0.0.1",
    headers: { "x-teamaibox-protected-office-control": KEY },
    body: { action: "preflight", input: { runId: RUN_ID } },
  });
  assert.equal(action.kind, "action");
  assert.deepEqual(calls[0], { action: "preflight", input: { runId: RUN_ID } });
  const inspection = await handler.handle({
    method: "POST", path: protectedOfficeSetControlRoutes.inspection, remoteAddress: "::1",
    headers: { "x-teamaibox-protected-office-control": KEY }, body: { runId: RUN_ID },
  });
  assert.equal(inspection.kind, "inspection");
  await assert.rejects(handler.handle({
    method: "POST", path: protectedOfficeSetControlRoutes.action, remoteAddress: "10.64.0.20",
    headers: { "x-teamaibox-protected-office-control": KEY }, body: {},
  }), /not permitted/);
  await assert.rejects(handler.handle({
    method: "POST", path: protectedOfficeSetControlRoutes.action, remoteAddress: "127.0.0.1",
    headers: { "x-teamaibox-protected-office-control": Buffer.alloc(32, 7).toString("base64url") }, body: {},
  }), /authentication failed/);
  handler.close();
  await assert.rejects(handler.handle({
    method: "POST", path: protectedOfficeSetControlRoutes.action, remoteAddress: "127.0.0.1",
    headers: { "x-teamaibox-protected-office-control": KEY }, body: {},
  }), /not permitted/);
});
