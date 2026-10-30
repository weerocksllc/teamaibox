import { PlatformError } from "../../../packages/observability/src/index.mjs";

function copy(value) {
  return value == null ? null : structuredClone(value);
}

function positiveRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

/**
 * In-memory persistence contract for protected-set orchestration.  The same
 * contract can be backed by PostgreSQL once the durable schema is deployed;
 * callers never retain mutable references to a journal record.
 */
export class MemoryProtectedOfficeSetRepository {
  #transactions = new Map();
  #sets = new Map();
  #tail = Promise.resolve();

  constructor({ transactions = [], setStates = [] } = {}) {
    for (const transaction of transactions) {
      this.#transactions.set(transaction.transactionId, copy(transaction));
    }
    for (const state of setStates) this.#sets.set(state.setId, copy(state));
  }

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async beginTransaction(value) {
    return this.#exclusive(async () => {
      if (!value || typeof value.transactionId !== "string" || value.transactionId.length < 8) {
        throw new TypeError("protected-set transaction identity is invalid");
      }
      if (this.#transactions.has(value.transactionId)) {
        throw new PlatformError("protected_set_transaction_conflict", "Protected-set transaction already exists", { status: 409 });
      }
      if ([...this.#transactions.values()].some((transaction) => transaction.setId === value.setId
          && !new Set(["succeeded", "rolled-back"]).has(transaction.state))) {
        throw new PlatformError("protected_set_transaction_active", "Another protected-set transaction requires completion or recovery", {
          status: 409, retryable: true,
        });
      }
      const stored = { ...copy(value), revision: 1 };
      this.#transactions.set(stored.transactionId, stored);
      return copy(stored);
    });
  }

  async getTransaction(transactionId) {
    return copy(this.#transactions.get(transactionId) ?? null);
  }

  async updateTransaction(transactionId, expectedRevision, patch) {
    positiveRevision(expectedRevision, "expectedRevision");
    return this.#exclusive(async () => {
      const current = this.#transactions.get(transactionId);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PlatformError("protected_set_transaction_revision_conflict", "Protected-set transaction journal changed", { status: 409, retryable: true });
      }
      const nextPatch = typeof patch === "function" ? await patch(copy(current)) : patch;
      if (!nextPatch || typeof nextPatch !== "object" || Array.isArray(nextPatch)) {
        throw new TypeError("protected-set transaction patch is invalid");
      }
      const next = {
        ...current,
        ...copy(nextPatch),
        transactionId,
        revision: current.revision + 1,
        createdAt: current.createdAt,
      };
      this.#transactions.set(transactionId, next);
      return copy(next);
    });
  }

  async commitTransactionAndSetState({
    transactionId,
    expectedTransactionRevision,
    transactionPatch,
    setId,
    expectedSetRevision,
    setState,
  }) {
    positiveRevision(expectedTransactionRevision, "expectedTransactionRevision");
    positiveRevision(expectedSetRevision, "expectedSetRevision");
    return this.#exclusive(async () => {
      const currentTransaction = this.#transactions.get(transactionId);
      const currentSet = this.#sets.get(setId) ?? null;
      if (!currentTransaction) return null;
      if (currentTransaction.revision !== expectedTransactionRevision) {
        throw new PlatformError("protected_set_transaction_revision_conflict", "Protected-set transaction journal changed", { status: 409, retryable: true });
      }
      if ((currentSet?.revision ?? 0) !== expectedSetRevision) {
        throw new PlatformError("protected_set_state_revision_conflict", "Protected-set state changed", { status: 409, retryable: true });
      }
      if (!transactionPatch || typeof transactionPatch !== "object" || Array.isArray(transactionPatch)
          || !setState || typeof setState !== "object" || Array.isArray(setState)) {
        throw new TypeError("protected-set atomic commit is invalid");
      }
      const nextTransaction = {
        ...currentTransaction,
        ...copy(transactionPatch),
        transactionId,
        revision: currentTransaction.revision + 1,
        createdAt: currentTransaction.createdAt,
      };
      const nextSet = {
        ...copy(currentSet ?? {}),
        ...copy(setState),
        setId,
        revision: expectedSetRevision + 1,
        createdAt: currentSet?.createdAt ?? setState.createdAt,
      };
      this.#transactions.set(transactionId, nextTransaction);
      this.#sets.set(setId, nextSet);
      return { transaction: copy(nextTransaction), setState: copy(nextSet) };
    });
  }

  async listIncompleteTransactions({ setId = null } = {}) {
    const terminal = new Set(["succeeded", "rolled-back"]);
    return [...this.#transactions.values()]
      .filter((value) => !terminal.has(value.state) && (setId == null || value.setId === setId))
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
      .map(copy);
  }

  async getSetState(setId) {
    return copy(this.#sets.get(setId) ?? null);
  }

  async putSetState(setId, expectedRevision, value) {
    positiveRevision(expectedRevision, "expectedRevision");
    return this.#exclusive(async () => {
      const current = this.#sets.get(setId) ?? null;
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new PlatformError("protected_set_state_revision_conflict", "Protected-set state changed", { status: 409, retryable: true });
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("protected-set state is invalid");
      }
      const next = {
        ...copy(current ?? {}),
        ...copy(value),
        setId,
        revision: expectedRevision + 1,
        createdAt: current?.createdAt ?? value.createdAt,
      };
      this.#sets.set(setId, next);
      return copy(next);
    });
  }
}
