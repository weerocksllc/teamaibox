import { PlatformError } from "../../../packages/observability/src/index.mjs";

function copy(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export class MemoryAgentSandboxRepository {
  #sandboxes = new Map();
  #owners = new Map();
  #operations = new Map();
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

  async ensureSandbox(value) {
    return this.#exclusive(async () => {
      const existingId = this.#owners.get(value.ownerIdentityId);
      if (existingId) return { inserted: false, sandbox: copy(this.#sandboxes.get(existingId)) };
      this.#sandboxes.set(value.id, copy(value));
      this.#owners.set(value.ownerIdentityId, value.id);
      return { inserted: true, sandbox: copy(value) };
    });
  }

  async findByOwner(ownerIdentityId) {
    const id = this.#owners.get(ownerIdentityId);
    return copy(id ? this.#sandboxes.get(id) : null);
  }

  async findSandbox(sandboxId) {
    return copy(this.#sandboxes.get(sandboxId) ?? null);
  }

  async updateSandbox(value, expectedRevision) {
    return this.#exclusive(async () => {
      const current = this.#sandboxes.get(value.id);
      if (!current) return null;
      if (current.revision !== expectedRevision) {
        throw new PlatformError("agent_sandbox_revision_conflict", "Agent sandbox changed concurrently", { status: 409, retryable: true });
      }
      this.#sandboxes.set(value.id, copy(value));
      return copy(value);
    });
  }

  async acquireOperation({ operationId, sandboxId, now }) {
    return this.#exclusive(async () => {
      const existing = this.#operations.get(operationId);
      if (existing) return { inserted: false, operation: copy(existing), sandbox: copy(this.#sandboxes.get(existing.sandboxId)) };
      const sandbox = this.#sandboxes.get(sandboxId);
      if (!sandbox) return null;
      if (sandbox.state !== "running") throw new PlatformError("agent_sandbox_unavailable", "Agent sandbox is not running", { status: 409, retryable: true });
      const operation = { id: operationId, sandboxId, state: "active", createdAt: now, releasedAt: null };
      this.#operations.set(operation.id, operation);
      sandbox.activeOperations += 1;
      sandbox.lastActivityAt = now;
      sandbox.idleDeadlineAt = null;
      sandbox.revision += 1;
      sandbox.updatedAt = now;
      return { inserted: true, operation: copy(operation), sandbox: copy(sandbox) };
    });
  }

  async releaseOperation({ operationId, now, idleDeadlineAt }) {
    return this.#exclusive(async () => {
      const operation = this.#operations.get(operationId);
      if (!operation) return null;
      const sandbox = this.#sandboxes.get(operation.sandboxId);
      if (operation.state === "released") return { released: false, operation: copy(operation), sandbox: copy(sandbox) };
      operation.state = "released";
      operation.releasedAt = now;
      sandbox.activeOperations = Math.max(0, sandbox.activeOperations - 1);
      sandbox.lastActivityAt = now;
      sandbox.idleDeadlineAt = sandbox.activeOperations === 0 ? idleDeadlineAt : null;
      sandbox.revision += 1;
      sandbox.updatedAt = now;
      return { released: true, operation: copy(operation), sandbox: copy(sandbox) };
    });
  }

  async claimIdle({ now, limit }) {
    return this.#exclusive(async () => {
      const claimed = [...this.#sandboxes.values()]
        .filter((sandbox) => sandbox.state === "running" && sandbox.activeOperations === 0
          && sandbox.idleDeadlineAt && sandbox.idleDeadlineAt <= now)
        .sort((left, right) => left.idleDeadlineAt - right.idleDeadlineAt || left.id.localeCompare(right.id))
        .slice(0, limit);
      for (const sandbox of claimed) {
        sandbox.state = "stopping";
        sandbox.revision += 1;
        sandbox.updatedAt = now;
      }
      return copy(claimed);
    });
  }
}
