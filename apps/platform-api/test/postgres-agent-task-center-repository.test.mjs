import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAgentTaskCenterRepository } from "../src/tasks/postgres-agent-task-center-repository.mjs";
import { TaskCenter } from "../src/tasks/task-center.mjs";

const ownerIdentityId = "019ffad1-0000-7000-8000-000000000001";

function row(overrides = {}) {
  return {
    id: "019ffad1-0000-7000-8000-000000000002",
    owner_identity_id: ownerIdentityId,
    agent_session_key: "assistant-run.019ffad1-0000-7000-8000-000000000003",
    operation_kind: "edit",
    title_key: "assistant.confirmation.edit",
    operation_scope: { permission: "edit", patterns: ["workspace/proof.txt"] },
    status: "pending",
    created_at: new Date("2026-08-12T00:00:00Z"),
    expires_at: new Date("2026-08-12T00:05:00Z"),
    decided_at: null,
    decided_by_identity_id: null,
    ...overrides,
  };
}

test("persists TaskCenter Agent confirmations and owner decisions in PostgreSQL", async () => {
  const queries = [];
  const database = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO platform.agent_operation_confirmations")) return { rows: [row({ id: params[0] })] };
      if (sql.includes("UPDATE platform.agent_operation_confirmations") && sql.includes("WHERE id = $1")) {
        return { rows: [row({ id: params[0], status: params[1], decided_at: params[2], decided_by_identity_id: params[3] })] };
      }
      if (sql.includes("WHERE id = $1")) return { rows: [row({ id: params[0] })] };
      if (sql.includes("owner_identity_id = $1")) return { rows: [row()] };
      return { rows: [] };
    },
  };
  const center = new TaskCenter({
    repository: new PostgresAgentTaskCenterRepository({ database }),
    clock: () => new Date("2026-08-12T00:00:00Z"),
  });
  const confirmation = await center.createAgentConfirmation({
    ownerIdentityId,
    agentSessionKey: row().agent_session_key,
    operationKind: "edit",
    titleKey: "assistant.confirmation.edit",
    scope: row().operation_scope,
    expiresAt: new Date("2026-08-12T00:05:00Z"),
  });
  const approved = await center.decideAgentConfirmation(ownerIdentityId, confirmation.id, "approved");
  assert.equal(approved.status, "approved");
  assert.equal(approved.ownerIdentityId, ownerIdentityId);
  assert.ok(queries.some(({ sql }) => sql.includes("bridge_schema_version") && sql.includes("VALUES")));
  assert.ok(queries.some(({ sql }) => sql.includes("decided_by_identity_id")));
});

test("keeps non-Agent task methods delegated while expiring only schema-zero confirmations", async () => {
  const queries = [];
  const repository = new PostgresAgentTaskCenterRepository({
    database: { async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; } },
  });
  await repository.insertTask({ id: "task-1", ownerIdentityId, createdAt: new Date() });
  assert.equal((await repository.findTask("task-1")).id, "task-1");
  await repository.expireAgentConfirmations(new Date("2026-08-12T00:10:00Z"));
  assert.match(queries.at(-1).sql, /bridge_schema_version = 0/);
});
