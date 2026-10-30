import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentOperationConfirmationService } from "../src/agent-operation-confirmation-service.mjs";
import { AgentOperationPolicy } from "../src/agent-operation-policy.mjs";
import { MemoryOperationConfirmationRepository } from "../src/memory-operation-confirmation-repository.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const OTHER = "018f6f18-24d7-7c21-9b62-8c0174199589";
const BINDING = "018f6f18-24d7-7c21-9b62-8c017419958b";
const PROMPT = "018f6f18-24d7-7c21-9b62-8c017419958c";
const AUTH_EVENT = "018f6f18-24d7-7c21-9b62-8c017419958d";
const POLICY = JSON.parse(await readFile(new URL("../../../deploy/agent/operation-policy.v1.json", import.meta.url), "utf8"));

function shellAction() {
  return {
    kind: "shell.execute",
    tool: "bash",
    summary: "Delete generated build output",
    scope: { argv: ["rm", "-r", "/workspace/project/dist"], cwd: "/workspace/project" },
  };
}

function fixture({ replyError = null, actor = OWNER, directory = "/workspace/owner-a" } = {}) {
  let now = new Date("2026-08-11T08:00:00.000Z");
  const replies = [];
  const interrupts = [];
  const audits = [];
  const service = new AgentOperationConfirmationService({
    repository: new MemoryOperationConfirmationRepository(),
    policy: new AgentOperationPolicy({ policy: POLICY }),
    clock: () => new Date(now),
    sessions: {
      async resolveOwned(input) {
        if (input.ownerIdentityId !== OWNER || input.bindingId !== BINDING || input.promptId !== PROMPT) return null;
        return { ...input, directory, sessionId: "ses_123" };
      },
      async resolveBinding(bindingId) {
        assert.equal(bindingId, BINDING);
        return { ownerIdentityId: OWNER, bindingId, directory, sessionId: "ses_123" };
      },
    },
    adapter: {
      async replyToolConfirmation(input) {
        replies.push(structuredClone(input));
        if (replyError) throw replyError;
        return true;
      },
      async interrupt(input) { interrupts.push(structuredClone(input)); return true; },
    },
    decisionAuthenticator: {
      async verify({ actionDigest }) {
        assert.match(actionDigest, /^sha256:/);
        return {
          actorIdentityId: actor,
          authenticationEventId: AUTH_EVENT,
          proofDigest: `sha256:${"a".repeat(64)}`,
          authenticatedAt: new Date(now),
          assurance: "local-session",
        };
      },
    },
    audit: async (event) => audits.push(structuredClone(event)),
  });
  return { service, replies, interrupts, audits, advance(ms) { now = new Date(now.getTime() + ms); } };
}

async function propose(service, action = shellAction(), upstreamRequestId = "per_123") {
  return service.propose({ ownerIdentityId: OWNER, bindingId: BINDING, promptId: PROMPT, upstreamRequestId, action });
}

test("authenticated approval is exact-scope, one-shot, audited, and never grants always", async () => {
  const { service, replies, audits } = fixture();
  const pending = await propose(service);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.action.scope.argv, ["rm", "-r", "/workspace/project/dist"]);
  const approved = await service.decide(OWNER, pending.id, { decision: "approve", assertion: "signed-session-assertion" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.executionBoundary, "unknown");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].reply, "once");
  assert.ok(replies.every((value) => value.reply !== "always"));
  assert.equal(audits.at(-1).authenticationEventId, AUTH_EVENT);
  assert.ok(!JSON.stringify(audits).includes("/workspace/project/dist"));
});

test("wrong actor and concurrent duplicate decisions fail before a second upstream reply", async () => {
  const wrong = fixture({ actor: OTHER });
  const pending = await propose(wrong.service);
  await assert.rejects(wrong.service.decide(OWNER, pending.id, { decision: "approve", assertion: "wrong-owner" }), { code: "agent_operation_authentication_invalid" });
  assert.equal(wrong.replies.length, 0);

  const concurrent = fixture();
  const value = await propose(concurrent.service);
  const results = await Promise.allSettled([
    concurrent.service.decide(OWNER, value.id, { decision: "approve", assertion: "a" }),
    concurrent.service.decide(OWNER, value.id, { decision: "approve", assertion: "b" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(concurrent.replies.length, 1);
});

test("approval and interruption race has one fenced winner and one upstream reply", async () => {
  const value = fixture();
  const pending = await propose(value.service);
  const results = await Promise.allSettled([
    value.service.decide(OWNER, pending.id, { decision: "approve", assertion: "approve" }),
    value.service.interrupt(OWNER, pending.id, { assertion: "interrupt" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(value.replies.length, 1);
  assert.notEqual(value.replies[0].reply, "always");
});

test("policy auto-allows read-only work and denies host access without user confirmation", async () => {
  const { service, replies } = fixture();
  const read = await propose(service, { kind: "filesystem.read", tool: "read", summary: "Read source", scope: { path: "/workspace/project/a.js" } }, "per_read");
  assert.equal(read.status, "approved");
  assert.equal(replies[0].reply, "once");
  const host = await propose(service, { kind: "host.access", tool: "bash", summary: "Read host", scope: { path: "/etc/shadow" } }, "per_host");
  assert.equal(host.status, "denied");
  assert.equal(replies[1].reply, "reject");
});

test("path traversal session mappings are rejected before OpenCode confirmation dispatch", async () => {
  for (const directory of ["/workspace/../run/secrets", "/workspace/owner-a/../../etc", "/workspace//owner-a"]) {
    const value = fixture({ directory });
    await assert.rejects(propose(value.service), { code: "agent_operation_session_invalid" });
    assert.equal(value.replies.length, 0);
  }
});

test("confirmation timeout rejects upstream and cannot later be approved", async () => {
  const value = fixture();
  const pending = await propose(value.service);
  value.advance(121_000);
  const expired = await value.service.expirePending();
  assert.equal(expired[0].status, "timed_out");
  assert.equal(value.replies[0].reply, "reject");
  await assert.rejects(value.service.decide(OWNER, pending.id, { decision: "approve", assertion: "late" }), { code: "agent_operation_state_conflict" });
});

test("authenticated interruption rejects a pending action and aborts the OpenCode session", async () => {
  const value = fixture();
  const pending = await propose(value.service);
  const interrupted = await value.service.interrupt(OWNER, pending.id, { assertion: "session" });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(value.replies[0].reply, "reject");
  assert.equal(value.interrupts.length, 1);
});

test("unknown approval outcome and crash require manual reconciliation without blind replay", async () => {
  const unknown = fixture({ replyError: new Error("connection reset") });
  const pending = await propose(unknown.service);
  const uncertain = await unknown.service.decide(OWNER, pending.id, { decision: "approve", assertion: "session" });
  assert.equal(uncertain.status, "reconcile_required");
  assert.equal(unknown.interrupts.length, 1);
  const reconciled = await unknown.service.reconcile(OWNER, pending.id, { outcome: "not_executed", reasonCode: "verified_workspace_unchanged", assertion: "session" });
  assert.equal(reconciled.status, "reconciled");
  assert.equal(reconciled.reconciliationOutcome, "not_executed");
  assert.equal(unknown.replies.length, 1, "reconciliation must not replay approval");

  const crashed = fixture();
  const proposed = await propose(crashed.service);
  await crashed.service.decide(OWNER, proposed.id, { decision: "approve", assertion: "session" });
  const marked = await crashed.service.markBindingCrashed(BINDING);
  assert.equal(marked[0].status, "reconcile_required");
  assert.equal(crashed.replies.length, 1, "crash handling must not replay approval");
});
