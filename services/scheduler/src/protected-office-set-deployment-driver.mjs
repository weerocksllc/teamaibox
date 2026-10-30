import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {
  protectedOfficeDeploymentActionProof,
  protectedOfficeDeploymentResultDigest,
} from "./postgres-protected-office-deployment-action-repository.mjs";

const RUN_ID = /^protected-office-set-deployment(?:-v5)?-[0-9]{8}-a[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{2,127}$/;
const SENSITIVE_KEY = /(password|secret|token|private.?key|authorization|cookie|prompt|transcript|image.?bytes|audio.?bytes)/i;
const SECRET_FILE_REFERENCE = /^\/run\/secrets\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export const protectedOfficeDeploymentActions = Object.freeze([
  "preflight", "cold-boot", "concurrent-office", "bounded-maintenance",
  "restart-verify", "mid-sequence-failure", "final-inspect", "recover", "cleanup",
]);

export const protectedOfficeDeploymentProductionComponents = Object.freeze([
  "PostgresProtectedOfficeSetRepository",
  "createPostgresUnifiedMemoryProtection",
  "PostgresAppliancePlacementRepository",
  "ProtectedOfficeSetNodeAgentRuntime",
  "ProtectedOfficeSetCoordinator",
  "ManagedNodeAgentRouter.executeProtectedSetTransition",
  "ProtectedNodeAgentClient.mTLS+HMAC",
  "NodeAgent.protected-set-journal",
  "PostgresClusterMetricRepository",
  "RealtimeReservationManager",
  "PostgresRealtimeReservationRepository",
  "ProductionProtectedMaintenanceSignatureVerifier",
  "PostgresProtectedOfficeDeploymentActionRepository",
]);

export const protectedOfficeDeploymentInspectionSources = Object.freeze([
  "postgres-protected-set-transaction",
  "postgres-protected-set-state",
  "postgres-cluster-metric-raw-snapshot",
  "postgres-realtime-reservation",
  "casting-session",
  "mtls-node-agent-inspection",
  "authenticated-public-https",
]);

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("protected deployment request contains an unsafe number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("protected deployment request is not canonical JSON");
}

function assertRedacted(value, path = "value") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRedacted(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new TypeError(`protected deployment value contains a sensitive field at ${path}.${key}`);
    assertRedacted(child, `${path}.${key}`);
  }
}

function assertPlanRedacted(value, path = "plan") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlanRedacted(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const upper = key.toUpperCase();
    // A fencing token is a monotonically increasing concurrency counter, not
    // an authentication token.  V5 binds the already-running protected
    // workers to their exact lease fence, so this integer must cross the
    // deployment-plan boundary while all credential-shaped token fields stay
    // forbidden.
    const safeFencingToken = key === "fencingToken"
      && Number.isSafeInteger(child) && child >= 1;
    const safeTokenCount = upper.endsWith("_TOKENS")
      && ((Number.isSafeInteger(child) && child >= 0) || (typeof child === "string" && /^(0|[1-9][0-9]*)$/.test(child)));
    const safeTokenizerCache = upper === "TIKTOKEN_CACHE_DIR"
      && typeof child === "string" && /^\/tmp\/tiktoken(?:\/|$)/.test(child);
    const safeSecretFileReference = upper.endsWith("_FILE")
      && SENSITIVE_KEY.test(key) && typeof child === "string" && SECRET_FILE_REFERENCE.test(child);
    if (safeFencingToken || safeTokenCount || safeTokenizerCache || safeSecretFileReference) continue;
    if (SENSITIVE_KEY.test(key)) {
      throw new TypeError(`protected deployment plan contains a sensitive field at ${path}.${key}`);
    }
    assertPlanRedacted(child, `${path}.${key}`);
  }
}

function request(value, action) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.runId == null || !RUN_ID.test(value.runId)
      || value.action !== action || !UUID.test(value.actionId ?? "")
      || !SHA256.test(value.idempotencyKey ?? "") || !NONCE.test(value.nonce ?? "")
      || !value.plan || typeof value.plan !== "object" || Array.isArray(value.plan)) {
    throw new TypeError("protected deployment action request is invalid");
  }
  assertPlanRedacted(value.plan);
  return structuredClone(value);
}

function requestDigest(value) {
  const bytes = Buffer.from(canonicalJson({
    schemaVersion: 1,
    protocol: "teamaibox.protected-office-set-driver.v1",
    runId: value.runId,
    action: value.action,
    actionId: value.actionId.toLowerCase(),
    idempotencyKey: value.idempotencyKey,
    plan: value.plan,
  }), "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function failureCode(error, stage = "result_contract") {
  if (ERROR_CODE.test(error?.code ?? "")) return error.code;
  if (error instanceof TypeError) {
    const message = String(error.message ?? "");
    if (message.includes("contains an unsafe number")) {
      return "protected_deployment_result_unsafe_number";
    }
    if (message.includes("contains a sensitive field")) {
      return "protected_deployment_result_sensitive_field";
    }
    if (message.includes("is not canonical JSON")) {
      return "protected_deployment_result_noncanonical_json";
    }
    if (message.includes("outside its bounded envelope")) {
      return "protected_deployment_result_bounded_envelope_invalid";
    }
    if (message.includes("result digest drifted")) {
      return "protected_deployment_result_digest_drift";
    }
    if (message.includes("invalid proof boundary") || message.includes("may not claim")) {
      return "protected_deployment_result_proof_boundary_invalid";
    }
    if (message.includes("returned an invalid result")
        || message.includes("result must be an object")) {
      return "protected_deployment_result_shape_invalid";
    }
    const stageCode = {
      executor: "protected_deployment_executor_type_error",
      result_validation: "protected_deployment_result_validation_type_error",
      result_digest: "protected_deployment_result_digest_type_error",
      result_persistence: "protected_deployment_result_persistence_type_error",
      result_proof: "protected_deployment_result_proof_type_error",
    }[stage];
    return stageCode ?? "protected_deployment_result_contract_failed";
  }
  return "protected_deployment_action_failed";
}

function scenarioResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("protected deployment action executor returned an invalid result");
  }
  assertRedacted(value, "result");
  for (const key of ["productionComponents", "nodeAgentTransport", "schedulerRepository", "nodeAgentJournalPersisted"]) {
    if (Object.hasOwn(value, key)) throw new TypeError(`protected deployment action executor may not claim ${key}`);
  }
  if (!value.proof || typeof value.proof !== "object" || Array.isArray(value.proof)
      || Object.hasOwn(value.proof, "actionJournal")) {
    throw new TypeError("protected deployment action executor returned an invalid proof boundary");
  }
  return structuredClone(value);
}

function withProductionProof(value, journal) {
  const copy = structuredClone(value);
  return Object.freeze({
    ...copy,
    productionComponents: [...protectedOfficeDeploymentProductionComponents],
    nodeAgentTransport: "mtls-hmac",
    schedulerRepository: "postgres",
    nodeAgentJournalPersisted: true,
    proof: Object.freeze({
      ...copy.proof,
      actionJournal: protectedOfficeDeploymentActionProof(journal),
    }),
  });
}

export class ProductionProtectedOfficeSetDeploymentDriver {
  #actions;
  #executor;
  #repository;
  #clock;
  #close;

  constructor({ actionRepository, actionExecutor, clock = () => new Date(), close = async () => {} }) {
    const repositoryMethods = [
      "beginAction", "markRecovering", "resumeAction", "completeAction", "failAction",
    ];
    if (!actionRepository || repositoryMethods.some((method) => typeof actionRepository[method] !== "function")
        || !actionExecutor || protectedOfficeDeploymentActions.some((action) => typeof actionExecutor[action] !== "function")
        || typeof actionExecutor.recoverInterruptedAction !== "function"
        || typeof clock !== "function" || typeof close !== "function") {
      throw new TypeError("production protected deployment driver dependencies are incomplete");
    }
    this.#repository = actionRepository;
    this.#executor = actionExecutor;
    this.#clock = clock;
    this.#close = close;
    this.#actions = Object.freeze(Object.fromEntries(protectedOfficeDeploymentActions.map((action) => [
      action, (input) => this.#execute(action, input),
    ])));
  }

  async #execute(action, input) {
    const actionRequest = request(input, action);
    let journal = await this.#repository.beginAction({
      runId: actionRequest.runId,
      action,
      actionId: actionRequest.actionId.toLowerCase(),
      idempotencyKey: actionRequest.idempotencyKey,
      requestDigest: requestDigest(actionRequest),
      createdAt: this.#clock(),
    });
    if (journal.state === "succeeded") {
      if (!journal.result || protectedOfficeDeploymentResultDigest(journal.result) !== journal.resultDigest) {
        throw new PlatformError("protected_deployment_action_result_drift",
          "Protected deployment action result no longer matches its durable digest",
          { status: 503, retryable: false });
      }
      return withProductionProof(journal.result, journal);
    }
    if (journal.state === "failed") {
      throw new PlatformError("protected_deployment_action_terminal",
        "Failed protected deployment action requires a new bounded run identity",
        { status: 409, retryable: false, details: { action, failureCode: journal.failureCode } });
    }
    if (!journal.created) {
      if (journal.state === "running") {
        journal = await this.#repository.markRecovering(actionRequest.runId, action, journal.revision, {
          updatedAt: this.#clock(),
        });
      }
      if (journal.state !== "recovering") {
        throw new PlatformError("protected_deployment_action_state_conflict",
          "Protected deployment action cannot be replayed from its current state", { status: 409, retryable: true });
      }
      await this.#executor.recoverInterruptedAction({ request: structuredClone(actionRequest), journal: structuredClone(journal) });
      journal = await this.#repository.resumeAction(actionRequest.runId, action, journal.revision, {
        updatedAt: this.#clock(),
      });
    }
    let stage = "executor";
    try {
      const rawResult = await this.#executor[action]({
        request: structuredClone(actionRequest), journal: structuredClone(journal),
      });
      stage = "result_validation";
      const executed = scenarioResult(rawResult);
      const durable = {
        ...executed,
        productionComponents: [...protectedOfficeDeploymentProductionComponents],
        nodeAgentTransport: "mtls-hmac",
        schedulerRepository: "postgres",
        nodeAgentJournalPersisted: true,
      };
      stage = "result_digest";
      const resultDigest = protectedOfficeDeploymentResultDigest(durable);
      stage = "result_persistence";
      const completed = await this.#repository.completeAction(actionRequest.runId, action, journal.revision, {
        result: durable, resultDigest, persistedAt: this.#clock(),
      });
      if (!completed) throw new PlatformError("protected_deployment_action_missing",
        "Protected deployment action journal disappeared", { status: 503, retryable: false });
      stage = "result_proof";
      return withProductionProof(durable, completed);
    } catch (error) {
      const code = failureCode(error, stage);
      try {
        await this.#repository.failAction(actionRequest.runId, action, journal.revision, {
          failureCode: code, persistedAt: this.#clock(),
        });
      } catch (journalError) {
        throw new AggregateError([error, journalError], "Protected deployment action and failure journal both failed");
      }
      if (error instanceof TypeError) {
        // Report the code location, never exception text or request values.
        // Otherwise a pre-mutation validation failure looks like a transport
        // outage and operators cannot tell which component needs fixing.
        const location = String(error.stack ?? "").split("\n").slice(1)
          .map((line) => line.match(/\/([a-zA-Z0-9_.-]+\.mjs):(\d+):(\d+)/))
          .find(Boolean);
        throw new PlatformError(code,
          "Protected deployment action result violated its bounded structural contract",
          { status: 500, retryable: false, cause: error,
            details: { stage, ...(location ? { sourceLocation: `${location[1]}:${location[2]}:${location[3]}` } : {}) } });
      }
      throw error;
    }
  }

  preflight(input) { return this.#actions.preflight(input); }
  ["cold-boot"](input) { return this.#actions["cold-boot"](input); }
  ["concurrent-office"](input) { return this.#actions["concurrent-office"](input); }
  ["bounded-maintenance"](input) { return this.#actions["bounded-maintenance"](input); }
  ["restart-verify"](input) { return this.#actions["restart-verify"](input); }
  ["mid-sequence-failure"](input) { return this.#actions["mid-sequence-failure"](input); }
  ["final-inspect"](input) { return this.#actions["final-inspect"](input); }
  recover(input) { return this.#actions.recover(input); }
  cleanup(input) { return this.#actions.cleanup(input); }
  close() { return this.#close(); }
}

export class ProductionProtectedOfficeSetDeploymentInspector {
  #repository;
  #sources;
  #assembler;
  constructor({ actionRepository, inspectionSources, resultAssembler }) {
    if (!actionRepository?.getAction || !inspectionSources || typeof inspectionSources !== "object"
        || protectedOfficeDeploymentInspectionSources.some((name) => typeof inspectionSources[name] !== "function")
        || typeof resultAssembler !== "function") {
      throw new TypeError("production protected deployment inspector dependencies are incomplete");
    }
    this.#repository = actionRepository;
    this.#sources = inspectionSources;
    this.#assembler = resultAssembler;
  }

  async inspect({ runId, nonce, plan }) {
    if (!RUN_ID.test(runId ?? "") || !NONCE.test(nonce ?? "")
        || !plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new TypeError("protected deployment inspection request is invalid");
    }
    assertPlanRedacted(plan);
    const sourceFacts = {};
    for (const name of protectedOfficeDeploymentInspectionSources) {
      const observed = await this.#sources[name]({ runId, plan: structuredClone(plan) });
      if (!observed || typeof observed !== "object" || Array.isArray(observed)
          || observed.readOnly !== true || observed.mutationCount !== 0) {
        throw new PlatformError("protected_deployment_inspection_source_invalid",
          `Protected deployment inspection source ${name} violated its read-only contract`,
          { status: 503, retryable: false });
      }
      assertRedacted(observed, `inspection.${name}`);
      sourceFacts[name] = structuredClone(observed);
    }
    const journal = await this.#repository.getAction(runId, "final-inspect");
    if (!journal || journal.state !== "succeeded" || !journal.resultDigest) {
      throw new PlatformError("protected_deployment_final_inspection_missing",
        "Successful final inspection action journal is unavailable", { status: 409, retryable: true });
    }
    const assembled = scenarioResult(await this.#assembler({
      runId, plan: structuredClone(plan), sources: sourceFacts, journal: structuredClone(journal),
    }));
    const result = withProductionProof({
      ...assembled,
      readOnly: true,
      mutationCount: 0,
      inspectionSources: [...protectedOfficeDeploymentInspectionSources],
      productionComponents: [...protectedOfficeDeploymentProductionComponents],
      nodeAgentTransport: "mtls-hmac",
      schedulerRepository: "postgres",
      nodeAgentJournalPersisted: true,
    }, journal);
    assertRedacted(result, "inspection-result");
    return result;
  }
}
