import assert from "node:assert/strict";
import test from "node:test";

import { PostgresMaintenanceRepository } from "../src/updates/postgres-maintenance-repository.mjs";

const PLAN = "018f6f18-24d7-7c21-9b62-8c0174199601", NODE = "018f6f18-24d7-7c21-9b62-8c0174199701", ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const NOW = "2026-08-11T12:00:00.000Z", DIGEST = `sha256:${"a".repeat(64)}`;
function compact(value) { return value.replace(/\s+/g, " ").trim(); }
function row(state = "ready", revision = 1) { return { id: PLAN, operation_key: "maintenance-operation-0001", maintenance_kind: "platform", candidate: { candidateKey: "platform.2026-08", kind: "platform", version: "2026.8.1", digest: DIGEST },
  target_nodes: [{ nodeId: NODE, nodeKey: "spark-1", lifecycleState: "ready", healthState: "healthy" }], strategy: "single_node_downtime", plan_state: state, blockers: [], warnings: [],
  backup_evidence: { backupSetId: PLAN }, preflight_evidence: { passed: true }, compatibility_evidence: { incompatibleProfileIds: [] }, revalidation_decision: null,
  recovery_instructions: ["Recover the previous slot."], rollback_instructions: ["Rollback the previous slot."], current_node_id: state === "executing" && revision > 2 ? NODE : null,
  post_check: state === "completed" ? { passed: true, evidenceDigest: DIGEST } : null, failure_code: null, revision: String(revision), requested_by: ADMIN, created_at: NOW, updated_at: NOW, completed_at: state === "completed" ? NOW : null }; }
function evidence(state = "completed") { return { plan_id: PLAN, node_id: NODE, node_position: 0, evidence_state: state, drain_digest: state === "completed" ? Buffer.from("b".repeat(64), "hex") : null,
  apply_digest: state === "completed" ? Buffer.from("c".repeat(64), "hex") : null, post_check_digest: state === "completed" ? Buffer.from("d".repeat(64), "hex") : null }; }
class Database { calls = []; constructor(handler) { this.handler = handler; } async query(sql, parameters = []) { const normalized = compact(sql); this.calls.push([normalized, parameters]); return this.handler(normalized, parameters); } async transaction(operation) { return operation(this); } }

test("PostgreSQL maintenance repository persists a plan and fences execution revisions", async () => {
  const database = new Database((sql) => {
    if (sql.startsWith("INSERT INTO platform.maintenance_plans")) return { rows: [row()] };
    if (sql.startsWith("UPDATE platform.maintenance_plans SET plan_state='executing'")) return { rows: [row("executing", 2)] };
    if (sql.startsWith("SELECT * FROM platform.maintenance_node_evidence")) return { rows: [] }; return { rows: [] };
  });
  const repository = new PostgresMaintenanceRepository({ database });
  const created = await repository.create({ planId: PLAN, operationKey: "maintenance-operation-0001", kind: "platform", candidate: row().candidate, targetNodes: row().target_nodes, strategy: "single_node_downtime", state: "ready",
    blockers: [], warnings: [], backupEvidence: row().backup_evidence, preflight: row().preflight_evidence, compatibility: row().compatibility_evidence, revalidationDecision: null,
    recoveryInstructions: row().recovery_instructions, rollbackInstructions: row().rollback_instructions, requestedBy: ADMIN, createdAt: NOW });
  assert.equal(created.state, "ready"); assert.equal((await repository.beginExecution(PLAN, { expectedRevision: 1, updatedAt: NOW })).revision, 2);
  assert.match(database.calls[0][0], /ON CONFLICT \(operation_key\) DO NOTHING/);
});

test("PostgreSQL maintenance repository stores durable per-node intent and closed digest evidence", async () => {
  let planReads = 0;
  const database = new Database((sql) => {
    if (sql === "SELECT * FROM platform.maintenance_plans WHERE id=$1 FOR UPDATE") return { rows: [row("executing", ++planReads === 1 ? 2 : 3)] };
    if (sql.startsWith("INSERT INTO platform.maintenance_node_evidence")) return { rows: [{ plan_id: PLAN }] };
    if (sql.startsWith("UPDATE platform.maintenance_node_evidence SET evidence_state='completed'")) return { rows: [{ plan_id: PLAN }] };
    if (sql.startsWith("UPDATE platform.maintenance_plans SET current_node_id=$2")) return { rows: [row("executing", 3)] };
    if (sql.startsWith("UPDATE platform.maintenance_plans SET current_node_id=NULL")) return { rows: [row("executing", 4)] };
    if (sql.startsWith("SELECT * FROM platform.maintenance_node_evidence")) return { rows: planReads > 1 ? [evidence()] : [] }; return { rows: [] };
  });
  const repository = new PostgresMaintenanceRepository({ database });
  assert.equal((await repository.beginNode(PLAN, { expectedRevision: 2, nodeId: NODE, updatedAt: NOW })).currentNodeId, NODE);
  const completed = await repository.completeNode(PLAN, { expectedRevision: 3, nodeId: NODE, evidence: { drainDigest: `sha256:${"b".repeat(64)}`, applyDigest: `sha256:${"c".repeat(64)}`, postCheckDigest: `sha256:${"d".repeat(64)}` }, updatedAt: NOW });
  assert.deepEqual(completed.completedNodeIds, [NODE]); assert.equal(completed.nodeEvidence[0].applyDigest, `sha256:${"c".repeat(64)}`);
  const digestCall = database.calls.find(([sql]) => sql.startsWith("UPDATE platform.maintenance_node_evidence SET evidence_state='completed'")); assert.ok(Buffer.isBuffer(digestCall[1][2]));
});

test("PostgreSQL maintenance repository requires transactional storage", () => {
  assert.throws(() => new PostgresMaintenanceRepository({ database: { query() {} } }), /query and transaction/);
});
