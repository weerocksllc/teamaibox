import assert from "node:assert/strict";
import test from "node:test";

import { MaintenanceWorkflowService } from "../src/updates/maintenance-workflow-service.mjs";
import { MemoryMaintenanceRepository } from "../src/updates/memory-maintenance-repository.mjs";
import { PostgresMaintenanceTopologySource, StaticMaintenanceCatalog } from "../src/updates/production-maintenance-adapters.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const PLAN = "018f6f18-24d7-7c21-9b62-8c0174199601";
const NODE_A = "018f6f18-24d7-7c21-9b62-8c0174199701";
const NODE_B = "018f6f18-24d7-7c21-9b62-8c0174199702";
const PROFILE = "018f6f18-24d7-7c21-9b62-8c0174199801";
const DIGEST = `sha256:${"a".repeat(64)}`;
const EVIDENCE = `sha256:${"b".repeat(64)}`;
const BACKUP = "018f6f18-24d7-7c21-9b62-8c0174199901";
const RECOVERY = "018f6f18-24d7-7c21-9b62-8c0174199902";
const manage = { identityId: ADMIN, permissions: ["update:view", "update:manage"] };

function result() { return { passed: true, evidenceDigest: EVIDENCE }; }
function candidate(kind = "platform") {
  return { candidateKey: `${kind}.2026-08`, displayName: kind === "platform" ? "Team AI Box 2026.8" : "DGX OS maintenance 2026.8", kind, version: "2026.8.1", digest: DIGEST,
    requiresReboot: kind === "host", rollbackAvailable: true, recoveryInstructions: ["Open the recovery console and select this recorded plan."],
    rollbackInstructions: ["Use the recorded previous slot and verify service health."], execution: { imageManifest: "registry.local/platform@sha256:internal", packages: ["nvidia-driver-580"] } };
}

function fixture({ kind = "platform", nodes = [NODE_A], staleBackup = false, preflight = {}, compatibility = {}, failApplyNode = null, failRollback = false, failCompletionAudit = false } = {}) {
  const repository = new MemoryMaintenanceRepository(), events = [], audit = [], health = [], fenced = [];
  const offered = candidate(kind);
  const service = new MaintenanceWorkflowService({ repository,
    catalog: { async list() { return [offered]; }, async get(input) { assert.deepEqual(input, { kind, candidateKey: offered.candidateKey }); return offered; } },
    topologySource: {
      async describe() { return { nodes: nodes.map((nodeId, index) => ({ nodeId, nodeKey: `spark-${index + 1}`, lifecycleState: "ready", healthState: "healthy" })), readyServingNodeIds: nodes }; },
    },
    preflightInspector: { async inspect(input) { events.push(`preflight:${input.kind}`); return { ...result(), blockers: [], warnings: [], secureBootCompatible: true, runtimeCompatible: true, ...preflight }; } },
    modelCompatibility: {
      async evaluate() { return { evidenceDigest: EVIDENCE, incompatibleProfileIds: [], requiresRevalidationProfileIds: [], ...compatibility }; },
      async fenceAndQueueRevalidation(input) { fenced.push(input); },
    },
    drainController: { async drain({ nodeId }) { events.push(`drain:${nodeId}`); return result(); }, async resume({ nodeId }) { events.push(`resume:${nodeId}`); return result(); } },
    executor: {
      async stagePlatform({ nodeId, candidate: value }) { assert.equal(value.execution.imageManifest, "registry.local/platform@sha256:internal"); events.push(`stage:${nodeId}`); return result(); },
      async applyPlatform({ nodeId }) { events.push(`apply:${nodeId}`); if (nodeId === failApplyNode) throw new Error("simulated apply failure"); return result(); },
      async rollbackPlatform({ nodeId }) { events.push(`rollback:${nodeId}`); if (failRollback) throw new Error("simulated rollback failure"); return result(); },
      async applyHost({ nodeId, candidate: value }) { assert.deepEqual(value.execution.packages, ["nvidia-driver-580"]); events.push(`host-apply:${nodeId}`); if (nodeId === failApplyNode) throw new Error("simulated apply failure"); return result(); },
      async rollbackHost({ nodeId }) { events.push(`host-rollback:${nodeId}`); if (failRollback) throw new Error("simulated rollback failure"); return result(); },
    },
    postChecker: { async verifyNode({ nodeId }) { events.push(`post:${nodeId}`); return result(); }, async verifyAppliance() { events.push("post:appliance"); return result(); } },
    audit: async (value) => { if (failCompletionAudit && value.action.endsWith(".completed")) throw new Error("audit unavailable"); audit.push(value); }, healthSink: { async recordHealth(value) { health.push(value); } }, clock: () => new Date("2026-08-11T12:00:00.000Z"), idFactory: () => PLAN,
  });
  return { service, repository, events, audit, health, fenced, offered };
}

async function prepare(value, overrides = {}) {
  return value.service.prepare({ context: manage, kind: value.offered.kind, candidateKey: value.offered.candidateKey, targetNodeIds: [NODE_A],
    strategy: "single_node_downtime", downtimeAcknowledged: true, operationKey: "maintenance-operation-0001", ...overrides });
}

test("executes a verified update on this appliance without exposing internal execution details", async () => {
  const value = fixture(), ready = await prepare(value);
  assert.equal(ready.state, "ready"); assert.equal(JSON.stringify(ready).includes("imageManifest"), false); assert.equal(JSON.stringify(ready).includes("nvidia-driver"), false);
  const completed = await value.service.execute({ context: manage, planId: PLAN, expectedRevision: ready.revision, confirmation: `APPLY ${PLAN}` });
  assert.equal(completed.state, "completed"); assert.deepEqual(completed.completedNodeIds, [NODE_A]);
  assert.deepEqual(value.events, ["preflight:platform", `drain:${NODE_A}`, `stage:${NODE_A}`, `apply:${NODE_A}`, `post:${NODE_A}`, `resume:${NODE_A}`, "post:appliance"]);
  assert.deepEqual(value.audit.map((item) => item.action), ["platform_update.preflight_completed", "platform_update.started", "platform_update.completed"]);
  assert.equal(value.health.at(-1).state, "healthy");
});

test("blocks failed preflight, incompatible profiles, and unacknowledged downtime and removed remote strategies", async () => {
  const stale = fixture({ staleBackup: true, preflight: { passed: false, blockers: ["disk_space_low"], runtimeCompatible: false }, compatibility: { incompatibleProfileIds: [PROFILE] } });
  const blocked = await prepare(stale); assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.blockers, ["disk_space_low", "model_profile_incompatible", "preflight_failed", "runtime_incompatible"]);
  await assert.rejects(stale.service.execute({ context: manage, planId: PLAN, expectedRevision: blocked.revision, confirmation: `APPLY ${PLAN}` }), { code: "maintenance_preflight_blocked" });
  const single = fixture({ nodes: [NODE_A] });
  await assert.rejects(prepare(single, {strategy: "rolling"}), {code: "maintenance_strategy_invalid"});
  const downtime = fixture({ nodes: [NODE_A] });
  const unacknowledged = await prepare(downtime, { targetNodeIds: [NODE_A], strategy: "single_node_downtime", downtimeAcknowledged: false }); assert.equal(unacknowledged.state, "blocked");
  const acknowledged = fixture({ nodes: [NODE_A] });
  assert.equal((await prepare(acknowledged, { targetNodeIds: [NODE_A], strategy: "single_node_downtime", downtimeAcknowledged: true })).state, "ready");
});

test("requires an explicit model fencing decision for host maintenance and records both revalidation phases", async () => {
  const missing = fixture({ kind: "host", compatibility: { requiresRevalidationProfileIds: [PROFILE] } });
  assert.ok((await prepare(missing)).blockers.includes("model_revalidation_decision_required"));
  const value = fixture({ kind: "host", compatibility: { requiresRevalidationProfileIds: [PROFILE] } });
  const ready = await prepare(value, { revalidationDecision: "fence_and_revalidate" });
  const completed = await value.service.execute({ context: manage, planId: PLAN, expectedRevision: ready.revision, confirmation: `APPLY ${PLAN}` });
  assert.equal(completed.state, "completed"); assert.deepEqual(value.fenced.map((item) => item.phase), ["before_update", "after_update"]);
  assert.equal(value.events.filter((item) => item.startsWith("host-apply:")).length, 1);
});

test("rolls back the local appliance and requires recovery when rollback fails", async () => {
  const value = fixture({ failApplyNode: NODE_A }); const ready = await prepare(value);
  await assert.rejects(value.service.execute({ context: manage, planId: PLAN, expectedRevision: ready.revision, confirmation: `APPLY ${PLAN}` }), { code: "update_execution_failed" });
  assert.deepEqual(value.events.filter((item) => item.startsWith("rollback:")), [`rollback:${NODE_A}`]);
  assert.equal((await value.repository.get(PLAN)).state, "rolled_back"); assert.equal(value.health.at(-1).state, "degraded");
  const failed = fixture({ failApplyNode: NODE_A, failRollback: true }); const failedReady = await prepare(failed);
  await assert.rejects(failed.service.execute({ context: manage, planId: PLAN, expectedRevision: failedReady.revision, confirmation: `APPLY ${PLAN}` }), { code: "update_manual_recovery_required" });
  assert.equal((await failed.repository.get(PLAN)).state, "manual_recovery_required"); assert.equal(failed.health.at(-1).state, "unavailable");
});

test("enforces update permissions, idempotency facts, exact confirmation, and candidate secrecy", async () => {
  const value = fixture(), ready = await prepare(value);
  const replay = await prepare(value); assert.equal(replay.planId, ready.planId);
  await assert.rejects(value.service.prepare({ context: manage, kind: "platform", candidateKey: value.offered.candidateKey, targetNodeIds: [NODE_A], strategy: "single_node_downtime", revalidationDecision: "fence_and_revalidate", operationKey: "maintenance-operation-0001" }), { code: "maintenance_idempotency_conflict" });
  await assert.rejects(value.service.execute({ context: manage, planId: PLAN, expectedRevision: ready.revision, confirmation: "yes" }), { code: "maintenance_execution_confirmation_required" });
  await assert.rejects(value.service.administration({ context: { identityId: ADMIN, permissions: [] } }), { code: "update_permission_required" });
  const administration = await value.service.administration({ context: { identityId: ADMIN, permissions: ["update:view"] } });
  assert.equal(administration.nodes.length, 1); assert.equal(JSON.stringify(administration).includes("imageManifest"), false); assert.equal(JSON.stringify(administration).includes("nvidia-driver"), false);
});

test("does not roll back a durably completed local update when only the completion audit sink fails", async () => {
  const value = fixture({ failCompletionAudit: true }), ready = await prepare(value);
  await assert.rejects(value.service.execute({ context: manage, planId: PLAN, expectedRevision: ready.revision, confirmation: `APPLY ${PLAN}` }), { code: "update_completion_audit_failed" });
  assert.equal((await value.repository.get(PLAN)).state, "completed"); assert.equal(value.events.some((item) => item.startsWith("rollback:")), false);
  assert.equal(value.health.at(-1).state, "degraded"); assert.equal(value.health.at(-1).reasonCode, "update_completion_audit_failed");
});

test("a fresh appliance can start with no offered maintenance candidates", async () => {
  const catalog = new StaticMaintenanceCatalog({ candidates: [] });
  assert.deepEqual(await catalog.list(), []);
  await assert.rejects(catalog.get({ kind: "platform", candidateKey: "not-offered" }), { code: "maintenance_candidate_not_found" });
  for (const candidates of [undefined, null, {}, ""]) {
    assert.throws(() => new StaticMaintenanceCatalog({ candidates }), /maintenance candidate catalog is invalid/);
  }
});

test("maintenance rejects foreign or multiple targets without running preflight", async () => {
  const value=fixture();
  await assert.rejects(prepare(value,{targetNodeIds:[NODE_A,NODE_B]}),{code:"maintenance_targets_invalid"});
  await assert.rejects(prepare(value,{targetNodeIds:[NODE_B]}),{code:"maintenance_node_not_found"});
  assert.deepEqual(value.events,[]);
  const queries=[]; const topology=new PostgresMaintenanceTopologySource({localNodeId:NODE_A,database:{async query(sql,args){queries.push({sql,args});return {rows:[{id:NODE_A,node_key:"appliance",lifecycle_state:"ready",health:{state:"healthy"}}]};}}});
  await assert.rejects(topology.describe({targetNodeIds:[NODE_B]}),{code:"maintenance_targets_invalid"});
  assert.equal(queries.length,0);
  assert.equal((await topology.describe()).nodes.length,1);
  assert.deepEqual(queries[0].args,[NODE_A]);
  const catalog=new StaticMaintenanceCatalog({candidates:Array.from({length:40},()=>candidate())});
  assert.equal((await catalog.list()).length,40);
});
