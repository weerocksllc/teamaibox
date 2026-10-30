const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FIELDS = Object.freeze(["workerId", "ownerIdentityId", "sandboxKey", "attemptId", "modelProfileId", "workloadKind",
  "pluginId", "image", "network", "networkPolicyId", "apiScopes", "egressHosts", "limits", "security", "mounts",
  "publishedPorts", "applicationPort", "devices", "environment", "command", "healthCommand"]);
// Full, already-policy-bound WorkerStart payloads use the structured Docker
// health contract and, for LMT4 only, executable tmpfs.  These are runtime
// fields rather than Scheduler routing facts and must survive the projection.
const EXACT_RUNTIME_FIELDS = Object.freeze(["healthCheck", "tmpfsExecutable", "entrypoint"]);
const PROTECTED_FIELDS = Object.freeze(["placementClass", "maintenanceGeneration", "configDigest"]);

/** Projects scheduler-owned worker facts onto the strict Node Agent schema. */
export class NodeAgentWorkerSpecFactory {
  async buildStartPayload({ worker }) {
    const managedComputeWorker = worker?.workloadKind === undefined
      && UUID.test(worker?.attemptId ?? "")
      && UUID.test(worker?.modelProfileId ?? "");
    if (managedComputeWorker) {
      const memoryBytes = Math.max(64 * 1024 ** 2, Math.min(120 * 1024 ** 3,
        Number(worker.resources?.unifiedMemoryBytes ?? 0) || 64 * 1024 ** 2));
      const cpuQuotaMicros = Math.max(1_000, Math.min(2_000_000,
        Math.ceil((Number(worker.resources?.cpuMillis ?? 0) || 10) * 100)));
      const ephemeralBytes = Math.max(1024 ** 2, Math.min(2 * 1024 ** 4,
        Number(worker.resources?.storageBytes ?? 0) || 64 * 1024 ** 2));
      const payload = {
        workerId: worker.workerId,
        attemptId: worker.attemptId,
        modelProfileId: worker.modelProfileId,
        workloadKind: "compute-worker",
        image: worker.image,
        network: "compute-internal",
        limits: Object.freeze({ memoryBytes, cpuQuotaMicros, pidsLimit: 256,
          ephemeralBytes, openFilesLimit: 4096 }),
        security: Object.freeze({ runAsUid: 65532, runAsGid: 65532, readOnlyRoot: true,
          dropAllCapabilities: true, noNewPrivileges: true, privileged: false,
          hostPid: false, hostIpc: false, hostNetwork: false, dockerSocket: false }),
        mounts: Object.freeze([]),
        publishedPorts: Object.freeze([]),
        devices: Object.freeze(Number(worker.resources?.acceleratorUnits ?? 0) > 0
          ? ["nvidia.com/gpu=all"] : []),
        environment: Object.freeze({ TEAMAIBOX_MODEL_PROFILE_ID: worker.modelProfileId }),
        command: Object.freeze([]),
        healthCommand: Object.freeze([]),
      };
      for (const field of PROTECTED_FIELDS) if (worker[field] !== undefined) payload[field] = structuredClone(worker[field]);
      return Object.freeze(payload);
    }
    const pluginWorkload = worker?.workloadKind === "application-plugin" || worker?.workloadKind === "compute-plugin";
    const agentWorkload = worker?.workloadKind === "agent-sandbox";
    const emptyNonModelIdentity = worker?.attemptId === "" && worker?.modelProfileId === "";
    if (!worker || typeof worker !== "object" || !UUID.test(worker.workerId ?? "")
        || ((pluginWorkload || agentWorkload) ? !emptyNonModelIdentity
          : (!UUID.test(worker.attemptId ?? "") || !UUID.test(worker.modelProfileId ?? "")))) {
      throw new TypeError("Node Agent worker identity is invalid");
    }
    const payload = {};
    for (const field of FIELDS) if (worker[field] !== undefined) payload[field] = structuredClone(worker[field]);
    for (const field of EXACT_RUNTIME_FIELDS) {
      if (worker[field] === undefined) continue;
      const value = structuredClone(worker[field]);
      payload[field] = field === "entrypoint" ? Object.freeze(value) : value;
    }
    for (const field of PROTECTED_FIELDS) if (worker[field] !== undefined) payload[field] = structuredClone(worker[field]);
    return Object.freeze(payload);
  }
}
