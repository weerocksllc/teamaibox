import { PlatformError } from "../../../packages/observability/src/index.mjs";

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function key(bindingId, upstreamRequestId) {
  return `${bindingId}\0${upstreamRequestId}`;
}

export class MemoryOperationConfirmationRepository {
  #operations = new Map();
  #upstream = new Map();
  #tail = Promise.resolve();

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

  async insertOperation(value) {
    return this.#exclusive(async () => {
      const upstreamKey = key(value.bindingId, value.upstreamRequestId);
      const existingId = this.#upstream.get(upstreamKey);
      if (existingId) return { inserted: false, operation: copy(this.#operations.get(existingId)) };
      this.#operations.set(value.id, copy(value));
      this.#upstream.set(upstreamKey, value.id);
      return { inserted: true, operation: copy(value) };
    });
  }

  async findOwnedOperation(operationId, ownerIdentityId) {
    const value = this.#operations.get(operationId);
    return copy(value?.ownerIdentityId === ownerIdentityId ? value : null);
  }

  async findOperation(operationId) {
    return copy(this.#operations.get(operationId) ?? null);
  }

  async updateOperation(value, expectedRevision) {
    return this.#exclusive(async () => {
      const current = this.#operations.get(value.id);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PlatformError("agent_operation_revision_conflict", "Agent operation changed concurrently", { status: 409, retryable: true });
      }
      this.#operations.set(value.id, copy(value));
      return copy(value);
    });
  }

  async claimExpired({ now, limit }) {
    return this.#exclusive(async () => {
      const values = [...this.#operations.values()]
        .filter((value) => value.lifecycleState === "pending" && value.expiresAt <= now)
        .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))
        .slice(0, limit);
      for (const value of values) {
        value.status = "expired";
        value.lifecycleState = "timed_out";
        value.decisionKind = "timeout";
        value.decidedAt = now;
        value.updatedAt = now;
        value.revision += 1;
      }
      return copy(values);
    });
  }

  async markBindingUncertain({ bindingId, reasonCode, now }) {
    return this.#exclusive(async () => {
      const changed = [];
      for (const value of this.#operations.values()) {
        if (value.bindingId !== bindingId || !new Set(["dispatching", "approved", "executing"]).has(value.lifecycleState)) continue;
        const permitted = new Set(["approve", "policy_allow"]).has(value.decisionKind);
        const rejected = new Set(["deny", "policy_deny"]).has(value.decisionKind);
        if (!permitted && !rejected) continue;
        value.lifecycleState = permitted ? "reconcile_required" : "interrupted";
        value.executionBoundary = permitted && value.executionBoundary === "none" ? "unknown" : value.executionBoundary;
        value.upstreamReplyState = value.upstreamReplyState === "accepted" ? "accepted" : "unknown";
        value.reconciliationReasonCode = permitted ? reasonCode : null;
        value.updatedAt = now;
        value.revision += 1;
        changed.push(copy(value));
      }
      return changed;
    });
  }
}
