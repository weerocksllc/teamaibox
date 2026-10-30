const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function intentAuthority(intentId, nodeGeneration) {
  if (!UUID.test(intentId ?? "") || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1) {
    throw new TypeError("exclusive intent authority is invalid");
  }
  return Object.freeze({ leaseId: intentId, fencingToken: 1, nodeGeneration });
}

function leaseAuthority(lease, nodeGeneration) {
  if (!UUID.test(lease?.leaseSetId ?? "") || !Number.isSafeInteger(lease?.fencingToken) || lease.fencingToken < 1
      || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1) throw new TypeError("exclusive lease authority is invalid");
  return Object.freeze({ leaseId: lease.leaseSetId, fencingToken: lease.fencingToken, nodeGeneration });
}

export class NodeAgentExclusiveWorkerDrainer {
  #agent;
  constructor({ nodeAgent }) {
    if (!nodeAgent?.listConflictingWorkers || !nodeAgent?.drainConflictingWorker || !nodeAgent?.restoreConflictingWorker) {
      throw new TypeError("exclusive Node Agent drainer is incomplete");
    }
    this.#agent = nodeAgent;
  }

  listConflictingWorkers({ nodeId, nodeGeneration, exclusiveJobId, intentId, correlationId }) {
    if (!UUID.test(nodeId ?? "") || !UUID.test(exclusiveJobId ?? "")) throw new TypeError("exclusive conflict identity is invalid");
    return this.#agent.listConflictingWorkers({ exclusiveJobId, authority: intentAuthority(intentId, nodeGeneration), correlationId });
  }

  async drainWorker({ workerId, nodeId, nodeGeneration, exclusiveJobId, intentId, correlationId }) {
    if (!UUID.test(nodeId ?? "") || !UUID.test(exclusiveJobId ?? "")) throw new TypeError("exclusive drain identity is invalid");
    const value = await this.#agent.drainConflictingWorker({ exclusiveJobId, targetKey: workerId,
      authority: intentAuthority(intentId, nodeGeneration), correlationId });
    return Object.freeze({ workerId, state: "stopped", leasesReleased: value.leasesReleased === true, wasRunning: value.wasRunning === true });
  }

  async restoreWorker({ workerId, nodeId, nodeGeneration, exclusiveJobId, lease = null, intentId = null, correlationId }) {
    if (!UUID.test(nodeId ?? "") || !UUID.test(exclusiveJobId ?? "")) throw new TypeError("exclusive restore identity is invalid");
    const value = await this.#agent.restoreConflictingWorker({ exclusiveJobId, targetKey: workerId,
      authority: lease ? leaseAuthority(lease, nodeGeneration) : intentAuthority(intentId, nodeGeneration), correlationId });
    return Object.freeze({ workerId, state: value.state, health: value.health ?? "not_configured" });
  }
}
