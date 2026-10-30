import assert from "node:assert/strict";
import test from "node:test";

import { AgentSessionService } from "../src/agent-session-service.mjs";
import { MemoryAgentSessionRepository } from "../src/memory-session-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const CONVERSATION = "018f6f18-24d7-7c21-9b62-8c017419958b";
const RUN_ONE = "018f6f18-24d7-7c21-9b62-8c017419958c";
const RUN_TWO = "018f6f18-24d7-7c21-9b62-8c017419958d";
const RUN_THREE = "018f6f18-24d7-7c21-9b62-8c017419958e";
const CONNECTION = "018f6f18-24d7-7c21-9b62-8c017419958f";
const DIGEST = "sha256:4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41";

function fixture({ repository = new MemoryAgentSessionRepository() } = {}) {
  const audits = [];
  let tick = 0;
  const service = new AgentSessionService({
    repository,
    clock: () => new Date(Date.UTC(2026, 7, 11, 4, 0, tick++)),
    audit: async (event) => { audits.push(event); },
  });
  return { service, audits, repository };
}

async function bind(service) {
  return service.bindConversation({
    ownerIdentityId: OWNER,
    platformConversationId: CONVERSATION,
    workspaceKey: "workspace.user-1",
    sandboxKey: "sandbox.user-1",
    adapterKey: "opencode.http.v1.18",
    upstreamVersion: "1.18.16",
    upstreamArtifactDigest: DIGEST,
    opencodeSessionId: "ses_123",
  });
}

function prompt(runId, idempotencyKey, text = "private prompt text") {
  return {
    platformRunId: runId,
    idempotencyKey,
    model: { providerId: "teamaibox", modelId: "approved.agent" },
    parts: [{ type: "text", text }],
  };
}

test("durably maps one platform conversation and admits prompts idempotently without auditing content", async () => {
  const { service, audits } = fixture();
  const first = await bind(service);
  assert.equal((await bind(service)).id, first.id);
  await assert.rejects(service.bindConversation({
    ownerIdentityId: OWNER, platformConversationId: CONVERSATION,
    workspaceKey: "workspace.changed", sandboxKey: "sandbox.user-1",
    adapterKey: "opencode.http.v1.18", upstreamVersion: "1.18.16",
    upstreamArtifactDigest: DIGEST, opencodeSessionId: "ses_123",
  }), { code: "agent_binding_conflict" });
  const admitted = await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "prompt-one"));
  assert.equal(admitted.status, "admitted");
  assert.equal((await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "prompt-one"))).id, admitted.id);
  await assert.rejects(
    service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "prompt-one", "different private prompt")),
    { code: "agent_idempotency_conflict" },
  );
  assert.ok(!JSON.stringify(audits).includes("private prompt"));
  assert.deepEqual(audits.map((event) => event.action), ["agent.session_bound", "agent.prompt_admitted"]);
});

test("replays gap-free deduplicated events from an authenticated conversation cursor", async () => {
  const { service } = fixture();
  const binding = await bind(service);
  const promptValue = await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "prompt-one"));
  const first = await service.appendEvent(binding.id, {
    promptId: promptValue.id,
    connectionId: CONNECTION,
    connectionOrdinal: 1,
    upstreamEventId: "evt_1",
    type: "session.updated",
    data: { sessionId: "ses_123" },
  });
  assert.equal(first.inserted, true);
  const duplicate = await service.appendEvent(binding.id, {
    promptId: promptValue.id,
    connectionId: CONNECTION,
    connectionOrdinal: 1,
    upstreamEventId: "evt_1",
    type: "session.updated",
    data: { sessionId: "ses_123" },
  });
  assert.equal(duplicate.inserted, false);
  await service.appendEvent(binding.id, {
    promptId: promptValue.id,
    connectionId: CONNECTION,
    connectionOrdinal: 2,
    type: "session.idle",
    data: { sessionId: "ses_123" },
  });
  assert.deepEqual((await service.replayEvents(OWNER, CONVERSATION, { after: 0 })).events.map((event) => event.sequence), [1, 2]);
  const resumed = await service.replayEvents(OWNER, CONVERSATION, { after: 1 });
  assert.deepEqual(resumed.events.map((event) => event.type), ["session.idle"]);
  assert.equal(resumed.cursor, 2);
  await assert.rejects(service.replayEvents("018f6f18-24d7-7c21-9b62-8c0174199590", CONVERSATION), { code: "agent_binding_not_found" });
});

test("bridge restart preserves bindings prompts and replay cursors in durable repository state", async () => {
  const repository = new MemoryAgentSessionRepository();
  const first = fixture({ repository }).service;
  const binding = await bind(first);
  const admitted = await first.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "restart-prompt"));
  await first.markSubmitting(admitted.id);
  await first.appendEvent(binding.id, {
    promptId: admitted.id,
    connectionId: CONNECTION,
    connectionOrdinal: 1,
    upstreamEventId: "evt_restart_1",
    type: "session.updated",
    data: { sessionId: "ses_123" },
  });

  const restarted = fixture({ repository }).service;
  assert.equal((await restarted.getBinding(OWNER, CONVERSATION)).id, binding.id);
  const replay = await restarted.replayEvents(OWNER, CONVERSATION, { after: 0 });
  assert.deepEqual(replay.events.map((event) => event.sequence), [1]);
  assert.equal(replay.cursor, 1);
  const reconciliation = await restarted.beginCrashReconciliation(binding.id, "bridge_restart");
  assert.equal(reconciliation.prompts[0].id, admitted.id);
  assert.equal(reconciliation.prompts[0].status, "reconcile_required");
});

test("crash reconciliation never blindly replays an acceptance-uncertain prompt", async () => {
  const { service } = fixture();
  const binding = await bind(service);
  const accepted = await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "prompt-one"));
  await service.markSubmitting(accepted.id);
  await service.markAccepted(accepted.id);
  await service.markRunning(accepted.id);
  const uncertain = await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_TWO, "prompt-two"));
  await service.markSubmitting(uncertain.id);
  const started = await service.beginCrashReconciliation(binding.id, "sandbox_crash");
  assert.equal(started.binding.state, "reconciling");
  assert.deepEqual(started.prompts.map((value) => value.status), ["reconcile_required", "reconcile_required"]);
  const repeated = await service.beginCrashReconciliation(binding.id, "sandbox_crash");
  assert.equal(repeated.reconciliationId, started.reconciliationId);
  assert.equal(repeated.binding.crashGeneration, 1);
  const resolved = await service.resolveCrashReconciliation(binding.id, {
    upstreamSessionExists: true,
    acceptedMessageIds: [accepted.opencodeMessageId],
  });
  assert.deepEqual(resolved.summary, { resumed: 1, readyToSubmit: 1, incomplete: 0 });
  assert.equal(resolved.binding.state, "active");
  assert.deepEqual(resolved.prompts.map((value) => value.status), ["accepted", "admitted"]);
  assert.equal(resolved.prompts[1].acceptanceBoundary, "none");
});

test("lost upstream state becomes explicit incomplete terminal evidence", async () => {
  const { service } = fixture();
  const binding = await bind(service);
  const value = await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_THREE, "prompt-three"));
  await service.markSubmitting(value.id);
  await service.markAccepted(value.id);
  await service.beginCrashReconciliation(binding.id, "opencode_exit");
  const result = await service.resolveCrashReconciliation(binding.id, {
    upstreamSessionExists: false,
    acceptedMessageIds: [],
  });
  assert.equal(result.binding.state, "terminal");
  assert.equal(result.binding.terminal.code, "upstream_session_lost");
  assert.equal(result.prompts[0].status, "incomplete");
  assert.equal(result.prompts[0].terminal.requiresHumanReconciliation, true);
  await assert.rejects(service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_TWO, "after-terminal")), { code: "agent_binding_unavailable" });
});

test("prompt lifecycle exposes acceptance and exactly one terminal transition", async () => {
  const { service } = fixture();
  await bind(service);
  const value = await service.admitPrompt(OWNER, CONVERSATION, prompt(RUN_ONE, "prompt-one"));
  assert.equal((await service.markSubmitting(value.id)).acceptanceBoundary, "unknown");
  assert.equal((await service.markAccepted(value.id)).acceptanceBoundary, "accepted");
  assert.equal((await service.markRunning(value.id)).status, "running");
  const completed = await service.completePrompt(value.id, { status: "completed", code: "agent_completed" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.terminal.code, "agent_completed");
  await assert.rejects(service.completePrompt(value.id, { status: "failed", code: "late_failure" }), { code: "agent_prompt_state_conflict" });
});
