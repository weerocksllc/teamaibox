const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function workerFacts(worker) {
  if (!worker || !UUID.test(worker.workerId ?? "") || !UUID.test(worker.nodeId ?? "")
    || !UUID.test(worker.controlLeaseId ?? "") || !UUID.test(worker.modelProfileId ?? "")
    || !Number.isSafeInteger(worker.controlFencingToken) || worker.controlFencingToken < 1
    || !Number.isSafeInteger(worker.generation) || worker.generation < 1
    || worker.lifecycleState !== "ready" || worker.health?.state !== "healthy") {
    throw new TypeError("only a healthy ready scheduler worker can register plugin capabilities");
  }
  return Object.freeze({ workerId: worker.workerId, nodeId: worker.nodeId, leaseId: worker.controlLeaseId,
    fencingToken: worker.controlFencingToken, workerGeneration: worker.generation,
    routingEnvironment: worker.routingEnvironment ?? "production",
    experimentalProfileIds: Object.freeze([...(worker.experimentalProfileIds ?? [])]) });
}

export class SchedulerPluginCapabilityRegistrar {
  #service;
  #authority;
  constructor({ registrationService, schedulerAuthority }) {
    if (!registrationService || ["register", "listForScheduler", "retireWorker"].some((method) => typeof registrationService[method] !== "function")
      || !schedulerAuthority?.issue) throw new TypeError("scheduler plugin registrar dependencies are incomplete");
    this.#service = registrationService; this.#authority = schedulerAuthority;
  }

  async registerReadyWorker({ pluginId, worker, operations }) {
    const facts = workerFacts(worker);
    if (typeof pluginId !== "string" || !/^[a-z][a-z0-9.-]{2,127}$/.test(pluginId)
      || !Array.isArray(operations) || operations.length < 1) throw new TypeError("plugin capability claim is invalid");
    return this.#service.register({ authority: this.#authority.issue(facts), pluginId,
      claims: [{ modelProfileId: worker.modelProfileId, operations: [...operations].sort() }] });
  }

  async available() {
    const sentinel = Object.freeze({ workerId: "00000000-0000-4000-8000-000000000001", nodeId: "00000000-0000-4000-8000-000000000002",
      leaseId: "00000000-0000-4000-8000-000000000003", fencingToken: 1, workerGeneration: 1 });
    return this.#service.listForScheduler({ authority: this.#authority.issue(sentinel) });
  }

  async retireWorker({ workerId, workerGeneration, worker }) {
    const facts = worker ? workerFacts(worker) : null;
    if (!facts || facts.workerId !== workerId || facts.workerGeneration !== workerGeneration) {
      throw new TypeError("scheduler retirement authority does not match the worker");
    }
    return this.#service.retireWorker({ authority: this.#authority.issue(facts), workerId, workerGeneration });
  }
}
