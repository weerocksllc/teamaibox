import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:-[a-z0-9.-]+)?$/;
const STATES = new Set(["blocked", "ready", "executing", "completed", "rolled_back", "manual_recovery_required"]);

function fail(code, message, status = 400, retryable = false) { throw new PlatformError(code, message, { status, retryable }); }
function actor(context, permission = "update:manage") { const id = context?.identityId ?? context?.identity?.id; if (!UUID.test(id ?? "")) fail("invalid_session", "Authentication is required", 401); if (!context.permissions?.includes(permission)) fail("update_permission_required", "Update permission is required", 403); return id.toLowerCase(); }
function timestamp(value, name) { const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} is invalid`); return result; }
function ids(value, name) { if (!Array.isArray(value) || value.length < 1 || value.some((item) => !UUID.test(item ?? ""))) fail("maintenance_targets_invalid", `${name} are invalid`); return Object.freeze([...new Set(value.map((item) => item.toLowerCase()))].sort()); }
function codes(value, name) { if (!Array.isArray(value) || value.length > 64 || value.some((item) => !/^[a-z][a-z0-9_.-]{1,127}$/.test(item ?? ""))) throw new TypeError(`${name} is invalid`); return Object.freeze([...new Set(value)].sort()); }
function instructions(value, name) { if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((item) => typeof item !== "string" || item.length < 3 || item.length > 512 || /[\u0000-\u001f\u007f]/u.test(item))) throw new TypeError(`${name} are invalid`); return Object.freeze([...value]); }
function executionDescriptor(value) {
  if (value == null) return Object.freeze({});
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("maintenance execution descriptor is invalid");
  let serialized; try { serialized = JSON.stringify(value); } catch { throw new TypeError("maintenance execution descriptor is invalid"); }
  if (serialized.length > 32_768 || /"(?:password|secret|token|credential|privateKey)"\s*:/i.test(serialized)) throw new TypeError("maintenance execution descriptor is unsafe");
  return Object.freeze(structuredClone(value));
}
function candidate(value, kind) {
  if (!new Set(["platform", "host"]).has(kind) || !value || value.kind !== kind || !KEY.test(value.candidateKey ?? "") || !VERSION.test(value.version ?? "") || !DIGEST.test(value.digest ?? "") || typeof value.displayName !== "string" || value.displayName.length < 1 || value.displayName.length > 128
    || typeof value.requiresReboot !== "boolean" || typeof value.rollbackAvailable !== "boolean") throw new TypeError("maintenance candidate is invalid");
  return Object.freeze({ candidateKey: value.candidateKey, displayName: value.displayName, kind, version: value.version, digest: value.digest, requiresReboot: value.requiresReboot,
    rollbackAvailable: value.rollbackAvailable, recoveryInstructions: instructions(value.recoveryInstructions, "recovery instructions"), rollbackInstructions: instructions(value.rollbackInstructions, "rollback instructions"), execution: executionDescriptor(value.execution) });
}
function publicCandidate(value) { return Object.freeze({ candidateKey: value.candidateKey, displayName: value.displayName, kind: value.kind, version: value.version, digest: value.digest, requiresReboot: value.requiresReboot, rollbackAvailable: value.rollbackAvailable }); }
function inventory(value) {
  if (!value || !Array.isArray(value.nodes) || value.nodes.length !== 1 || !Array.isArray(value.readyServingNodeIds)) throw new TypeError("maintenance topology is invalid");
  const nodes = value.nodes.map((item) => { if (!UUID.test(item?.nodeId ?? "") || typeof item.nodeKey !== "string" || item.nodeKey.length < 1 || item.nodeKey.length > 128 || !new Set(["ready", "draining", "offline", "disabled", "joining"]).has(item.lifecycleState) || !new Set(["healthy", "degraded", "offline", "unknown"]).has(item.healthState)) throw new TypeError("maintenance node inventory is invalid"); return Object.freeze({ nodeId: item.nodeId.toLowerCase(), nodeKey: item.nodeKey, lifecycleState: item.lifecycleState, healthState: item.healthState }); });
  return Object.freeze({ nodes: Object.freeze(nodes), readyServingNodeIds: idsOrEmpty(value.readyServingNodeIds, "ready serving nodes") });
}
function topology(value, selected) {
  const observed = inventory(value), nodes = observed.nodes;
  const byId = new Map(nodes.map((item) => [item.nodeId, item])); if (selected.some((id) => !byId.has(id))) fail("maintenance_node_not_found", "A selected node was not found", 404);
  if (selected.some((id) => byId.get(id).lifecycleState !== "ready" || byId.get(id).healthState !== "healthy")) fail("maintenance_node_not_ready", "Every selected node must be healthy and ready", 409);
  return Object.freeze({ nodes: Object.freeze(selected.map((id) => byId.get(id))), readyServingNodeIds: observed.readyServingNodeIds });
}
function preflightEvidence(value) { if (!value || !DIGEST.test(value.evidenceDigest ?? "") || typeof value.passed !== "boolean") throw new TypeError("maintenance preflight evidence is invalid"); return Object.freeze({ evidenceDigest: value.evidenceDigest, passed: value.passed, blockers: codes(value.blockers, "preflight blockers"), warnings: codes(value.warnings, "preflight warnings"), secureBootCompatible: value.secureBootCompatible === true, runtimeCompatible: value.runtimeCompatible === true }); }
function compatibilityEvidence(value) { if (!value || !DIGEST.test(value.evidenceDigest ?? "")) throw new TypeError("model compatibility evidence is invalid"); return Object.freeze({ evidenceDigest: value.evidenceDigest, incompatibleProfileIds: idsOrEmpty(value.incompatibleProfileIds, "incompatible profiles"), requiresRevalidationProfileIds: idsOrEmpty(value.requiresRevalidationProfileIds, "revalidation profiles") }); }
function idsOrEmpty(value, name) { if (!Array.isArray(value) || value.some((item) => !UUID.test(item ?? ""))) throw new TypeError(`${name} are invalid`); return Object.freeze([...new Set(value.map((item) => item.toLowerCase()))].sort()); }
function publicPlan(value) { if (!value) return null; if (!STATES.has(value.state)) throw new TypeError("maintenance plan state is invalid"); return Object.freeze({ planId: value.planId, kind: value.kind, candidate: Object.freeze(structuredClone(value.candidate)), targetNodes: Object.freeze(value.targetNodes.map((item) => Object.freeze({ ...item }))), strategy: value.strategy,
  state: value.state, blockers: Object.freeze([...value.blockers]), warnings: Object.freeze([...value.warnings]), preflight: Object.freeze({ ...value.preflight }), compatibility: Object.freeze(structuredClone(value.compatibility)),
  revalidationDecision: value.revalidationDecision, recoveryInstructions: Object.freeze([...value.recoveryInstructions]), rollbackInstructions: Object.freeze([...value.rollbackInstructions]), currentNodeId: value.currentNodeId,
  completedNodeIds: Object.freeze([...value.completedNodeIds]), nodeEvidence: Object.freeze((value.nodeEvidence ?? []).map((item) => Object.freeze({ ...item }))), postCheck: value.postCheck ? Object.freeze(structuredClone(value.postCheck)) : null,
  failureCode: value.failureCode, revision: value.revision, requestedBy: value.requestedBy, createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(), completedAt: value.completedAt ? new Date(value.completedAt).toISOString() : null }); }
function failureCode(error) { return typeof error?.code === "string" && /^update_[a-z0-9_.-]{1,120}$/.test(error.code) ? error.code : "update_execution_failed"; }
function digestEvidence(value, name) { if (!value || value.passed !== true || !DIGEST.test(value.evidenceDigest ?? "")) fail(`update_${name}_failed`, `Maintenance ${name} failed`, 409); return value.evidenceDigest; }

export class MaintenanceWorkflowService {
  #repository; #catalog; #topology; #preflight; #compatibility; #drain; #executor; #postCheck; #audit; #health; #clock; #idFactory;
  constructor({ repository, catalog, topologySource, preflightInspector, modelCompatibility, drainController, executor, postChecker, audit = async () => {}, healthSink = null,
    clock = () => new Date(), idFactory = randomUUID }) {
    if (!repository || ["findByOperationKey", "create", "get", "list", "beginExecution", "beginNode", "completeNode", "complete", "finishFailure"].some((method) => typeof repository[method] !== "function")
      || !catalog || ["list", "get"].some((method) => typeof catalog[method] !== "function") || typeof topologySource?.describe !== "function" 
      || typeof preflightInspector?.inspect !== "function" || typeof modelCompatibility?.evaluate !== "function" || typeof modelCompatibility.fenceAndQueueRevalidation !== "function"
      || !drainController || ["drain", "resume"].some((method) => typeof drainController[method] !== "function") || !executor || ["stagePlatform", "applyPlatform", "rollbackPlatform", "applyHost", "rollbackHost"].some((method) => typeof executor[method] !== "function")
      || typeof postChecker?.verifyNode !== "function" || typeof postChecker.verifyAppliance !== "function" || typeof audit !== "function" || (healthSink !== null && typeof healthSink.recordHealth !== "function")
      || typeof clock !== "function" || typeof idFactory !== "function") throw new TypeError("maintenance workflow dependencies are incomplete");
    this.#repository = repository; this.#catalog = catalog; this.#topology = topologySource; this.#preflight = preflightInspector; this.#compatibility = modelCompatibility;
    this.#drain = drainController; this.#executor = executor; this.#postCheck = postChecker; this.#audit = audit; this.#health = healthSink; this.#clock = clock; this.#idFactory = idFactory;
  }
  async administration({ context }) { actor(context, "update:view"); const observed = inventory(await this.#topology.describe({ targetNodeIds: null })); return Object.freeze({ generatedAt: this.#clock().toISOString(), candidates: Object.freeze((await this.#catalog.list()).map((item) => publicCandidate(candidate(item, item.kind)))), nodes: observed.nodes, plans: Object.freeze((await this.#repository.list({ limit: 100 })).map(publicPlan)) }); }
  async prepare({ context, kind, candidateKey, targetNodeIds, strategy, downtimeAcknowledged = false, revalidationDecision = null, operationKey }) {
    const requestedBy = actor(context); if (!new Set(["platform", "host"]).has(kind) || !KEY.test(candidateKey ?? "") || !OPERATION.test(operationKey ?? "")) fail("maintenance_request_invalid", "Maintenance request is invalid");
    if (strategy !== "single_node_downtime") fail("maintenance_strategy_invalid", "Maintenance strategy is invalid");
    const targets = ids(targetNodeIds, "target nodes");
    if (targets.length !== 1) fail("maintenance_targets_invalid", "Exactly this appliance is required");
    const replay = await this.#repository.findByOperationKey(operationKey);
    if (replay) { if (replay.kind !== kind || replay.candidate.candidateKey !== candidateKey || replay.requestedBy !== requestedBy || replay.strategy !== strategy || replay.revalidationDecision !== revalidationDecision || JSON.stringify(replay.targetNodes.map((item) => item.nodeId)) !== JSON.stringify(targets)) fail("maintenance_idempotency_conflict", "Maintenance operation facts changed", 409); return publicPlan(replay); }
    const fullCandidate = candidate(await this.#catalog.get({ kind, candidateKey }), kind), observedTopology = topology(await this.#topology.describe({ targetNodeIds: targets }), targets), now = this.#clock();
    const planId = this.#idFactory(); if (!UUID.test(planId ?? "")) throw new TypeError("maintenance idFactory must return a UUID");
    const preflight = preflightEvidence(await this.#preflight.inspect({ planId: planId.toLowerCase(), kind, candidate: fullCandidate, targetNodes: observedTopology.nodes }));
    const compatibility = compatibilityEvidence(await this.#compatibility.evaluate({ kind, candidate: fullCandidate, targetNodes: observedTopology.nodes })), blockers = [...preflight.blockers], warnings = [...preflight.warnings];
    if (!preflight.passed) blockers.push("preflight_failed");
    if (kind === "host" && !preflight.secureBootCompatible) blockers.push("secure_boot_incompatible"); if (!preflight.runtimeCompatible) blockers.push("runtime_incompatible");
    if (compatibility.incompatibleProfileIds.length) blockers.push("model_profile_incompatible");
    if (compatibility.requiresRevalidationProfileIds.length && revalidationDecision !== "fence_and_revalidate") blockers.push("model_revalidation_decision_required");
    if (strategy === "single_node_downtime" && (!downtimeAcknowledged || observedTopology.readyServingNodeIds.length !== 1 || targets.length !== 1)) blockers.push("single_node_downtime_not_acknowledged");
    const createdAt = now.toISOString();
    const saved = await this.#repository.create({ planId: planId.toLowerCase(), operationKey, kind, candidate: publicCandidate(fullCandidate), targetNodes: observedTopology.nodes, strategy,
      state: blockers.length ? "blocked" : "ready", blockers: codes(blockers, "maintenance blockers"), warnings: codes(warnings, "maintenance warnings"), preflight, compatibility,
      revalidationDecision, recoveryInstructions: fullCandidate.recoveryInstructions, rollbackInstructions: fullCandidate.rollbackInstructions, requestedBy, createdAt });
    await this.#audit({ action: kind === "platform" ? "platform_update.preflight_completed" : "host_maintenance.preflight_completed", actorIdentityId: requestedBy, resourceKind: "maintenance_plan", resourceId: saved.planId,
      planId: saved.planId, candidateKey, candidateVersion: fullCandidate.version, planState: saved.state, blockerCount: saved.blockers.length, targetCount: targets.length, strategy });
    return publicPlan(saved);
  }
  async get({ context, planId }) { actor(context, "update:view"); if (!UUID.test(planId ?? "")) fail("maintenance_plan_invalid", "Maintenance plan is invalid"); const value = await this.#repository.get(planId); if (!value) fail("maintenance_plan_not_found", "Maintenance plan was not found", 404); return publicPlan(value); }
  async execute({ context, planId, expectedRevision, confirmation }) {
    const requestedBy = actor(context); if (!UUID.test(planId ?? "") || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || confirmation !== `APPLY ${planId}`) fail("maintenance_execution_confirmation_required", "Exact maintenance confirmation is required", 409);
    const existing = await this.#repository.get(planId); if (!existing) fail("maintenance_plan_not_found", "Maintenance plan was not found", 404); if (existing.requestedBy !== requestedBy) fail("maintenance_plan_owner_changed", "Maintenance plan owner changed", 409);
    if (existing.state !== "ready") fail(existing.state === "blocked" ? "maintenance_preflight_blocked" : "maintenance_state_conflict", "Maintenance plan is not ready", 409);
    if (existing.strategy !== "single_node_downtime" || existing.targetNodes.length !== 1) fail("maintenance_targets_invalid", "Only this appliance can be maintained");
    await this.#topology.describe({ targetNodeIds: existing.targetNodes.map(n => n.nodeId) });
    let plan = await this.#repository.beginExecution(planId, { expectedRevision, updatedAt: this.#clock().toISOString() }); if (!plan) fail("maintenance_revision_conflict", "Maintenance plan revision changed", 409);
    await this.#audit({ action: plan.kind === "platform" ? "platform_update.started" : "host_maintenance.started", actorIdentityId: requestedBy, resourceKind: "maintenance_plan", resourceId: planId, planId, candidateVersion: plan.candidate.version, targetCount: plan.targetNodes.length, strategy: plan.strategy });
    const attempted = [];
    try {
      const fullCandidate = candidate(await this.#catalog.get({ kind: plan.kind, candidateKey: plan.candidate.candidateKey }), plan.kind); if (fullCandidate.digest !== plan.candidate.digest) fail("update_candidate_drift", "Maintenance candidate changed after preflight", 409);
      if (plan.compatibility.requiresRevalidationProfileIds.length) await this.#compatibility.fenceAndQueueRevalidation({ profileIds: plan.compatibility.requiresRevalidationProfileIds, planId, phase: "before_update" });
      for (const node of plan.targetNodes) {
        plan = await this.#repository.beginNode(planId, { expectedRevision: plan.revision, nodeId: node.nodeId, updatedAt: this.#clock().toISOString() }); if (!plan) fail("maintenance_revision_conflict", "Maintenance node transition changed", 409);
        attempted.push(node.nodeId); const drainDigest = digestEvidence(await this.#drain.drain({ nodeId: node.nodeId, planId, kind: plan.kind }), "drain");
        let applyDigest;
        if (plan.kind === "platform") { digestEvidence(await this.#executor.stagePlatform({ nodeId: node.nodeId, candidate: fullCandidate, planId }), "stage"); applyDigest = digestEvidence(await this.#executor.applyPlatform({ nodeId: node.nodeId, candidate: fullCandidate, planId }), "apply"); }
        else applyDigest = digestEvidence(await this.#executor.applyHost({ nodeId: node.nodeId, candidate: fullCandidate, planId }), "apply");
        const nodePostCheckDigest = digestEvidence(await this.#postCheck.verifyNode({ nodeId: node.nodeId, kind: plan.kind, candidate: fullCandidate, planId }), "postcheck");
        digestEvidence(await this.#drain.resume({ nodeId: node.nodeId, planId, kind: plan.kind }), "resume");
        plan = await this.#repository.completeNode(planId, { expectedRevision: plan.revision, nodeId: node.nodeId, evidence: { drainDigest, applyDigest, postCheckDigest: nodePostCheckDigest }, updatedAt: this.#clock().toISOString() }); if (!plan) fail("maintenance_revision_conflict", "Maintenance node completion changed", 409);
      }
      const applianceCheck = await this.#postCheck.verifyAppliance({ kind: plan.kind, candidate: fullCandidate, targetNodeIds: plan.targetNodes.map((item) => item.nodeId), planId }); const applianceDigest = digestEvidence(applianceCheck, "appliance_postcheck");
      if (plan.compatibility.requiresRevalidationProfileIds.length) await this.#compatibility.fenceAndQueueRevalidation({ profileIds: plan.compatibility.requiresRevalidationProfileIds, planId, phase: "after_update" });
      const completedAt = this.#clock().toISOString(); plan = await this.#repository.complete(planId, { expectedRevision: plan.revision, postCheck: { evidenceDigest: applianceDigest, passed: true }, completedAt }); if (!plan) fail("maintenance_revision_conflict", "Maintenance completion changed", 409);
      try { await this.#audit({ action: plan.kind === "platform" ? "platform_update.completed" : "host_maintenance.completed", actorIdentityId: requestedBy, resourceKind: "maintenance_plan", resourceId: planId, planId, candidateVersion: plan.candidate.version, nodeCount: plan.completedNodeIds.length, evidenceDigest: applianceDigest }); }
      catch { try { await this.#health?.recordHealth({ target: { kind: "core_service", key: "update.service" }, state: "degraded", reasonCode: "update_completion_audit_failed", facts: { operation: plan.kind, state: "completed", reasonCode: "update_completion_audit_failed" } }); } catch {} throw new PlatformError("update_completion_audit_failed", "Maintenance completed but its audit record failed", { status: 503, retryable: true, details: { planId } }); }
      try { await this.#health?.recordHealth({ target: { kind: "core_service", key: "update.service" }, state: "healthy", facts: { operation: plan.kind, state: "completed" } }); } catch {}
      return publicPlan(plan);
    } catch (error) {
      if (plan?.state === "completed") throw error;
      let rollbackPassed = existing.candidate.rollbackAvailable === true, rollbackDigest = null;
      for (const nodeId of existing.candidate.rollbackAvailable ? [...new Set(attempted)].reverse() : []) {
        try { const result = plan.kind === "platform" ? await this.#executor.rollbackPlatform({ nodeId, planId, candidateDigest: plan.candidate.digest }) : await this.#executor.rollbackHost({ nodeId, planId, candidateDigest: plan.candidate.digest }); rollbackDigest = digestEvidence(result, "rollback"); digestEvidence(await this.#drain.resume({ nodeId, planId, kind: plan.kind }), "rollback_resume"); }
        catch { rollbackPassed = false; }
      }
      if (!existing.candidate.rollbackAvailable || attempted.length === 0) rollbackPassed = attempted.length === 0;
      const code = failureCode(error), completedAt = this.#clock().toISOString(); plan = await this.#repository.finishFailure(planId, { rollbackPassed, failureCode: rollbackPassed ? code : "update_manual_recovery_required", postCheck: rollbackDigest ? { evidenceDigest: rollbackDigest, passed: rollbackPassed } : null, completedAt });
      await this.#audit({ action: rollbackPassed ? (plan.kind === "platform" ? "platform_update.rolled_back" : "host_maintenance.rolled_back") : (plan.kind === "platform" ? "platform_update.manual_recovery_required" : "host_maintenance.manual_recovery_required"), actorIdentityId: requestedBy,
        resourceKind: "maintenance_plan", resourceId: planId, planId, errorCode: code, rollbackPassed, success: false });
      try { await this.#health?.recordHealth({ target: { kind: "core_service", key: "update.service" }, state: rollbackPassed ? "degraded" : "unavailable", reasonCode: rollbackPassed ? code : "update_manual_recovery_required", facts: { operation: plan.kind, state: plan.state, reasonCode: plan.failureCode } }); } catch {}
      throw new PlatformError(plan.failureCode, rollbackPassed ? "Maintenance failed and was rolled back" : "Maintenance requires manual recovery", { status: 409, retryable: false, details: { planId } });
    }
  }
}
