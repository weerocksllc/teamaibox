function clone(value) { return value == null ? null : structuredClone(value); }

export class MemoryMaintenanceRepository {
  #plans = new Map(); #operations = new Map();
  async findByOperationKey(operationKey) { const id = this.#operations.get(operationKey); return clone(id ? this.#plans.get(id) : null); }
  async create(value) {
    if (this.#operations.has(value.operationKey)) return clone(this.#plans.get(this.#operations.get(value.operationKey)));
    const stored = { ...clone(value), currentNodeId: null, completedNodeIds: [], nodeEvidence: [], postCheck: null, failureCode: null, revision: 1,
      updatedAt: value.createdAt, completedAt: null };
    this.#plans.set(value.planId, stored); this.#operations.set(value.operationKey, value.planId); return clone(stored);
  }
  async get(planId) { return clone(this.#plans.get(planId)); }
  async list({ limit = 100 } = {}) { return [...this.#plans.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit).map(clone); }
  async beginExecution(planId, { expectedRevision, updatedAt }) { const value = this.#plans.get(planId); if (!value || value.state !== "ready" || value.revision !== expectedRevision) return null; Object.assign(value, { state: "executing", revision: value.revision + 1, updatedAt }); return clone(value); }
  async beginNode(planId, { expectedRevision, nodeId, updatedAt }) { const value = this.#plans.get(planId); if (!value || value.state !== "executing" || value.revision !== expectedRevision || value.currentNodeId !== null || value.completedNodeIds.includes(nodeId)) return null; Object.assign(value, { currentNodeId: nodeId, revision: value.revision + 1, updatedAt }); return clone(value); }
  async completeNode(planId, { expectedRevision, nodeId, evidence, updatedAt }) { const value = this.#plans.get(planId); if (!value || value.state !== "executing" || value.revision !== expectedRevision || value.currentNodeId !== nodeId) return null; value.completedNodeIds.push(nodeId); value.nodeEvidence.push(clone({ nodeId, ...evidence })); Object.assign(value, { currentNodeId: null, revision: value.revision + 1, updatedAt }); return clone(value); }
  async complete(planId, { expectedRevision, postCheck, completedAt }) { const value = this.#plans.get(planId); if (!value || value.state !== "executing" || value.revision !== expectedRevision || value.currentNodeId !== null || value.completedNodeIds.length !== value.targetNodes.length) return null; Object.assign(value, { state: "completed", postCheck: clone(postCheck), revision: value.revision + 1, updatedAt: completedAt, completedAt }); return clone(value); }
  async finishFailure(planId, { rollbackPassed, failureCode, postCheck, completedAt }) { const value = this.#plans.get(planId); if (!value || !new Set(["executing", "ready"]).has(value.state)) return clone(value); Object.assign(value, { state: rollbackPassed ? "rolled_back" : "manual_recovery_required", currentNodeId: null,
    postCheck: clone(postCheck), failureCode, revision: value.revision + 1, updatedAt: completedAt, completedAt }); return clone(value); }
}
