import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresAssistantRepository } from "../src/assistant/postgres-repository.mjs";

const ownerIdentityId = "00000000-0000-4000-8000-000000008101";
const conversationId = "00000000-0000-4000-8000-000000008102";
const runId = "00000000-0000-4000-8000-000000008103";
const userMessageId = "00000000-0000-4000-8000-000000008104";
const assistantMessageId = "00000000-0000-4000-8000-000000008105";
const now = new Date("2026-08-11T00:00:00.000Z");

function conversationRow() {
  return {
    id: conversationId,
    owner_identity_id: ownerIdentityId,
    title: "Persistent conversation",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

function runRow() {
  return {
    id: runId,
    conversation_id: conversationId,
    owner_identity_id: ownerIdentityId,
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
    requested_mode: "auto",
    effective_mode: "agent",
    status: "queued",
    routing: { effectiveMode: "agent", modelKey: "auto.agent" },
    pending_confirmation_id: null,
    terminal_error: null,
    created_at: now.toISOString(),
    started_at: null,
    completed_at: null,
  };
}

function submission() {
  const routing = { effectiveMode: "agent", targetKind: "internal", providerKey: "platform.compute", modelKey: "auto.agent", profileKey: null, reasonKey: "assistant.routing.agent_intent" };
  return {
    userMessage: {
      id: userMessageId, conversationId, runId, role: "user", content: "write report",
      requestedMode: "auto", effectiveMode: "agent", status: "completed", artifacts: [], sources: [],
      toolCalls: [], routing, usage: null, createdAt: now, completedAt: now,
    },
    assistantMessage: {
      id: assistantMessageId, conversationId, runId, role: "assistant", content: "",
      requestedMode: "auto", effectiveMode: "agent", status: "streaming", artifacts: [], sources: [],
      toolCalls: [], routing, usage: null, createdAt: now, completedAt: null,
    },
    run: {
      id: runId, ownerIdentityId, conversationId, userMessageId, assistantMessageId,
      requestedMode: "auto", effectiveMode: "agent", status: "queued", routing,
      pendingConfirmationId: null, error: null, createdAt: now, startedAt: null, completedAt: null,
    },
    idempotencyKey: "assistant-postgres-1",
    requestDigest: `sha256:${"ab".repeat(32)}`,
    events: [{
      id: "00000000-0000-4000-8000-000000008106", conversationId, runId,
      type: "run.created", data: { status: "queued" }, createdAt: now,
    }],
  };
}

test("PostgreSQL Assistant submission locks the conversation and atomically writes shared history, run, and events", async () => {
  const calls = [];
  const database = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM platform.assistant_runs") && sql.includes("idempotency_key")) return { rows: [] };
      if (sql.includes("FROM platform.assistant_conversations") && sql.includes("FOR UPDATE")) return { rows: [{ present: 1 }] };
      if (sql.includes("max(message_ordinal)")) return { rows: [{ next_ordinal: "3" }] };
      if (sql.includes("INSERT INTO platform.assistant_events")) {
        return { rows: [{
          sequence_id: "17",
          event_id: parameters[0],
          conversation_id: parameters[1],
          run_id: parameters[2],
          event_type: parameters[3],
          event_data: JSON.parse(parameters[4]),
          created_at: parameters[5],
        }] };
      }
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const result = await new PostgresAssistantRepository({ database }).insertSubmission(submission());
  assert.equal(result.inserted, true);
  assert.equal(result.run.id, runId);
  assert.ok(calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO platform.assistant_runs")));
  assert.equal(calls.filter(({ sql }) => sql.includes("INSERT INTO platform.assistant_messages")).length, 2);
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT INTO platform.assistant_events")));
  const messages = calls.filter(({ sql }) => sql.includes("INSERT INTO platform.assistant_messages"));
  assert.deepEqual(messages.map(({ parameters }) => parameters[3]), [3, 4]);
});

test("PostgreSQL Assistant projections map persisted JSON and timestamps", async () => {
  const messageRow = {
    id: assistantMessageId,
    conversation_id: conversationId,
    run_id: runId,
    role: "assistant",
    content: "done",
    requested_mode: "auto",
    effective_mode: "agent",
    status: "completed",
    artifacts: [{ referenceId: "artifact.report.1" }],
    sources: [{ referenceId: "object.source.1", label: "Source", url: "/source" }],
    tool_calls: [{ id: "tool.write.1", status: "succeeded" }],
    routing: { modelKey: "auto.agent" },
    usage: { inputTokens: 4, outputTokens: 2 },
    created_at: now.toISOString(),
    completed_at: now.toISOString(),
  };
  const database = {
    async query(sql) {
      if (sql.includes("assistant_conversations")) return { rows: [conversationRow()] };
      if (sql.includes("assistant_messages")) return { rows: [messageRow] };
      if (sql.includes("assistant_runs")) return { rows: [runRow()] };
      return { rows: [] };
    },
    async transaction(operation) { return operation(this); },
  };
  const repository = new PostgresAssistantRepository({ database });
  const conversation = await repository.findOwnedConversation(ownerIdentityId, conversationId);
  const messages = await repository.listMessages(conversationId);
  const run = await repository.findRun(runId);
  assert.equal(conversation.title, "Persistent conversation");
  assert.equal(messages[0].artifacts[0].referenceId, "artifact.report.1");
  assert.equal(messages[0].completedAt.toISOString(), now.toISOString());
  assert.equal(run.routing.modelKey, "auto.agent");
});

test("PostgreSQL Assistant repository requires a transactional adapter", () => {
  assert.throws(
    () => new PostgresAssistantRepository({ database: { async query() {} } }),
    /transaction/,
  );
});
