const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const SCHEDULER_OPERATIONS = new Set(["register-compute-capabilities", "list-compute-capabilities", "retire-compute-capabilities"]);

export class InternalSchedulerPluginAuthority {
  #marker = Symbol("teamaibox.scheduler-plugin-authority");
  #lifecycleMarker = Symbol("teamaibox.lifecycle-plugin-authority");

  issue(facts) {
    if (!facts || !UUID.test(facts.workerId ?? "") || !UUID.test(facts.nodeId ?? "") || !UUID.test(facts.leaseId ?? "")
      || !Number.isSafeInteger(facts.fencingToken) || facts.fencingToken < 1
      || !Number.isSafeInteger(facts.workerGeneration) || facts.workerGeneration < 1) {
      throw new TypeError("scheduler plugin authority facts are invalid");
    }
    return Object.freeze({ marker: this.#marker, facts: Object.freeze(structuredClone(facts)) });
  }

  issuePluginLifecycle(facts) {
    if (!facts || !PLUGIN_ID.test(facts.pluginId ?? "") || !Number.isSafeInteger(facts.pluginGeneration)
      || facts.pluginGeneration < 1) throw new TypeError("plugin lifecycle authority facts are invalid");
    return Object.freeze({ marker: this.#lifecycleMarker, facts: Object.freeze(structuredClone(facts)) });
  }

  async verify(authority, request = null) {
    const operation = request?.operation ?? null;
    const scheduler = authority?.marker === this.#marker;
    const lifecycle = authority?.marker === this.#lifecycleMarker;
    if ((operation === "revoke-plugin-delegations" && (!lifecycle || request.pluginId !== authority.facts.pluginId))
      || (SCHEDULER_OPERATIONS.has(operation) && !scheduler)
      || (operation === null && !scheduler)
      || (!new Set([null, "revoke-plugin-delegations", ...SCHEDULER_OPERATIONS]).has(operation))) {
      throw new Error("scheduler authority rejected");
    }
    return structuredClone(authority.facts);
  }
}
