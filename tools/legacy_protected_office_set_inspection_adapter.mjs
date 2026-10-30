#!/usr/bin/env node
/**
 * Digest-pinned, post-transaction read-only inspection adapter.
 *
 * This adapter uses the Platform container's existing managed-node mTLS/HMAC
 * credentials and invokes only `protected-set.transaction.inspect`. The Node
 * Agent assembles the response from its fsynced migration journal and fresh,
 * exact-name Docker GET inspections. No plan, transition response, static
 * JSON file, or Platform-local journal is accepted as an observation source.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createLegacyProtectedSetClient } from "./legacy_protected_office_set_node_adapter.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = /^legacy-to-canonical-protected-office-set-[0-9]{8}-a[1-9][0-9]*$/;
const NODE_KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROTOCOL = "teamaibox.legacy-protected-office-set-inspection.v1";
const FAILURE_STAGES = new Set(["pre-dispatch", "runtime", "transport", "command"]);
const FAILURE_CLASSIFICATIONS = new Set([
  "request_invalid",
  "source_binding_invalid",
  "identity_material_unavailable",
  "client_runtime_incompatible",
  "node_agent_transport_failed",
  "node_agent_command_failed",
  "adapter_runtime_failed",
]);
const TARGET_KEYS = Object.freeze([
  "office.embedding-qwen3", "office.asr-whisper", "office.ocr-hunyuan",
  "office.translation-lmt4", "office.assistant-qwen38", "office.drawing-flux2",
]);
const SLOTS = Object.freeze(TARGET_KEYS.map((value) => value.slice("office.".length)));
const SENSITIVE = /password|secret|private.?key|authorization|cookie|raw.?environment|command.?output|user.?content/i;

class InspectionBoundaryError extends Error {
  constructor(stage, classification, cause = null) {
    super(classification, cause == null ? undefined : { cause });
    this.name = "InspectionBoundaryError";
    this.stage = stage;
    this.classification = classification;
  }
}

function fail(message) { throw new Error(message); }
function digest(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function boundaryError(stage, classification, error) {
  if (error instanceof InspectionBoundaryError) return error;
  return new InspectionBoundaryError(stage, classification, error);
}

export function safeInspectionFailure(error) {
  const known = error instanceof InspectionBoundaryError
    && FAILURE_STAGES.has(error.stage)
    && FAILURE_CLASSIFICATIONS.has(error.classification);
  return Object.freeze({
    schemaVersion: 1,
    protocol: PROTOCOL,
    status: "failed",
    failureDiagnostics: Object.freeze({
      stage: known ? error.stage : "runtime",
      classification: known ? error.classification : "adapter_runtime_failed",
      // This adapter has no mutating capability.  A failed inspection can
      // never make the protected-set transition outcome more uncertain.
      commandDispatched: false,
      retryable: false,
    }),
    privacy: Object.freeze({
      credentialsRetained: false,
      requestBodyRetained: false,
      commandOutputRetained: false,
      rawErrorRetained: false,
      pathsRetained: false,
    }),
  });
}
async function stdinObject(maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > maximumBytes) fail("legacy protected-set inspection request is too large");
    chunks.push(chunk);
  }
  if (size < 2) fail("legacy protected-set inspection request is missing");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("legacy protected-set inspection request encoding is invalid"); }
}
function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}
function redacted(value, path = "inspection") {
  if (Array.isArray(value)) return value.forEach((item, index) => redacted(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE.test(key) && !new Set([false, null, "redacted"]).has(child)) {
      fail(`legacy protected-set inspector returned a sensitive field at ${path}.${key}`);
    }
    redacted(child, `${path}.${key}`);
  }
}

function exactRequest(value) {
  if (!exactKeys(value, [
    "schemaVersion", "protocol", "runId", "mode", "inspectionAdapterDigest",
    "route", "transaction",
  ]) || value.schemaVersion !== 1 || value.protocol !== PROTOCOL
      || !RUN_ID.test(value.runId ?? "") || !new Set(["fault", "success"]).has(value.mode)
      || !SHA256.test(value.inspectionAdapterDigest ?? "")) {
    fail("legacy protected-set inspection request is invalid");
  }
  const route = value.route;
  if (!exactKeys(route, ["nodeId", "nodeKey", "nodeGeneration", "certificateFingerprint"])
      || !UUID.test(route.nodeId ?? "") || !NODE_KEY.test(route.nodeKey ?? "")
      || !Number.isSafeInteger(route.nodeGeneration) || route.nodeGeneration < 1
      || !SHA256.test(route.certificateFingerprint ?? "")) {
    fail("legacy protected-set inspection route is invalid");
  }
  const transaction = value.transaction;
  if (!exactKeys(transaction, [
    "transactionId", "migrationPlanId", "migrationPlanDigest", "correlationId",
  ]) || !UUID.test(transaction.transactionId ?? "")
      || !NODE_KEY.test(transaction.migrationPlanId ?? "")
      || !SHA256.test(transaction.migrationPlanDigest ?? "")
      || !CORRELATION.test(transaction.correlationId ?? "")) {
    fail("legacy protected-set inspection transaction binding is invalid");
  }
  return structuredClone(value);
}

function commonFacts(input, observed) {
  return {
    schemaVersion: 1,
    readOnly: true,
    mutationCount: 0,
    runId: input.runId,
    transactionId: observed.transactionId,
    nodeId: observed.nodeId,
    nodeGeneration: observed.nodeGeneration,
    migrationPlanId: observed.migrationPlanId,
    migrationPlanDigest: observed.migrationPlanDigest,
    nodeAgentSoleDockerMutator: true,
    restartPersistenceObserved: false,
  };
}

function faultFacts(input, observed) {
  if (observed.runtimeState !== "legacy-exact" || observed.journal.phase !== "recovered"
      || observed.journal.failureCode !== "protected_set_transition_stage_failed"
      || observed.journal.faultInjectionConsumed !== true
      || observed.journal.faultInjectionStageOrder !== 4
      || observed.journal.faultInjectionTargetKey !== "office.translation-lmt4"
      || observed.journal.faultInjectionAfterHealthy !== true
      || observed.targets.some((item, index) => item.targetKey !== TARGET_KEYS[index]
        || item.stageOrder !== index + 1 || item.runtimeState !== "legacy-exact"
        || item.legacyPrimary?.exact !== true || item.legacyPrimary?.state !== "running"
        || item.legacyPrimary?.health !== "healthy" || item.legacyPrimary?.oomKilled !== false
        || item.legacyDependents.some((child) => child.exact !== true || child.state !== "running"
          || child.health !== "healthy" || child.oomKilled !== false))) {
    fail("Node Agent fault inspection did not prove exact recovered state");
  }
  return {
    ...commonFacts(input, observed),
    failureTargetStageOrder: observed.journal.faultInjectionStageOrder,
    failureTargetKey: observed.journal.faultInjectionTargetKey,
    stage4ActuallyHealthyBeforeFault: observed.journal.faultInjectionAfterHealthy,
    observedFailureCode: observed.journal.failureCode,
    journalPhase: observed.journal.phase,
    journalRecovered: true,
    rollbackTargetKeys: [...observed.rollbackTargetKeys],
    actualRuntimeReconciled: true,
    sourceSetDigestAfterRecovery: observed.sourceSetDigest,
    canonicalContainersRemaining: [...observed.canonicalContainersRemaining],
    rollbackContainersRemaining: [...observed.rollbackContainersRemaining],
    transitionHelpersRemaining: [...observed.transitionHelpersRemaining],
    oomKilled: observed.oomKilled,
  };
}

function successFacts(input, observed) {
  if (observed.runtimeState !== "desired-exact" || observed.journal.phase !== "complete"
      || observed.targets.some((item, index) => item.targetKey !== TARGET_KEYS[index]
        || item.stageOrder !== index + 1 || item.runtimeState !== "desired-exact"
        || item.desired?.exact !== true || item.desired?.state !== "running"
        || item.desired?.health !== "healthy" || item.desired?.networkMode !== "compute-internal"
        || item.desired?.oomKilled !== false || item.mountsExact !== true
        || item.readOnlyModelMount !== true
        || item.modelMaterialMode !== (index === 1 ? "image-contained" : "read-only-mounts")
        || item.healthcheckExact !== true
        || item.runtimeLimitsExact !== true)) {
    fail("Node Agent success inspection did not prove exact desired state");
  }
  const profiles = observed.targets.map((target, index) => ({
    slot: SLOTS[index],
    workerId: target.workerId,
    modelProfileId: target.modelProfileId,
    containerName: target.desired.containerName,
    containerId: target.desired.containerId,
    state: target.desired.state,
    health: target.desired.health,
    network: target.desired.networkMode,
    imageReference: target.desired.imageReference,
    imageManifestDigest: target.desired.imageManifestDigest,
    imageConfigId: target.desired.imageId,
    startSpecDigest: target.desired.startSpecDigest,
    runtimeDigest: target.desired.runtimeDigest,
    mountsExact: target.mountsExact,
    readOnlyModelMount: target.readOnlyModelMount,
    modelMaterialMode: target.modelMaterialMode,
    healthcheckExact: target.healthcheckExact,
    runtimeLimitsExact: target.runtimeLimitsExact,
    companions: target.desiredCompanions.map((companion) => ({
      parentWorkerId: target.workerId,
      containerName: companion.containerName,
      containerId: companion.containerId,
      network: companion.networkMode,
      networkNamespaceMode: "bridge-dns",
      state: companion.state,
      health: companion.health,
      imageReference: companion.imageReference,
      imageManifestDigest: companion.imageManifestDigest,
      imageConfigId: companion.imageId,
      startSpecDigest: companion.startSpecDigest,
      runtimeDigest: companion.runtimeDigest,
    })),
    ...(target.legacyHostNetworkRemoved ? { legacyHostNetworkRemoved: true } : {}),
    ...(target.tmpfsExecutable ? { tmpfsExecutable: true } : {}),
  }));
  return {
    ...commonFacts(input, observed),
    journalPhase: observed.journal.phase,
    journalDurable: true,
    transitionPlanDigest: observed.journal.planDigest,
    commitAfterCompleteSetHealth: true,
    crashRecoveryModel: "exact-runtime-reconciliation",
    stageTargetKeys: observed.targets.map((item) => item.targetKey),
    sourceSetDigest: observed.sourceSetDigest,
    desiredSetDigest: observed.desiredSetDigest,
    aggregateHealthy: true,
    profiles,
    legacyCleanup: {
      originalContainersRemaining: [],
      rollbackContainersRemaining: [...observed.rollbackContainersRemaining],
      transitionHelpersRemaining: [...observed.transitionHelpersRemaining],
      exactOwnedCleanup: true,
    },
  };
}

export async function inspectLegacyProtectedSet(requestValue, {
  adapterBytes,
  read = readFile,
  clientFactory = createLegacyProtectedSetClient,
  environment = process.env,
} = {}) {
  let input;
  try { input = exactRequest(requestValue); }
  catch (error) { throw boundaryError("pre-dispatch", "request_invalid", error); }
  let ownSource;
  try { ownSource = adapterBytes ?? await read(fileURLToPath(import.meta.url)); }
  catch (error) { throw boundaryError("pre-dispatch", "source_binding_invalid", error); }
  if (!Buffer.isBuffer(ownSource) || digest(ownSource) !== input.inspectionAdapterDigest) {
    throw boundaryError("pre-dispatch", "source_binding_invalid");
  }
  let client;
  try { client = await clientFactory(input.route, { environment, read }); }
  catch (error) {
    throw boundaryError("pre-dispatch", "identity_material_unavailable", error);
  }
  if (!client || typeof client.inspectProtectedSetTransition !== "function") {
    await client?.close?.();
    throw boundaryError("pre-dispatch", "client_runtime_incompatible");
  }
  try {
    try {
      const observed = await client.inspectProtectedSetTransition({
        transactionId: input.transaction.transactionId,
        migrationPlanId: input.transaction.migrationPlanId,
        migrationPlanDigest: input.transaction.migrationPlanDigest,
        mode: input.mode,
        correlationId: input.transaction.correlationId,
      });
      const facts = input.mode === "fault" ? faultFacts(input, observed) : successFacts(input, observed);
      redacted(facts);
      return Object.freeze({
        schemaVersion: 1,
        protocol: PROTOCOL,
        runId: input.runId,
        mode: input.mode,
        status: "passed",
        inspectionAdapterDigest: input.inspectionAdapterDigest,
        readOnly: true,
        mutationCount: 0,
        facts: structuredClone(facts),
        privacy: {
          credentialsRetained: false,
          requestBodyRetained: false,
          commandOutputRetained: false,
          userContentRetained: false,
        },
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw boundaryError("pre-dispatch", "client_runtime_incompatible", error);
      }
      const transportFailure = new Set([
        "node_agent_transport_unavailable", "node_agent_tls_failed", "node_agent_protocol_mismatch",
        "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT",
      ]).has(error?.code);
      throw boundaryError(
        transportFailure ? "transport" : "command",
        transportFailure ? "node_agent_transport_failed" : "node_agent_command_failed",
        error,
      );
    }
  } finally {
    await client.close?.();
  }
}

async function main() {
  let request;
  try {
    if (process.env.TEAMAIBOX_LEGACY_CONTROLLER_INPUT === "stdin") {
      request = await stdinObject(1 << 20);
    } else {
      const encoded = process.env.TEAMAIBOX_LEGACY_PROTECTED_SET_INSPECTION_B64;
      if (typeof encoded !== "string" || encoded.length < 8 || encoded.length > (1 << 20)) {
        fail("legacy protected-set inspection request is missing");
      }
      try { request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
      catch { fail("legacy protected-set inspection request encoding is invalid"); }
    }
  } catch (error) {
    throw boundaryError("pre-dispatch", "request_invalid", error);
  }
  process.stdout.write(`${JSON.stringify(await inspectLegacyProtectedSet(request))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(safeInspectionFailure(error))}\n`);
    process.exitCode = 1;
  });
}
