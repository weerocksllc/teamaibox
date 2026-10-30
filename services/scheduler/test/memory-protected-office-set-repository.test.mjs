import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProtectedOfficeSetRepository } from "../src/memory-protected-office-set-repository.mjs";

const NOW = "2026-09-04T07:00:00.000Z";

test("protected-set memory repository fences concurrent journal revisions", async () => {
  const subject = new MemoryProtectedOfficeSetRepository();
  const transaction = await subject.beginTransaction({
    transactionId: "protected-set-tx-0001", setId: "office.baseline", state: "staging", createdAt: NOW,
  });
  const results = await Promise.allSettled([
    subject.updateTransaction(transaction.transactionId, 1, { state: "probing" }),
    subject.updateTransaction(transaction.transactionId, 1, { state: "rolling-back" }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code,
    "protected_set_transaction_revision_conflict");
  assert.equal((await subject.getTransaction(transaction.transactionId)).revision, 2);
});

test("protected-set memory repository persists recoverable transactions and isolated set state", async () => {
  const subject = new MemoryProtectedOfficeSetRepository();
  await subject.beginTransaction({
    transactionId: "protected-set-tx-0002", setId: "office.baseline", state: "recovery-required", createdAt: NOW,
  });
  const stored = await subject.putSetState("office.baseline", 0, {
    recoveryState: "manual-recovery", healthyIdentities: [{ workerId: "office.assistant" }], createdAt: NOW,
  });
  stored.healthyIdentities[0].workerId = "mutated";

  assert.deepEqual((await subject.listIncompleteTransactions({ setId: "office.baseline" }))
    .map((value) => value.transactionId), ["protected-set-tx-0002"]);
  assert.equal((await subject.getSetState("office.baseline")).healthyIdentities[0].workerId,
    "office.assistant");
  await assert.rejects(subject.putSetState("office.baseline", 0, { recoveryState: "healthy" }), {
    code: "protected_set_state_revision_conflict",
  });
});

test("protected-set memory repository admits at most one recoverable transaction per set", async () => {
  const subject = new MemoryProtectedOfficeSetRepository();
  await subject.beginTransaction({
    transactionId: "protected-set-tx-0010", setId: "office.baseline", state: "staging", createdAt: NOW,
  });
  await assert.rejects(subject.beginTransaction({
    transactionId: "protected-set-tx-0011", setId: "office.baseline", state: "admitting", createdAt: NOW,
  }), { code: "protected_set_transaction_active" });
  assert.equal(await subject.getTransaction("protected-set-tx-0011"), null);
});

test("protected-set memory repository atomically publishes terminal transaction and set state", async () => {
  const subject = new MemoryProtectedOfficeSetRepository();
  const transaction = await subject.beginTransaction({
    transactionId: "protected-set-tx-0012", setId: "office.baseline", state: "probing", createdAt: NOW,
  });
  const committed = await subject.commitTransactionAndSetState({
    transactionId: transaction.transactionId,
    expectedTransactionRevision: transaction.revision,
    transactionPatch: { state: "succeeded", completedAt: NOW },
    setId: "office.baseline", expectedSetRevision: 0,
    setState: { recoveryState: "healthy", observedStateRevision: 4, createdAt: NOW },
  });

  assert.equal(committed.transaction.state, "succeeded");
  assert.equal(committed.setState.recoveryState, "healthy");
  assert.deepEqual(await subject.listIncompleteTransactions(), []);
});
