import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const DATA_CLASSES = Object.freeze(["team-file", "message-attachment", "ai-artifact", "dataset", "checkpoint", "model-artifact", "agent-workspace", "plugin-data", "cache", "phone-data"]);
const DATA_CLASS_SET = new Set(DATA_CLASSES);
const BACKENDS = new Set(["local-block", "local-filesystem", "s3-compatible"]);

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function actor(context, permission) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("storage_authentication_required", "Authentication is required", 401);
  if (!context?.permissions?.includes(permission)) fail("storage_permission_required", `Missing permission: ${permission}`, 403);
  return identityId.toLowerCase();
}
function text(value, name, maximum = 128) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > maximum) fail("storage_pool_invalid", `${name} is invalid`);
  return value.trim();
}
function bytes(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("storage_pool_invalid", `${name} is invalid`);
  return value;
}
function dataClasses(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > DATA_CLASSES.length || value.some((item) => !DATA_CLASS_SET.has(item))) {
    fail("storage_data_classes_invalid", "At least one unique supported data class is required");
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) fail("storage_data_classes_invalid", "Data classes must be unique");
  return Object.freeze(unique.sort());
}
function expected(value) {
  const result = new Date(value);
  if (typeof value !== "string" || Number.isNaN(result.getTime()) || result.toISOString() !== value) fail("storage_revision_invalid", "Storage pool revision is invalid");
  return value;
}
function normalizeCreate(input, now) {
  const poolId = text(input?.poolId, "poolId");
  const failureDomain = text(input?.failureDomain, "failureDomain");
  if (!KEY.test(poolId) || !KEY.test(failureDomain)) fail("storage_pool_invalid", "Pool and failure-domain keys are invalid");
  if (!BACKENDS.has(input?.backendKind)) fail("storage_pool_invalid", "Storage backend kind is invalid");
  const local = input.backendKind !== "s3-compatible";
  const nodeId = input?.nodeId == null || input.nodeId === "" ? null : String(input.nodeId).toLowerCase();
  if (local !== UUID.test(nodeId ?? "")) fail("storage_pool_invalid", "Local storage requires one valid node identity; S3-compatible storage must not use one");
  const encryptionMode = input?.encryptionMode;
  if ((local && encryptionMode !== "luks2") || (!local && encryptionMode !== "provider-managed")) {
    fail("storage_encryption_required", "Only verified LUKS2 local pools or provider-managed encrypted object pools can be registered", 409);
  }
  const totalBytes = bytes(input?.totalBytes, "totalBytes", 1);
  const availableBytes = bytes(input?.availableBytes, "availableBytes");
  const safetyReserveBytes = bytes(input?.safetyReserveBytes, "safetyReserveBytes");
  if (availableBytes > totalBytes || safetyReserveBytes >= totalBytes) fail("storage_capacity_invalid", "Storage capacity or safety reserve is invalid");
  if (input?.verificationConfirmation !== `VERIFIED ${poolId}`) fail("storage_verification_required", "Exact compatibility and encryption verification confirmation is required", 409);
  return Object.freeze({ poolId, displayName: text(input.displayName, "displayName"), backendKind: input.backendKind, nodeId,
    failureDomain, totalBytes, availableBytes, safetyReserveBytes, encryptionMode, dataClasses: dataClasses(input.dataClasses), observedAt: now });
}

export class StorageAdministrationService {
  #repository; #audit; #clock;
  constructor({ repository, audit = async () => {}, clock = () => new Date() }) {
    const direct = repository && ["list", "find", "create", "replaceDataClasses", "transition"].every((method) => typeof repository[method] === "function");
    if ((!direct && typeof repository?.bindContext !== "function")
      || typeof audit !== "function" || typeof clock !== "function") throw new TypeError("storage administration dependencies are incomplete");
    this.#repository = repository; this.#audit = audit; this.#clock = clock;
  }

  #for(context) { return typeof this.#repository.bindContext === "function" ? this.#repository.bindContext(context) : this.#repository; }

  async overview({ context }) {
    actor(context, "storage:view");
    const pools = await this.#for(context).list();
    const totalBytes = pools.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0);
    const availableBytes = pools.reduce((sum, item) => sum + (item.availableBytes ?? 0), 0);
    return Object.freeze({ schemaVersion: 1, generatedAt: this.#clock().toISOString(), dataClasses: DATA_CLASSES, summary: Object.freeze({
      poolCount: pools.length, activePoolCount: pools.filter((item) => item.lifecycleState === "active").length,
      degradedPoolCount: pools.filter((item) => new Set(["degraded", "unavailable"]).has(item.healthState)).length,
      totalBytes, availableBytes, allocatedBytes: pools.reduce((sum, item) => sum + item.allocatedBytes, 0),
    }), pools });
  }

  async create({ context, input }) {
    const identityId = actor(context, "storage:manage");
    const repository = this.#for(context);
    const declaration = normalizeCreate(input, this.#clock());
    if (await repository.find(declaration.poolId)) fail("storage_pool_exists", "Storage pool already exists", 409);
    let created;
    try { created = await repository.create(declaration); }
    catch (error) {
      if (error?.code === "23503") fail("storage_node_not_found", "Managed node was not found", 409);
      if (error?.code === "23505") fail("storage_pool_exists", "Storage pool already exists", 409);
      throw error;
    }
    await this.#audit({ action: "storage.pool_registered", actorIdentityId: identityId, resourceKind: "storage_pool", resourceId: created.poolId,
      poolId: created.poolId, backendKind: created.backendKind, nodeId: created.nodeId, encryptionMode: created.encryptionMode,
      totalBytes: created.totalBytes, availableBytes: created.availableBytes, dataClasses: created.dataClasses, success: true });
    return created;
  }

  async replaceDataClasses({ context, poolId, expectedUpdatedAt, values }) {
    const identityId = actor(context, "storage:manage");
    const repository = this.#for(context);
    if (!KEY.test(poolId ?? "")) fail("storage_pool_invalid", "Storage pool key is invalid");
    const current = await repository.find(poolId);
    if (!current) fail("storage_pool_not_found", "Storage pool was not found", 404);
    if (current.lifecycleState !== "active") fail("storage_pool_not_active", "Only an active pool can change data classes", 409);
    let updated;
    try { updated = await repository.replaceDataClasses({ poolId, expectedUpdatedAt: expected(expectedUpdatedAt), dataClasses: dataClasses(values) }); }
    catch (error) {
      if (error?.code === "23514") fail("storage_data_class_in_use", "A data class with live allocations or reservations cannot be removed", 409);
      throw error;
    }
    if (!updated) fail("storage_revision_conflict", "Storage pool changed; refresh before retrying", 409);
    await this.#audit({ action: "storage.pool_data_classes_replaced", actorIdentityId: identityId, resourceKind: "storage_pool", resourceId: poolId,
      poolId, dataClasses: updated.dataClasses, success: true });
    return updated;
  }

  async transition({ context, poolId, action, expectedUpdatedAt, confirmation }) {
    const identityId = actor(context, "storage:manage");
    const repository = this.#for(context);
    if (!KEY.test(poolId ?? "")) fail("storage_pool_invalid", "Storage pool key is invalid");
    const states = { drain: ["active", "draining", `DRAIN ${poolId}`], complete: ["draining", "drained", `DRAINED ${poolId}`], remove: ["drained", "removed", `REMOVE ${poolId}`] };
    const transition = states[action];
    if (!transition) fail("storage_transition_invalid", "Storage lifecycle action is invalid");
    if (confirmation !== transition[2]) fail("storage_confirmation_required", "Exact storage lifecycle confirmation is required", 409);
    const current = await repository.find(poolId);
    if (!current) fail("storage_pool_not_found", "Storage pool was not found", 404);
    if (current.lifecycleState !== transition[0]) fail("storage_transition_invalid", "Storage pool is not in the required lifecycle state", 409);
    let updated;
    try { updated = await repository.transition({ poolId, expectedUpdatedAt: expected(expectedUpdatedAt), fromState: transition[0], toState: transition[1], action }); }
    catch (error) {
      if (error?.code === "23514") fail("storage_pool_has_blockers", "Storage pool still has live allocations, reservations, or migrations", 409);
      throw error;
    }
    if (!updated) fail("storage_revision_conflict", "Storage pool changed; refresh before retrying", 409);
    await this.#audit({ action: `storage.pool_${action === "complete" ? "drained" : action === "remove" ? "removed" : "drain_started"}`,
      actorIdentityId: identityId, resourceKind: "storage_pool", resourceId: poolId, poolId,
      fromState: transition[0], toState: transition[1], allocationCount: current.allocationCount,
      liveReservationCount: current.liveReservationCount, incompleteMigrationCount: current.incompleteMigrationCount, success: true });
    if (action === "drain" && updated.lifecycleState === "drained") {
      await this.#audit({ action: "storage.pool_drained", actorIdentityId: identityId,
        resourceKind: "storage_pool", resourceId: poolId, poolId,
        fromState: "draining", toState: "drained", allocationCount: updated.allocationCount,
        liveReservationCount: updated.liveReservationCount,
        incompleteMigrationCount: updated.incompleteMigrationCount, success: true });
    }
    return updated;
  }
}
