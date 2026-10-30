import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { MemoryAuditRepository } from "../src/audit/memory-audit-repository.mjs";
import { auditDomains, HmacAuditKeyring, HmacAuditSigner, TamperEvidentAuditService } from "../src/audit/tamper-evident-audit-service.mjs";

const ADMIN = "018f6f18-24d7-7c21-9b62-8c017419958b";
const RESOURCE = "018f6f18-24d7-7c21-9b62-8c0174199501";
const view = { identityId: ADMIN, permissions: ["audit:view"] };

function fixture() {
  const repository = new MemoryAuditRepository();
  const signer = new HmacAuditSigner({ key: Buffer.alloc(32, 7), keyId: "audit.test.v1" });
  const service = new TamperEvidentAuditService({ repository, signer, clock: () => new Date("2026-08-11T12:00:00.000Z") });
  return { repository, signer, service };
}

test("a chain beyond one million events is verified in fixed-size pages", async () => {
  const total = 1_000_001;
  const event = { action: "test.resource_count" };
  const hash = (previousEventHash) => `sha256:${createHash("sha256")
    .update(JSON.stringify({ event, previousEventHash })).digest("hex")}`;
  let headHash = null;
  for (let index = 0; index < total; index++) headHash = hash(headHash);
  let previousHash = null, scanned = 0, pages = 0;
  const signer = new HmacAuditSigner({ key: Buffer.alloc(32, 7), keyId: "audit.test.v1" });
  const repository = {
    async append() { throw new Error("read-only fixture"); }, async list() { return []; },
    async head() { return { sequenceId: total, eventHash: headHash }; },
    async scan({ afterSequence, throughSequence, limit }) {
      assert.equal(afterSequence, scanned); assert.equal(throughSequence, total); assert.equal(limit, 1000);
      const page = [];
      for (let count = 0; count < limit && scanned < total; count++) {
        const eventHash = hash(previousHash);
        page.push({ sequenceId: ++scanned, canonicalEvent: event, previousEventHash: previousHash,
          eventHash, checkpoint: await signer.signCheckpoint(eventHash) });
        previousHash = eventHash;
      }
      pages++; return page;
    },
  };
  const service = new TamperEvidentAuditService({ repository, signer });
  const result = await service.verifyChain({ context: view });
  assert.equal(result.valid, true); assert.equal(result.verifiedEvents, total); assert.equal(pages, 1001);
});

test("normalizes every required audit domain into one signed append-only chain", async () => {
  const { service } = fixture();
  const actions = [
    "identity.account_disabled", "object.version_committed", "plugin.sandbox.denied", "model_profile.lifecycle_transitioned",
    "provider.contract_tested", "routing_policy.updated", "agent.operation_proposed", "source_center.policy_updated",
    "security.lost_usb_revoked", "secret.rotate", "backup.completed", "platform_update.completed", "operations.diagnostic_exported",
  ];
  const values = [];
  for (const action of actions) values.push(await service.record({ action, actorIdentityId: ADMIN, resourceId: RESOURCE, resourceKind: "fixture", success: true }));
  assert.deepEqual(new Set(values.map((item) => item.domain)), new Set(auditDomains));
  assert.equal(values[0].previousEventHash, null);
  assert.equal(values[1].previousEventHash, values[0].eventHash);
  assert.match(values[0].eventHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(values[0].checkpoint.signature, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal((await service.verifyChain({ context: view })).valid, true);
});

test("stores only redacted bounded metadata and exposes permission-gated cursor reads", async () => {
  const { service } = fixture();
  const event = await service.record({ action: "provider.credential_rotated", actorIdentityId: ADMIN, providerId: RESOURCE, correlationId: "request-audit-12345678",
    secretVersion: 4, evidenceDigest: `sha256:${"a".repeat(64)}`, apiToken: "forbidden", prompt: "private user text", note: "not allowlisted", success: true });
  assert.equal(event.actor.identityId, ADMIN);
  assert.deepEqual(event.resource, { kind: "provider", id: RESOURCE });
  assert.deepEqual(event.metadata, { providerId: RESOURCE, evidenceDigest: `sha256:${"a".repeat(64)}`, secretVersion: 4, success: true });
  assert.equal(JSON.stringify(event).includes("forbidden"), false);
  assert.equal(JSON.stringify(event).includes("private user text"), false);
  await service.record({ action: "routing_policy.updated", actorIdentityId: ADMIN, policyId: RESOURCE, revision: 2 });
  const first = await service.listEvents({ context: view, limit: 1 });
  assert.equal(first.data.length, 1); assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
  const second = await service.listEvents({ context: view, cursor: first.nextCursor, limit: 1 });
  assert.equal(second.data[0].sequenceId, 1);
  const correlated = await service.listEvents({ context: view, domain: "provider", correlationId: "request-audit-12345678" });
  assert.deepEqual(correlated.data.map((item) => item.eventId), [event.eventId]);
  await assert.rejects(service.listEvents({ context: view, correlationId: "short" }), { code: "audit_correlation_invalid" });
  await assert.rejects(service.listEvents({ context: { identityId: ADMIN, permissions: [] } }), { code: "audit_permission_required" });
});

test("detects record, link, signature, and head tampering", async () => {
  for (const patch of [
    { eventHash: `sha256:${"0".repeat(64)}` },
    { previousEventHash: `sha256:${"1".repeat(64)}` },
    { checkpoint: { algorithm: "hmac-sha256", keyId: "audit.test.v1", signature: `hmac-sha256:${"2".repeat(64)}` } },
  ]) {
    const { service, repository } = fixture();
    await service.record({ action: "identity.account_disabled", identityId: RESOURCE });
    repository.tamper(1, patch);
    assert.equal((await service.verifyChain({ context: view })).valid, false);
  }
  const { service, repository } = fixture();
  await service.record({ action: "identity.account_disabled", identityId: RESOURCE });
  repository.tamper(1, { canonicalEvent: { schemaVersion: 1, eventId: randomUUID() } });
  assert.equal((await service.verifyChain({ context: view })).reasonCode, "event_hash_mismatch");
});

test("concurrent writers converge through compare-and-append without forks", async () => {
  const { service } = fixture();
  const events = await Promise.all(Array.from({ length: 64 }, (_, index) => service.record({ action: "administrator.test", sequence: index })));
  assert.equal(new Set(events.map((item) => item.sequenceId)).size, 64);
  const report = await service.verifyChain({ context: view });
  assert.deepEqual({ valid: report.valid, verifiedEvents: report.verifiedEvents }, { valid: true, verifiedEvents: 64 });
});

test("key rotation signs new events while retained verification keys preserve the old chain", async () => {
  const repository = new MemoryAuditRepository();
  const signer = new HmacAuditKeyring({ keys: { "audit.key.v1": Buffer.alloc(32, 1), "audit.key.v2": Buffer.alloc(32, 2) }, activeKeyId: "audit.key.v1" });
  const service = new TamperEvidentAuditService({ repository, signer, clock: () => new Date("2026-08-11T12:00:00.000Z") });
  const checkpointPromise = signer.signCheckpoint(`sha256:${"3".repeat(64)}`);
  signer.activate("audit.key.v2");
  const capturedCheckpoint = await checkpointPromise;
  assert.equal(capturedCheckpoint.keyId, "audit.key.v1");
  assert.equal(await signer.verify(`sha256:${"3".repeat(64)}`, capturedCheckpoint.signature, capturedCheckpoint.keyId), true);
  signer.activate("audit.key.v1");
  const first = await service.record({ action: "key.audit_signer_rotated", resourceId: "audit.key.v1", resourceKind: "key" });
  signer.activate("audit.key.v2");
  const second = await service.record({ action: "key.audit_signer_rotated", resourceId: "audit.key.v2", resourceKind: "key" });
  assert.equal(first.checkpoint.keyId, "audit.key.v1"); assert.equal(second.checkpoint.keyId, "audit.key.v2");
  assert.equal((await service.verifyChain({ context: view })).valid, true);
});

test("verification binds its captured head while legitimate writers continue across pages", async () => {
  const { service, repository } = fixture();
  for (let index = 0; index < 1001; index += 1) await service.record({ action: "administrator.snapshot_test", sequence: index });
  const captured = await repository.head();
  const scan = repository.scan.bind(repository);
  const bounds = [];
  repository.scan = async (options) => {
    bounds.push(options.throughSequence);
    const batch = await scan(options);
    await service.record({ action: "administrator.concurrent_append" });
    return batch;
  };
  const report = await service.verifyChain({ context: view });
  assert.equal(report.valid, true);
  assert.equal(report.verifiedEvents, 1001);
  assert.equal(report.headEventHash, captured.eventHash);
  assert.deepEqual(bounds, [1001, 1001]);
  assert.equal((await repository.head()).sequenceId, 1003);
  repository.scan = scan;
  assert.equal((await service.verifyChain({ context: view })).verifiedEvents, 1003);
});

test("captured-head verification still rejects a missing tail or an out-of-bound repository page", async () => {
  const { service, repository } = fixture();
  await service.record({ action: "administrator.snapshot_test" });
  const scan = repository.scan.bind(repository);
  repository.scan = async () => [];
  assert.equal((await service.verifyChain({ context: view })).reasonCode, "head_mismatch");
  repository.scan = async (options) => (await scan(options)).map((event) => ({ ...event, sequenceId: 2 }));
  await assert.rejects(service.verifyChain({ context: view }), /captured head/);
});
