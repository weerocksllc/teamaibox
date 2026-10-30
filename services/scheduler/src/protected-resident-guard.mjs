import { PlatformError } from "../../../packages/observability/src/index.mjs";

const PLACEMENT_CLASSES = new Set(["protected-resident", "warm-optional", "exclusive-batch"]);
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const OPERATION = /^[a-z][a-z0-9_.:-]{2,63}$/;
const DEFAULT_MAXIMUM_MAINTENANCE_TTL_MILLISECONDS = 15 * 60_000;

function validInstant(value, name) {
  const instant = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return instant;
}

function positiveGeneration(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function workerIdOf(worker) {
  const value = worker?.workerId ?? worker?.worker_id;
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new TypeError("protected-resident Worker identity is invalid");
  }
  return value;
}

export function workerPlacementClass(worker) {
  const value = worker?.placementClass ?? worker?.placement_class
    ?? worker?.modelProfilePlacementClass ?? worker?.model_profile_placement_class
    ?? "warm-optional";
  if (!PLACEMENT_CLASSES.has(value)) throw new TypeError("Worker placement class is invalid");
  return value;
}

export function workerMaintenanceGeneration(worker) {
  return positiveGeneration(
    worker?.maintenanceGeneration ?? worker?.maintenance_generation ?? 1,
    "Worker maintenance generation",
  );
}

export function isProtectedResidentWorker(worker) {
  return workerPlacementClass(worker) === "protected-resident";
}

function denied(code, message, operation, protectedWorkerIds) {
  return new PlatformError(code, message, {
    status: 409,
    retryable: false,
    details: Object.freeze({ operation, protectedWorkerIds: Object.freeze([...protectedWorkerIds]) }),
  });
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Ordinary lifecycle, exclusive/batch operations never gain
// protected-resident mutation authority from a per-operation context. The only
// mutating authority is the complete-set transaction validated below by the
// protected office-set coordinator and the Node Agent.
export function assertOrdinaryOperationExcludesProtectedResidents({ workers, operation }) {
  if (!Array.isArray(workers) || !OPERATION.test(operation ?? "")) {
    throw new TypeError("ordinary protected-resident operation input is invalid");
  }
  const protectedWorkerIds = workers.filter(isProtectedResidentWorker).map(workerIdOf).sort();
  if (protectedWorkerIds.length > 0) {
    throw denied("protected_resident_maintenance_required",
      "Protected-resident Workers may be mutated only by a complete-set maintenance or recovery transaction",
      operation, protectedWorkerIds);
  }
}

function normalizedContext(context, { workers, operation, now, maximumTtlMilliseconds }) {
  const workerIds = workers.map(workerIdOf).sort();
  const protectedWorkers = workers.filter(isProtectedResidentWorker);
  const protectedWorkerIds = protectedWorkers.map(workerIdOf).sort();
  if (protectedWorkers.length === 0) return null;
  if (!context || typeof context !== "object" || Array.isArray(context)
      || !TRANSACTION_ID.test(context.transactionId ?? "")
      || !Array.isArray(context.workerIds) || context.workerIds.length < 1
      || context.workerIds.some((value) => typeof value !== "string")
      || new Set(context.workerIds).size !== context.workerIds.length
      || !Array.isArray(context.allowedOperations) || context.allowedOperations.length < 1
      || context.allowedOperations.some((value) => typeof value !== "string" || !OPERATION.test(value))
      || new Set(context.allowedOperations).size !== context.allowedOperations.length) {
    throw denied("protected_resident_maintenance_required",
      "Protected-resident Workers require an exact bounded maintenance authorization",
      operation, protectedWorkerIds);
  }
  const authorizedWorkerIds = [...context.workerIds].sort();
  if (!sameStrings(authorizedWorkerIds, workerIds) || !context.allowedOperations.includes(operation)) {
    throw denied("protected_resident_maintenance_scope_mismatch",
      "Protected-resident maintenance authorization does not match the exact drain set and operation",
      operation, protectedWorkerIds);
  }
  let maintenanceGeneration;
  let issuedAt;
  let expiresAt;
  try {
    maintenanceGeneration = positiveGeneration(context.maintenanceGeneration, "maintenanceContext.maintenanceGeneration");
    issuedAt = validInstant(context.issuedAt, "maintenanceContext.issuedAt");
    expiresAt = validInstant(context.expiresAt, "maintenanceContext.expiresAt");
  } catch {
    throw denied("protected_resident_maintenance_invalid",
      "Protected-resident maintenance authorization is malformed",
      operation, protectedWorkerIds);
  }
  const generations = [...new Set(protectedWorkers.map(workerMaintenanceGeneration))];
  if (generations.length !== 1 || generations[0] !== maintenanceGeneration) {
    throw denied("protected_resident_maintenance_generation_stale",
      "Protected-resident maintenance authorization belongs to a stale maintenance generation",
      operation, protectedWorkerIds);
  }
  if (issuedAt.getTime() > now.getTime() + 1_000
      || expiresAt.getTime() <= now.getTime()
      || expiresAt.getTime() <= issuedAt.getTime()
      || expiresAt.getTime() - issuedAt.getTime() > maximumTtlMilliseconds) {
    throw denied("protected_resident_maintenance_expired",
      "Protected-resident maintenance authorization is outside its bounded validity window",
      operation, protectedWorkerIds);
  }
  return Object.freeze({
    transactionId: context.transactionId,
    workerIds: Object.freeze(workerIds),
    protectedWorkerIds: Object.freeze(protectedWorkerIds),
    allowedOperations: Object.freeze([...context.allowedOperations].sort()),
    operation,
    maintenanceGeneration,
    issuedAt,
    expiresAt,
  });
}

export async function authorizeProtectedResidentOperation({
  workers,
  operation,
  maintenanceContext = null,
  maintenanceAuthorizer = null,
  now = new Date(),
  maximumTtlMilliseconds = DEFAULT_MAXIMUM_MAINTENANCE_TTL_MILLISECONDS,
}) {
  if (!Array.isArray(workers) || workers.length < 1 || !OPERATION.test(operation ?? "")) {
    throw new TypeError("protected-resident operation input is invalid");
  }
  if (!Number.isSafeInteger(maximumTtlMilliseconds) || maximumTtlMilliseconds < 1) {
    throw new TypeError("maximum maintenance TTL must be a positive safe integer");
  }
  const at = validInstant(now, "now");
  const normalized = normalizedContext(maintenanceContext, {
    workers, operation, now: at, maximumTtlMilliseconds,
  });
  if (normalized === null) return null;
  if (typeof maintenanceAuthorizer !== "function") {
    throw denied("protected_resident_maintenance_verifier_unavailable",
      "Protected-resident maintenance signature verification is unavailable",
      operation, normalized.protectedWorkerIds);
  }
  let decision;
  try {
    decision = await maintenanceAuthorizer({
      context: structuredClone(maintenanceContext),
      operation,
      workers: workers.map((worker) => Object.freeze({
        workerId: workerIdOf(worker),
        placementClass: workerPlacementClass(worker),
        maintenanceGeneration: workerMaintenanceGeneration(worker),
      })),
      now: new Date(at),
    });
  } catch (error) {
    throw new PlatformError("protected_resident_maintenance_verification_failed",
      "Protected-resident maintenance signature verification failed",
      { status: 503, retryable: true, cause: error });
  }
  const decisionWorkerIds = Array.isArray(decision?.workerIds) ? [...decision.workerIds].sort() : [];
  if (decision?.authorized !== true || decision.signatureVerified !== true
      || decision.transactionId !== normalized.transactionId
      || decision.operation !== operation
      || decision.maintenanceGeneration !== normalized.maintenanceGeneration
      || !sameStrings(decisionWorkerIds, normalized.workerIds)) {
    throw denied("protected_resident_maintenance_denied",
      "Protected-resident maintenance authorization was denied or did not bind the exact operation",
      operation, normalized.protectedWorkerIds);
  }
  return normalized;
}

export function assertProtectedResidentAuthorizationCurrent(worker, authorization, { operation, now = new Date() }) {
  if (!isProtectedResidentWorker(worker)) return;
  const workerId = workerIdOf(worker);
  const at = validInstant(now, "now");
  if (!authorization || authorization.operation !== operation
      || !authorization.workerIds.includes(workerId)
      || authorization.maintenanceGeneration !== workerMaintenanceGeneration(worker)
      || authorization.expiresAt.getTime() <= at.getTime()) {
    throw denied("protected_resident_maintenance_generation_stale",
      "Protected-resident maintenance authorization changed before the stop transition",
      operation, [workerId]);
  }
}

export const protectedResidentMaximumMaintenanceTtlMilliseconds =
  DEFAULT_MAXIMUM_MAINTENANCE_TTL_MILLISECONDS;
