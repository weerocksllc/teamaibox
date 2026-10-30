function copy(value) { return value == null ? null : structuredClone(value); }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }
function withPlacement(value) { return { applianceRole: "appliance-core", desiredState: {}, desiredStateRevision: 1,
  observedStateRevision: 0, maintenanceGeneration: 1, recoveryState: "healthy", recoveryReasonCode: null, ...copy(value) }; }

export class MemoryManagedNodeRepository {
  #nodes = new Map(); #heartbeats = []; #tail = Promise.resolve();
  async #exclusive(operation) { const previous = this.#tail; let release; this.#tail = new Promise((resolve) => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
  async createNode(value) { return this.#exclusive(async () => { if ([...this.#nodes.values()].some((item) => item.nodeKey === value.nodeKey && item.lifecycleState !== "removed")) conflict("managed_node_key_conflict", "Managed node key already exists"); const stored = withPlacement(value); this.#nodes.set(value.nodeId, stored); return copy(stored); }); }
  async findNode(id) { return copy(this.#nodes.get(id) ?? null); }
  async listNodes() { return [...this.#nodes.values()].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey)).map(copy); }
  async updateNode(id, expectedRevision, patch) { return this.#exclusive(async () => { const current = this.#nodes.get(id); if (!current) return null; if (current.revision !== expectedRevision) conflict("managed_node_revision_conflict", "Managed node revision changed"); const next = { ...current, ...copy(patch), nodeId: id, revision: current.revision + 1, createdAt: current.createdAt }; this.#nodes.set(id, next); return copy(next); }); }
  async recordHeartbeat(id, expectedRevision, heartbeat) { return this.#exclusive(async () => { const current = this.#nodes.get(id); if (!current) return null; if (current.revision !== expectedRevision) conflict("managed_node_revision_conflict", "Managed node revision changed"); if (current.generation !== heartbeat.generation) conflict("stale_node_generation", "Managed node generation changed"); const next = { ...current, ...copy(heartbeat.node), nodeId: id, revision: current.revision + 1, createdAt: current.createdAt }; this.#nodes.set(id, next); this.#heartbeats.push({ nodeId: id, generation: next.generation, health: copy(next.health), inventoryDigest: next.inventoryDigest, observedAt: next.lastSeenAt }); return copy(next); }); }
  async awaitFreshHeartbeats({ now, nodeId }) {
    return this.#exclusive(async () => {
      for (const current of this.#nodes.values()) {
        if (current.nodeId !== nodeId || current.trustKind !== "managed_appliance" || !["ready", "joining", "draining"].includes(current.lifecycleState)
            || (current.lastSeenAt && current.lastSeenAt >= now)) continue;
        if (current.lifecycleState === "ready") current.lifecycleState = "joining";
        current.health = { state: "unknown", errorCode: "node_heartbeat_pending", observedAt: now };
        current.revision += 1; current.updatedAt = now;
      }
    });
  }
  async fenceStale({ cutoff, now, nodeId }) { return this.#exclusive(async () => { const fenced = []; for (const current of this.#nodes.values()) if (current.nodeId === nodeId && new Set(["ready", "joining", "draining"]).has(current.lifecycleState) && (current.lastSeenAt ?? current.createdAt) < cutoff) { current.lifecycleState = "offline"; current.generation += 1; current.revision += 1; current.health = { state: "offline", errorCode: "node_heartbeat_stale", observedAt: now }; current.updatedAt = now; fenced.push(copy(current)); } return fenced; }); }
  async heartbeatHistory(id) { return this.#heartbeats.filter((item) => item.nodeId === id).map(copy); }
}
