import { stat } from "node:fs/promises";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function principal(context) {
  if (!UUID.test(context?.identityId ?? "") || !Array.isArray(context?.permissions)) {
    throw new PlatformError("storage_access_denied", "Storage administration access denied", { status: 403 });
  }
  return Object.freeze({ id: context.identityId, status: "active", identityKind: "service_account",
    serviceGrants: context.permissions.filter((value) => value === "storage:view" || value === "storage:manage").map((permissionKey) => ({
      permissionKey, resourceKind: "appliance", resourceKey: "*", expiresAt: null, revokedAt: null,
    })) });
}

function projected(value) {
  if (!value) return null;
  return Object.freeze({
    poolId: value.poolId, displayName: value.displayName, backendKind: value.backendKind, nodeId: value.nodeId,
    failureDomain: value.failureDomain, lifecycleState: value.lifecycleState, healthState: value.healthState,
    totalBytes: value.capacity.totalBytes, availableBytes: value.capacity.observedAvailableBytes,
    safetyReserveBytes: value.capacity.safetyReserveBytes, encryptionMode: value.encryption.mode,
    encryptionStatus: value.encryption.status, compatibilityStatus: value.compatibility.status,
    dataClasses: value.dataClasses, allocationCount: value.allocations.count,
    allocatedBytes: value.capacity.allocatedBytes, liveReservationCount: value.reservations?.count ?? 0,
    liveReservationBytes: value.reservations?.bytes ?? value.capacity.reservedBytes,
    incompleteMigrationCount: value.migrations?.incompleteCount ?? 0, observedAt: value.observedAt,
    createdAt: value.createdAt, updatedAt: value.updatedAt, removedAt: value.removedAt,
  });
}

export class StorageAdministrationRuntime {
  #service;
  #dataPlane;
  #configured;

  constructor({ storagePoolService, dataPlane, configuredPools }) {
    if (!storagePoolService?.listPools || !storagePoolService?.registerPool || !storagePoolService?.recordObservation
        || !dataPlane?.capacity || !Array.isArray(configuredPools) || configuredPools.length < 1) {
      throw new TypeError("storage administration runtime is incomplete");
    }
    this.#service = storagePoolService;
    this.#dataPlane = dataPlane;
    this.#configured = new Map(configuredPools.map((value) => [value.poolId, Object.freeze({ ...value })]));
  }

  async list({ context }) { return Promise.all((await this.#service.listPools({ principal: principal(context) })).map(projected)); }
  async find({ context, poolId }) { try { return projected(await this.#service.pool({ principal: principal(context), poolId })); }
    catch (error) { if (error?.code === "storage_pool_not_found") return null; throw error; } }

  async create({ context, input }) {
    const actor = principal(context), configured = this.#configured.get(input.poolId);
    if (!configured || configured.backendKind !== input.backendKind || configured.nodeId !== input.nodeId
        || input.encryptionMode !== "luks2" || configured.luks2Verified !== true) {
      throw new PlatformError("storage_pool_not_mounted", "Storage pool is not a verified mounted LUKS2 data plane", { status: 409 });
    }
    await stat(configured.root);
    await this.#service.registerPool({ principal: actor, poolId: input.poolId, displayName: input.displayName,
      backendKind: input.backendKind, nodeId: input.nodeId, failureDomain: input.failureDomain,
      safetyReserveBytes: input.safetyReserveBytes, dataClasses: input.dataClasses });
    const capacity = await this.#dataPlane.capacity(input.poolId), now = new Date();
    return projected(await this.#service.recordObservation({ principal: actor, poolId: input.poolId,
      healthState: "healthy", totalBytes: capacity.totalBytes, availableBytes: capacity.availableBytes,
      encryptionMode: "luks2", encryptionStatus: "verified", encryptionVerifiedAt: now,
      compatibilityStatus: "verified", compatibilityVerifiedAt: now, observedAt: now }));
  }

  async replaceDataClasses({ context, poolId, expectedUpdatedAt, dataClasses }) {
    const actor = principal(context), current = await this.#service.pool({ principal: actor, poolId });
    if (current.updatedAt !== expectedUpdatedAt) throw new PlatformError("storage_revision_conflict", "Storage pool changed; refresh before retrying", { status: 409 });
    return projected(await this.#service.setDataClasses({ principal: actor, poolId, dataClasses }));
  }

  async transition({ context, poolId, expectedUpdatedAt, action }) {
    const actor = principal(context), current = await this.#service.pool({ principal: actor, poolId });
    if (current.updatedAt !== expectedUpdatedAt) throw new PlatformError("storage_revision_conflict", "Storage pool changed; refresh before retrying", { status: 409 });
    if (action === "drain" || action === "complete") {
      await this.#service.drainPool({ principal: actor, poolId });
      return projected(await this.#service.pool({ principal: actor, poolId }));
    }
    if (action === "remove") {
      await this.#service.removePool({ principal: actor, poolId });
      return projected(await this.#service.pool({ principal: actor, poolId }));
    }
    throw new PlatformError("storage_transition_invalid", "Storage lifecycle action is invalid", { status: 400 });
  }

  async refresh({ context }) {
    const actor = principal(context), results = [];
    for (const pool of await this.#service.listPools({ principal: actor })) {
      const configured = this.#configured.get(pool.poolId);
      if (!configured || pool.lifecycleState === "removed") continue;
      const capacity = await this.#dataPlane.capacity(pool.poolId), now = new Date();
      results.push(await this.#service.recordObservation({ principal: actor, poolId: pool.poolId,
        healthState: "healthy", totalBytes: capacity.totalBytes, availableBytes: capacity.availableBytes,
        encryptionMode: pool.encryption.mode, encryptionStatus: pool.encryption.status,
        encryptionVerifiedAt: pool.encryption.verifiedAt, compatibilityStatus: pool.compatibility.status,
        compatibilityVerifiedAt: pool.compatibility.verifiedAt, observedAt: now }));
    }
    return results;
  }
}
