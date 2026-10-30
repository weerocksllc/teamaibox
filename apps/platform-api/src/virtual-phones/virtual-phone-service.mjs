import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { LEGACY_PHONE_ROM } from "../../../../services/scheduler/src/phone-rom.mjs";
import { phoneSystemCatalog, phoneSystemReleases } from './phone-system-catalog.mjs';
import { PHONE_SPEC, validatePolicy, validateCreate, validateAction, validateRename, validateQuotaUpdate, validateFeatureUpdate, validateQuotaQuery,
  idempotencyKey, identifier, failPhone, phoneErrorCode } from "./contracts.mjs";

export function publicPhone(phone) {
  return { object: "virtual_phone", id: phone.id, name: phone.name, state: phone.state, revision: phone.revision,
    generation: phone.generation, spec: { ...PHONE_SPEC, ...(phone.rom ? { buildId: phone.rom.baseBuildId,
      googlePlay: phone.rom.googlePlay ? "experimental" : "not-included" } : {}) },
    rom: phone.rom ? publicRom(phone.rom) : null, runningCharged: phone.runningCharged,
    errorCode: phone.errorCode, createdAt: phone.createdAt, updatedAt: phone.updatedAt };
}
export function publicRom(rom) {
  return { id: rom.id, familyId: rom.familyId, name: rom.name, version: rom.version,
    googlePlay: rom.googlePlay, experimental: rom.experimental, cameraCapability: rom.cameraCapability };
}
export function publicOperation(op) {
  return { object: "virtual_phone.operation", id: op.id, phoneId: op.phoneId, action: op.action,
    state: op.state, errorCode: op.errorCode, createdAt: op.createdAt, updatedAt: op.updatedAt, finishedAt: op.finishedAt };
}

/** Phone-specific async control, using existing persistence/capacity/Node Agent adapters.
 * No runtime port is provided by default; a simulated backend can never implicitly enable the feature.
 */
export class VirtualPhoneService {
  #repository; #directory; #capacity; #runtime; #policy; #systemReleases; #inflight = new Map();
  #operationTimer = null; #authorizationTimer = null; #runtimeTimer = null;
  constructor({ repository, directory, capacity = null, runtime = null, policy = {}, systemReleases }) {
    if (!repository?.requestCreate || !repository?.completeOperation || !directory?.authorization) {
      throw new TypeError("Virtual phone persistence and current identity directory are required");
    }
    if (capacity && ["placement", "acquireRun", "releaseRun", "status"].some(key => typeof capacity[key] !== "function")) {
      throw new TypeError("Virtual phone node capacity adapter is incomplete");
    }
    if (runtime && ["provision", "start", "stop", "deleteData", "revokeAccess"].some(key => typeof runtime[key] !== "function")) {
      throw new TypeError("Virtual phone runtime adapter is incomplete");
    }
    this.#repository = repository; this.#directory = directory; this.#capacity = capacity; this.#runtime = runtime;
    this.#policy = validatePolicy(policy);
    this.#systemReleases = phoneSystemReleases(systemReleases);
  }
  async #authorize(context, permission = "phone:use") {
    if (!context?.identityId) throw new PlatformError("invalid_session", "请先登录。", { status: 401 });
    const ownerId = identifier(context.identityId);
    const current = await this.#directory.authorization(ownerId);
    if (!current || !current.permissions?.includes(permission)) failPhone("phone_permission_required");
    return ownerId;
  }
  async #currentPolicy() {
    const stored = await this.#repository.featurePolicy?.();
    return { ...this.#policy, enabled: this.#policy.enabled && (stored?.enabled ?? true), revision: stored?.revision ?? 0 };
  }
  async #requireRuntime({ starting = false } = {}) {
    if (starting && !(await this.#currentPolicy()).enabled) failPhone("phone_disabled");
    if (!this.#capacity || !this.#runtime) failPhone("phone_runtime_unavailable");
  }
  async availability({ context }) {
    await this.#authorize(context);
    const policy = await this.#currentPolicy();
    const roms = await this.#romCatalog();
    const systems = phoneSystemCatalog(roms, this.#systemReleases);
    return { object: "virtual_phone.availability", enabled: policy.enabled,
      runtimeConfigured: Boolean(this.#capacity && this.#runtime), spec: PHONE_SPEC,
      reasonCode: !policy.enabled ? "phone_disabled" : !this.#capacity || !this.#runtime ? "phone_runtime_unavailable" : null,
      limits: policy, closePageStopsPhone: false, defaultSystemId: 'standard',
      defaultRomVersionId: systems[0].id, systems, roms };
  }
  async #romCatalog(knownNodes) {
    const versions = await this.#repository.romCatalog?.() ?? [];
    const nodes = knownNodes ?? (this.#capacity ? await this.#capacity.status() : []);
    return versions.map(rom => ({ ...publicRom(rom), createEnabled: rom.createEnabled,
      reasonCode: !rom.createEnabled ? "phone_rom_unavailable" : !nodes.some(node => !node.reasonCode
        && node.roms?.some(value => value.romVersionId === rom.id && value.imageDigest === rom.imageDigest)) ? "phone_rom_not_installed" : null }));
  }
  async list({ context }) {
    const ownerId = await this.#authorize(context);
    const [values, quota] = await Promise.all([this.#repository.list(ownerId), this.#repository.quota(ownerId, this.#policy)]);
    return { object: "list", data: values.map(value => this.#present(value)), quota };
  }
  #present(phone) {
    return { ...publicPhone(phone), cleanupMode: this.#runtime?.hasConfiguredLocation?.(phone) === false ? 'retired-record' : 'delete-data' };
  }
  async get({ context, phoneId }) {
    return this.#present(await this.#repository.get(await this.#authorize(context), identifier(phoneId)));
  }
  async removeRetiredRecord({ context, phoneId, input }) {
    const ownerId = await this.#authorize(context), id = identifier(phoneId), normalized = validateAction('delete', input);
    if (await this.#repository.recordRemoval?.(ownerId, id)) return { id, recordRemoved: true, dataDeleted: false };
    const phone = await this.#repository.get(ownerId, id);
    if (this.#runtime?.hasConfiguredLocation?.(phone) !== false || !this.#runtime?.revokeRetiredRecordAccess) failPhone('phone_state_conflict');
    if (phone.runningCharged || await this.#repository.currentRun(ownerId, id)) failPhone('phone_stop_unconfirmed');
    await this.#runtime.revokeRetiredRecordAccess(phone);
    return this.#repository.removeRetiredRecord({ ownerId, phoneId: id, input: normalized, nodeId: phone.nodeId, poolId: phone.poolId });
  }
  async getOperation({ context, operationId }) {
    return publicOperation(await this.#repository.getOperation(await this.#authorize(context), identifier(operationId)));
  }
  async create({ context, input, key }) {
    const ownerId = await this.#authorize(context), normalized = validateCreate(input), selectedKey = idempotencyKey(key);
    const prior = await this.#repository.findRequest(ownerId, "create", selectedKey, normalized);
    if (prior) return publicOperation(prior);
    await this.#requireRuntime({ starting: true });
    const rom = await this.#repository.getRom(normalized.romVersionId ?? LEGACY_PHONE_ROM);
    if (!rom.createEnabled) failPhone("phone_rom_unavailable");
    // This is a lightweight configured/verified pool lookup, not a deployment validator or public download.
    const placement = await this.#capacity.placement({ ownerId, spec: PHONE_SPEC, rom });
    return publicOperation(await this.#repository.requestCreate({ ownerId, input: normalized, key: selectedKey, placement, policy: this.#policy }));
  }
  async rename({ context, phoneId, input }) {
    return publicPhone(await this.#repository.rename({ ownerId: await this.#authorize(context),
      phoneId: identifier(phoneId), input: validateRename(input) }));
  }
  async action({ context, phoneId, action, input, key }) {
    const ownerId = await this.#authorize(context), selectedId = identifier(phoneId), normalized = validateAction(action, input);
    const selectedKey = idempotencyKey(key);
    const prior = await this.#repository.findRequest(ownerId, action, selectedKey, { phoneId: selectedId, ...normalized });
    if (prior) return publicOperation(prior);
    // Check ownership before availability: another owner's phone is indistinguishable from a missing one.
    await this.#repository.get(ownerId, selectedId);
    await this.#requireRuntime({ starting: ["start", "restart"].includes(action) });
    return publicOperation(await this.#repository.requestAction({ ownerId, phoneId: selectedId, action, input: normalized,
      key: selectedKey, policy: this.#policy }));
  }
  async setQuota({ context, ownerId, input }) {
    await this.#authorize(context, "phone:manage");
    return this.#repository.setQuota(identifier(ownerId), validateQuotaUpdate(input));
  }
  async setFeature({ context, input }) {
    const actorId = await this.#authorize(context, "phone:manage"), update = validateFeatureUpdate(input);
    if (!this.#repository.setFeaturePolicy || (update.enabled && (!this.#policy.enabled || !this.#capacity || !this.#runtime))) failPhone("phone_runtime_unavailable");
    await this.#repository.setFeaturePolicy(actorId, update);
    return this.administration({ context });
  }
  async administrationQuotas({ context, query }) {
    await this.#authorize(context, "phone:manage");
    if (!this.#repository.administrationQuotas) failPhone("phone_runtime_unavailable");
    return this.#repository.administrationQuotas(validateQuotaQuery(query), this.#policy);
  }
  async administration({ context }) {
    await this.#authorize(context, "phone:manage");
    const nodes = this.#capacity ? await this.#capacity.status() : [];
    return { policy: await this.#currentPolicy(), spec: PHONE_SPEC,
      deploymentReady: Boolean(this.#policy.enabled && this.#capacity && this.#runtime),
      nodes, roms: await this.#romCatalog(nodes), contentAccessGranted: false };
  }

  async processPending() {
    if (!this.#capacity || !this.#runtime) return { processed: 0 };
    const pending = await this.#repository.pendingOperations();
    // The initial worker is intentionally serial; per-node admission also fences other control-plane processes.
    for (const op of pending) await this.processOperation(op.ownerId, op.id);
    return { processed: pending.length };
  }
  async reconcileAuthorization() {
    if (!this.#runtime) return;
    for (const ownerId of await this.#repository.chargedOwners()) {
      const authorization = await this.#directory.authorization(ownerId);
      if (!authorization?.permissions?.includes("phone:use")) await this.handleIdentityDisabled(ownerId);
    }
  }
  async reconcileRuntime() {
    if (!this.#runtime?.inspect || !this.#capacity) return { checked: 0, stopping: 0 };
    let checked = 0, stopping = 0;
    for (const ownerId of await this.#repository.chargedOwners()) {
      for (const phone of await this.#repository.list(ownerId)) {
        if (!phone.runningCharged || !["running", "unavailable", "error"].includes(phone.state)) continue;
        const run = await this.#repository.currentRun(ownerId, phone.id);
        if (!run) continue;
        try {
          const status = await this.#runtime.inspect({ phone, run, operationId: run.id });
          checked++;
          if (status.runId !== run.id || status.generation !== run.generation) failPhone("phone_stale_run");
          if (status.runtimeStopped !== true) continue;
          // Reuse the persistent stop workflow: revoke access, reconfirm the
          // exact container, then release resources. No new scheduler or blind
          // timeout-based release; a racing rename/start is revision-fenced.
          await this.#repository.requestAction({ ownerId, phoneId: phone.id, action: "stop",
            input: { expectedRevision: phone.revision }, key: `reconcile-${run.id}-${phone.revision}`,
            policy: this.#policy, allowInactive: true });
          stopping++;
        } catch (error) {
          if (!["phone_node_unavailable", "phone_runtime_unavailable", "phone_stale_run", "phone_operation_conflict",
            "phone_state_conflict", "phone_idempotency_conflict"].includes(error?.code)) throw error;
          // An unreachable node is not a stopped phone. Preserve its charge.
        }
      }
    }
    return { checked, stopping };
  }
  startReconciler({ onError = () => {} } = {}) {
    if (this.#operationTimer || !this.#runtime || !this.#capacity) return;
    let operationsBusy = false, authorizationBusy = false, runtimeBusy = false;
    this.#operationTimer = setInterval(async () => {
      if (operationsBusy) return;
      operationsBusy = true;
      try { await this.processPending(); } catch (error) { onError(error); } finally { operationsBusy = false; }
    }, 1000);
    // Revocation must not wait behind a guest boot or a long provisioning operation.
    this.#authorizationTimer = setInterval(async () => {
      if (authorizationBusy) return;
      authorizationBusy = true;
      try { await this.reconcileAuthorization(); } catch (error) { onError(error); } finally { authorizationBusy = false; }
    }, 2000);
    this.#runtimeTimer = setInterval(async () => {
      if (runtimeBusy) return;
      runtimeBusy = true;
      try { await this.reconcileRuntime(); } catch (error) { onError(error); } finally { runtimeBusy = false; }
    }, 5000);
    this.#operationTimer.unref(); this.#authorizationTimer.unref(); this.#runtimeTimer.unref();
  }
  stopReconciler() {
    clearInterval(this.#operationTimer); clearInterval(this.#authorizationTimer); clearInterval(this.#runtimeTimer);
    this.#operationTimer = null; this.#authorizationTimer = null; this.#runtimeTimer = null;
  }
  async processOperation(ownerId, operationId) {
    if (this.#inflight.has(operationId)) return this.#inflight.get(operationId);
    const pending = this.#process(ownerId, operationId).finally(() => this.#inflight.delete(operationId));
    this.#inflight.set(operationId, pending);
    return pending;
  }
  async #process(ownerId, operationId) {
    await this.#requireRuntime();
    const op = await this.#repository.getOperation(ownerId, operationId);
    if (["succeeded", "failed"].includes(op.state)) return publicOperation(op);
    let phone = await this.#repository.get(ownerId, op.phoneId);
    let run = await this.#repository.currentRun(ownerId, op.phoneId);
    try {
      if (["create", "start", "restart"].includes(op.action)) {
        await this.#authorize({ identityId: ownerId });
        await this.#requireRuntime({ starting: true });
      }
      await this.#repository.markExecuting(ownerId, op.id);
      let result;
      if (op.action === "create") {
        result = await this.#runtime.provision({ phone, operationId: op.id });
      } else if (op.action === "start" || (op.action === "restart" && phone.state === "starting")) {
        // acquireRun persists the exact reservation and run together. A crash/retry reuses those same IDs.
        run ??= await this.#capacity.acquireRun({ phone, operation: op, policy: this.#policy });
        result = await this.#runtime.start({ phone, run, operationId: op.id });
      } else {
        // Recover a crash after the capacity transaction confirmed the run as
        // stopped but before this operation completed. Retain the exact run and
        // its stop reason instead of replacing confirmation with a boolean.
        if (!run && phone.runningCharged && phone.generation > 0) {
          run = await this.#repository.latestRun?.(ownerId, phone.id) ?? null;
          if (!run || run.generation !== phone.generation) failPhone("phone_stop_unconfirmed");
        }
        await this.#runtime.revokeAccess({ phone, run, operationId: op.id });
        result = run ? await this.#runtime.stop({ phone, run, operationId: op.id }) : { runtimeStopped: true };
        if (result.runtimeStopped !== true || (run && result.runId !== run.id)) failPhone("phone_stop_unconfirmed");
        if (run) await this.#capacity.releaseRun({ phone, run, stopResult: result });
        if (op.action === "delete") result = { ...result, ...await this.#runtime.deleteData({ phone, operationId: op.id }) };
      }
      return publicOperation(await this.#repository.completeOperation({ ownerId, operationId, generation: op.generation, result }));
    } catch (error) {
      // A transport failure is not proof of a stopped guest. Keep its reservation for exact reconciliation.
      if (phoneErrorCode(error) === "phone_stale_run") throw error;
      run = await this.#repository.currentRun(ownerId, op.phoneId);
      return publicOperation(await this.#repository.failOperation({ ownerId, operationId, generation: op.generation, error,
        runtimeStopped: run === null }));
    }
  }

  async handleIdentityDisabled(ownerId) {
    identifier(ownerId);
    if (!this.#runtime) return;
    for (const phone of await this.#repository.list(ownerId)) {
      const run = await this.#repository.currentRun(ownerId, phone.id);
      await this.#runtime.revokeAccess({ phone, run, reason: "identity_disabled" });
      if (!phone.runningCharged) continue;
      try {
        await this.#repository.requestAction({ ownerId, phoneId: phone.id, action: "stop",
          input: { expectedRevision: phone.revision }, key: `disabled-${phone.id}-${phone.generation}`,
          policy: this.#policy, allowInactive: true });
      } catch (error) {
        // The active operation rechecks account state; reconciliation revisits the retained reservation.
        if (error?.code !== "phone_operation_conflict") throw error;
      }
    }
  }
  async handleSignOut({ context }) {
    if (!context?.identityId || !this.#runtime) return;
    for (const phone of await this.#repository.list(context.identityId)) {
      await this.#runtime.revokeAccess({ phone, run: await this.#repository.currentRun(context.identityId, phone.id),
        loginSessionId: context.sessionId, reason: "sign_out" });
    }
    // Sign out closes access, not the persistent guest.
  }
}
