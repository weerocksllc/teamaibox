import { timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";

import { PostgresClusterMetricRepository } from "../../../services/scheduler/src/postgres-cluster-metric-repository.mjs";
import { PostgresAppliancePlacementRepository } from "../../../services/scheduler/src/postgres-appliance-placement-repository.mjs";
import { PostgresProtectedOfficeDeploymentActionRepository } from "../../../services/scheduler/src/postgres-protected-office-deployment-action-repository.mjs";
import { PostgresProtectedOfficeSetRepository } from "../../../services/scheduler/src/postgres-protected-office-set-repository.mjs";
import { PostgresRealtimeReservationRepository } from "../../../services/scheduler/src/postgres-realtime-reservation-repository.mjs";
import {
  ProductionProtectedOfficeSetDeploymentDriver,
  ProductionProtectedOfficeSetDeploymentInspector,
  protectedOfficeDeploymentActions,
} from "../../../services/scheduler/src/protected-office-set-deployment-driver.mjs";
import { ProtectedOfficeSetCoordinator } from "../../../services/scheduler/src/protected-office-set-coordinator.mjs";
import { ProtectedOfficeSetNodeAgentRuntime } from "../../../services/scheduler/src/protected-office-set-node-agent-runtime.mjs";
import { createPostgresUnifiedMemoryProtection } from "../../../services/scheduler/src/postgres-unified-memory-snapshot-provider.mjs";
import { ProductionProtectedMaintenanceSignatureVerifier } from "../../../services/scheduler/src/production-protected-maintenance-signature-verifier.mjs";
import { RealtimeReservationManager } from "../../../services/scheduler/src/realtime-reservation-manager.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_FILE = /^\/run\/(?:secrets|teamaibox\/protected-office-set)\/[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/;
const KEY_TEXT = /^[A-Za-z0-9_-]{43,86}$/;
const MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_CONTROL_TIMEOUT_MILLISECONDS = 15 * 60_000;
const ACTION_ROUTE = "/internal/v1/protected-office-set/action";
const INSPECTION_ROUTE = "/internal/v1/protected-office-set/inspection";

function exactEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("protected office-set environment is invalid");
  }
  return environment;
}

function controlOrigin(environment) {
  const raw = exactEnvironment(environment).PLATFORM_PROTECTED_OFFICE_SET_CONTROL_ORIGIN;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new TypeError("protected office-set control origin is invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash) {
    throw new TypeError("protected office-set control origin must be loopback-only HTTP");
  }
  return parsed.origin;
}

function timeoutMilliseconds(environment) {
  const raw = exactEnvironment(environment).PLATFORM_PROTECTED_OFFICE_SET_CONTROL_TIMEOUT_MS;
  if (raw == null || raw === "") return MAXIMUM_CONTROL_TIMEOUT_MILLISECONDS;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    throw new TypeError("protected office-set control timeout is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAXIMUM_CONTROL_TIMEOUT_MILLISECONDS) {
    throw new TypeError("protected office-set control timeout is outside its bounded envelope");
  }
  return value;
}

async function protectedControlKey(environment, fileSystem = { lstat, readFile, realpath }) {
  const path = exactEnvironment(environment).PLATFORM_PROTECTED_OFFICE_SET_CONTROL_KEY_FILE;
  if (!KEY_FILE.test(path ?? "")) throw new TypeError("protected office-set control key path is invalid");
  if (!fileSystem?.realpath || !fileSystem?.lstat || !fileSystem?.readFile) {
    throw new TypeError("protected office-set control key filesystem is invalid");
  }
  const resolved = await fileSystem.realpath(path);
  if (resolved !== path) throw new TypeError("protected office-set control key cannot be a symbolic link");
  const stats = await fileSystem.lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 43 || stats.size > 88) {
    throw new TypeError("protected office-set control key is not a bounded regular file");
  }
  const raw = await fileSystem.readFile(path);
  try {
    const encoded = raw.toString("utf8").trim();
    if (!KEY_TEXT.test(encoded)) throw new TypeError("protected office-set control key is invalid");
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength < 32 || key.byteLength > 64 || key.toString("base64url") !== encoded) {
      key.fill(0);
      throw new TypeError("protected office-set control key is invalid");
    }
    return key;
  } finally { raw.fill(0); }
}

function redacted(value, path = "value") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => redacted(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(password|secret|token|private.?key|authorization|cookie|prompt|transcript|image.?bytes|audio.?bytes)/i.test(key)) {
      throw new TypeError(`protected office-set value contains a sensitive field at ${path}.${key}`);
    }
    redacted(child, `${path}.${key}`);
  }
}

function exactResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("protected office-set control result is invalid");
  }
  redacted(value, "result");
  return structuredClone(value);
}

function responseEnvelope(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== 1 || value.protocol !== "teamaibox.protected-office-set-control.v1"
      || value.kind !== kind || value.status !== "passed") {
    throw new TypeError("protected office-set control response is invalid");
  }
  return exactResult(value.result);
}

// A full maintenance action can legitimately take more than five minutes.
// Native fetch has an independent headers timeout even with a longer signal,
// which let the adapter start recovery while the original action was running.
// This loopback-only transport has one total deadline for headers AND body.
function controlRequest(url, options) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const fail = () => {
      for (const chunk of chunks) chunk.fill(0);
      reject(new TypeError("protected office-set control transport failed"));
    };
    const request = httpRequest(url, {
      method: "POST", agent: false, signal: options.signal, maxHeaderSize: 16 * 1024,
      headers: { ...options.headers, "content-length": Buffer.byteLength(options.body) },
    }, (response) => {
      if (response.statusCode !== 200 || response.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
        response.destroy();
        fail();
        return;
      }
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAXIMUM_RESPONSE_BYTES) {
          chunk.fill(0);
          response.destroy();
          fail();
        } else chunks.push(chunk);
      });
      response.once("error", fail);
      response.once("aborted", fail);
      response.once("end", () => {
        const bytes = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        resolve({ status: 200, headers: new Headers(response.headers), async arrayBuffer() { return bytes; } });
      });
    });
    request.once("error", fail);
    request.end(options.body);
  });
}

async function postControl({ environment, fetcher, route, kind, body,
  fileSystem = { lstat, readFile, realpath } }) {
  if (typeof fetcher !== "function") throw new TypeError("protected office-set control fetcher is invalid");
  const origin = controlOrigin(environment);
  const timeout = timeoutMilliseconds(environment);
  const key = await protectedControlKey(environment, fileSystem);
  try {
    const response = await fetcher(`${origin}${route}`, {
      method: "POST",
      headers: Object.freeze({
        "content-type": "application/json",
        "x-teamaibox-protected-office-control": key.toString("base64url"),
      }),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response || response.status !== 200 || response.headers?.get?.("content-type")?.split(";", 1)[0] !== "application/json") {
      throw new TypeError("protected office-set control endpoint failed closed");
    }
    const bytes = await response.arrayBuffer();
    const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    try {
      if (raw.byteLength < 2 || raw.byteLength > MAXIMUM_RESPONSE_BYTES) {
        throw new TypeError("protected office-set control response is outside its bounded envelope");
      }
      let decoded;
      try { decoded = JSON.parse(raw.toString("utf8")); }
      catch { throw new TypeError("protected office-set control response is not JSON"); }
      return responseEnvelope(decoded, kind);
    } finally { raw.fill(0); }
  } finally { key.fill(0); }
}

/**
 * Adapter-facing client. The digest-pinned docker-exec adapter cannot acquire
 * production services from an in-memory singleton, so it talks only to the
 * already-running Platform process over an authenticated loopback endpoint.
 */
export async function createProtectedOfficeSetDeploymentDriver({
  environment = process.env, fetcher = controlRequest, fileSystem = { lstat, readFile, realpath },
} = {}) {
  controlOrigin(environment);
  timeoutMilliseconds(environment);
  const driver = Object.fromEntries(protectedOfficeDeploymentActions.map((action) => [action, (input) => postControl({
    environment, fetcher, route: ACTION_ROUTE,
    kind: "action", body: { action, input }, fileSystem,
  })]));
  driver.close = async () => {};
  return Object.freeze(driver);
}

export async function inspectProtectedOfficeSetDeployment({
  runId, nonce, plan, environment = process.env, fetcher = controlRequest,
  fileSystem = { lstat, readFile, realpath },
} = {}) {
  return postControl({
    environment, fetcher, route: INSPECTION_ROUTE, kind: "inspection",
    body: { runId, nonce, plan }, fileSystem,
  });
}

function databaseAdapter(value) {
  if (!value?.query || !value?.transaction) {
    throw new TypeError("protected office-set production database is incomplete");
  }
  return value;
}

function closeFunctions(values) {
  return async () => {
    const errors = [];
    for (const value of [...values].reverse()) {
      try { await value?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "protected office-set production runtime close failed");
  };
}

/**
 * Builds the trusted in-process graph. Scenario implementation and independent
 * inspection readers are factories so Platform wiring must supply existing
 * production protocol services; the factory itself never substitutes memory
 * repositories, Docker shell access, or self-asserted observations.
 */
export function createProtectedOfficeSetProductionRuntime({
  environment = process.env,
  database,
  nodeAgentRouter,
  nodeId,
  nodeGeneration,
  bindingFactory,
  maintenanceTargetFactory,
  protectedSetProvider,
  realtimePlacementResolver,
  coreServiceProbe,
  actionExecutorFactory,
  inspectionSourceFactory,
  resultAssembler,
  clock = () => new Date(),
  idFactory,
  coordinatorLimits = {},
  close = async () => {},
} = {}) {
  databaseAdapter(database);
  if (!UUID.test(nodeId ?? "") || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1
      || typeof bindingFactory !== "function" || typeof maintenanceTargetFactory !== "function"
      || typeof protectedSetProvider !== "function" || typeof realtimePlacementResolver?.resolve !== "function"
      || typeof coreServiceProbe !== "function" || typeof actionExecutorFactory !== "function"
      || typeof inspectionSourceFactory !== "function" || typeof resultAssembler !== "function"
      || typeof clock !== "function" || (idFactory != null && typeof idFactory !== "function")
      || typeof close !== "function") {
    throw new TypeError("protected office-set production runtime dependencies are incomplete");
  }
  const keyringFile = exactEnvironment(environment).PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE;
  if (typeof keyringFile !== "string") {
    throw new TypeError("protected office-set maintenance keyring is required");
  }
  const actionRepository = new PostgresProtectedOfficeDeploymentActionRepository({ database });
  const setRepository = new PostgresProtectedOfficeSetRepository({ database });
  const placementRepository = new PostgresAppliancePlacementRepository({ database, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID });
  const clusterMetricRepository = new PostgresClusterMetricRepository({ database });
  const realtimeReservationRepository = new PostgresRealtimeReservationRepository({ database });
  const memoryProtection = createPostgresUnifiedMemoryProtection({ database, environment, clock });
  const maintenanceVerifier = new ProductionProtectedMaintenanceSignatureVerifier({ trustedKeyringFile: keyringFile });
  const maintenanceAuthorizer = maintenanceVerifier.verify.bind(maintenanceVerifier);
  const nodeAgentRuntime = new ProtectedOfficeSetNodeAgentRuntime({
    nodeAgentRouter, nodeId, nodeGeneration, bindingFactory, maintenanceTargetFactory,
    protectedSetProvider, maintenanceAuthorizer, clock,
  });
  const coordinator = new ProtectedOfficeSetCoordinator({
    repository: setRepository,
    runtime: nodeAgentRuntime,
    ...memoryProtection,
    placementRepository,
    maintenanceAuthorizer,
    coreServiceProbe,
    clock,
    ...(idFactory ? { idFactory } : {}),
    limits: coordinatorLimits,
  });
  const realtimeReservationManager = new RealtimeReservationManager({
    repository: realtimeReservationRepository,
    placementResolver: realtimePlacementResolver,
    ...memoryProtection,
    clock,
  });
  const components = Object.freeze({
    actionRepository,
    setRepository,
    placementRepository,
    clusterMetricRepository,
    realtimeReservationRepository,
    realtimeReservationManager,
    memoryGuard: memoryProtection.memoryGuard,
    memorySnapshotProvider: memoryProtection.memorySnapshotProvider,
    maintenanceVerifier,
    maintenanceAuthorizer,
    nodeAgentRuntime,
    coordinator,
  });
  const actionExecutor = actionExecutorFactory(components);
  const inspectionSources = inspectionSourceFactory(components);
  const ownedClose = closeFunctions([
    close,
    typeof inspectionSources?.close === "function" ? inspectionSources.close.bind(inspectionSources) : null,
    typeof actionExecutor?.close === "function" ? actionExecutor.close.bind(actionExecutor) : null,
  ]);
  const driver = new ProductionProtectedOfficeSetDeploymentDriver({
    actionRepository, actionExecutor, clock,
  });
  const inspector = new ProductionProtectedOfficeSetDeploymentInspector({
    actionRepository, inspectionSources, resultAssembler,
  });
  return Object.freeze({
    components,
    driver,
    inspector,
    dispatchAction(action, input) {
      if (!protectedOfficeDeploymentActions.includes(action)) {
        throw new TypeError("protected office-set production action is invalid");
      }
      return driver[action](input);
    },
    inspect(input) { return inspector.inspect(input); },
    close: ownedClose,
  });
}

function suppliedControlKey(value) {
  if (typeof value !== "string" || !KEY_TEXT.test(value)) return null;
  const result = Buffer.from(value, "base64url");
  if (result.byteLength < 32 || result.byteLength > 64 || result.toString("base64url") !== value) {
    result.fill(0);
    return null;
  }
  return result;
}

function isLoopbackAddress(value) {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

/** Narrow framework-neutral endpoint handler for the long-running Platform. */
export async function createProtectedOfficeSetControlHandler({
  runtime, environment = process.env, fileSystem = { lstat, readFile, realpath },
} = {}) {
  if (!runtime?.dispatchAction || !runtime?.inspect) {
    throw new TypeError("protected office-set control runtime is incomplete");
  }
  const expectedKey = await protectedControlKey(environment, fileSystem);
  let closed = false;
  return Object.freeze({
    matches(method, path) {
      return !closed && method === "POST" && [ACTION_ROUTE, INSPECTION_ROUTE].includes(path);
    },
    async handle({ method, path, remoteAddress, headers = {}, body }) {
      if (closed || method !== "POST" || !isLoopbackAddress(remoteAddress)
          || ![ACTION_ROUTE, INSPECTION_ROUTE].includes(path)) {
        throw new TypeError("protected office-set control request is not permitted");
      }
      const actualKey = suppliedControlKey(headers["x-teamaibox-protected-office-control"]);
      try {
        if (!actualKey || actualKey.byteLength !== expectedKey.byteLength
            || !timingSafeEqual(actualKey, expectedKey)) {
          throw new TypeError("protected office-set control authentication failed");
        }
      } finally { actualKey?.fill(0); }
      const result = path === ACTION_ROUTE
        ? await runtime.dispatchAction(body?.action, body?.input)
        : await runtime.inspect(body);
      return Object.freeze({
        schemaVersion: 1,
        protocol: "teamaibox.protected-office-set-control.v1",
        kind: path === ACTION_ROUTE ? "action" : "inspection",
        status: "passed",
        result: exactResult(result),
      });
    },
    close() { if (!closed) { closed = true; expectedKey.fill(0); } },
  });
}

export const protectedOfficeSetControlRoutes = Object.freeze({
  action: ACTION_ROUTE,
  inspection: INSPECTION_ROUTE,
});
