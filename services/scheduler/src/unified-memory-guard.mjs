import { isProtectedResidentWorker } from "./protected-resident-guard.mjs";

const DEFAULT_POLICY = Object.freeze({
  maximumEvidenceAgeMilliseconds: 15_000,
  warningAvailableRatio: 0.15,
  criticalAvailableRatio: 0.08,
  warningCgroupRatio: 0.85,
  criticalCgroupRatio: 0.95,
  warningPsiSomeAverage10: 0.2,
  criticalPsiFullAverage10: 0.1,
  engineEnvelopeToleranceRatio: 0.05,
  maximumIdleUnloadsPerSweep: 4,
});

function instant(value, name) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date;
}

function nonnegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function ratio(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be between zero and one`);
  }
  return value;
}

function policy(input = {}) {
  const result = { ...DEFAULT_POLICY, ...input };
  for (const key of [
    "maximumEvidenceAgeMilliseconds",
    "maximumIdleUnloadsPerSweep",
  ]) nonnegative(result[key], key);
  for (const key of [
    "warningAvailableRatio", "criticalAvailableRatio", "warningCgroupRatio",
    "criticalCgroupRatio", "warningPsiSomeAverage10", "criticalPsiFullAverage10",
    "engineEnvelopeToleranceRatio",
  ]) ratio(result[key], key);
  if (result.criticalAvailableRatio >= result.warningAvailableRatio) {
    throw new TypeError("critical available ratio must be below warning ratio");
  }
  if (result.warningCgroupRatio >= result.criticalCgroupRatio) {
    throw new TypeError("warning cgroup ratio must be below critical ratio");
  }
  if (result.maximumIdleUnloadsPerSweep < 1 || result.maximumIdleUnloadsPerSweep > 100) {
    throw new TypeError("maximumIdleUnloadsPerSweep must be between 1 and 100");
  }
  return Object.freeze(result);
}

function reason(code, severity, detail = {}) {
  return Object.freeze({ code, severity, ...structuredClone(detail) });
}

function stableWorker(value, index, now, maximumAge) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`workers[${index}] must be an object`);
  }
  if (typeof value.workerId !== "string" || value.workerId.length === 0) {
    throw new TypeError(`workers[${index}].workerId is required`);
  }
  const observedAt = instant(value.observedAt, `workers[${index}].observedAt`);
  const stale = now - observedAt > maximumAge || observedAt - now > 1_000;
  const engineStatus = value.engine?.status ?? (value.engine ? "measured" : "unavailable");
  if (!new Set(["measured", "unavailable"]).has(engineStatus)) {
    throw new TypeError(`workers[${index}].engine.status is invalid`);
  }
  const engine = engineStatus === "measured" ? {
    allocatedBytes: nonnegative(value.engine.allocatedBytes, `workers[${index}].engine.allocatedBytes`),
    modelBytes: nonnegative(value.engine.modelBytes, `workers[${index}].engine.modelBytes`),
    cacheBytes: nonnegative(value.engine.cacheBytes, `workers[${index}].engine.cacheBytes`),
    certifiedEnvelopeBytes: nonnegative(
      value.engine.certifiedEnvelopeBytes,
      `workers[${index}].engine.certifiedEnvelopeBytes`,
    ),
  } : null;
  const runtimeStatus = value.runtime?.status
    ?? (typeof value.runtime?.oomKilled === "boolean" ? "measured" : "unavailable");
  if (!new Set(["measured", "unavailable"]).has(runtimeStatus)
      || (runtimeStatus === "measured" && typeof value.runtime?.oomKilled !== "boolean")) {
    throw new TypeError(`workers[${index}].runtime is invalid`);
  }
  const runtime = Object.freeze({ status: runtimeStatus, oomKilled: value.runtime?.oomKilled === true });
  const cgroup = value.cgroup;
  if (!cgroup || typeof cgroup !== "object" || Array.isArray(cgroup)) {
    return Object.freeze({ workerId: value.workerId, observedAt, stale, cgroup: null,
      process: value.process ?? null, engine, engineStatus, runtime,
      activeAttemptCount: nonnegative(value.activeAttemptCount ?? 0, `workers[${index}].activeAttemptCount`),
      lifecycleState: value.lifecycleState ?? "unknown" });
  }
  const currentBytes = nonnegative(cgroup.currentBytes, `workers[${index}].cgroup.currentBytes`);
  const inactiveFileBytes = nonnegative(cgroup.inactiveFileBytes ?? 0, `workers[${index}].cgroup.inactiveFileBytes`);
  if (inactiveFileBytes > currentBytes) throw new TypeError("inactive file bytes exceed cgroup current bytes");
  const maximumBytes = cgroup.maximumBytes === "max"
    ? "max"
    : nonnegative(cgroup.maximumBytes, `workers[${index}].cgroup.maximumBytes`);
  const events = {};
  for (const key of ["high", "max", "oom", "oomKill", "oomGroupKill"]) {
    events[key] = nonnegative(cgroup.events?.[key] ?? 0, `workers[${index}].cgroup.events.${key}`);
  }
  const process = value.process ? {
    residentBytes: nonnegative(value.process.residentBytes, `workers[${index}].process.residentBytes`),
  } : null;
  return Object.freeze({
    workerId: value.workerId, observedAt, stale,
    cgroup: Object.freeze({ currentBytes, inactiveFileBytes, maximumBytes, events: Object.freeze(events) }),
    process, engine,
    engineStatus,
    runtime,
    activeAttemptCount: nonnegative(value.activeAttemptCount ?? 0, `workers[${index}].activeAttemptCount`),
    lifecycleState: typeof value.lifecycleState === "string" ? value.lifecycleState : "unknown",
  });
}

function uniqueActions(reasons) {
  const codes = new Set(reasons.map((item) => item.code));
  const actions = [];
  if ([...reasons].some((item) => item.severity === "warning" || item.severity === "critical")) {
    actions.push("unload_idle_workers");
  }
  if (codes.has("worker_cgroup_oom") || codes.has("worker_runtime_oom_killed")) {
    actions.push("fence_oom_workers");
  }
  if ([...reasons].some((item) => item.severity === "critical")) actions.push("alert_administrator");
  return Object.freeze(actions);
}

export function evaluateUnifiedMemoryPressure(snapshot, {
  memoryPolicy = {}, eventBaselines = new Map(),
} = {}) {
  const settings = policy(memoryPolicy);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("memory pressure snapshot must be an object");
  }
  const observedAt = instant(snapshot.observedAt, "observedAt");
  const hostObservedAt = instant(snapshot.host?.observedAt, "host.observedAt");
  const hostTotalBytes = nonnegative(snapshot.host?.totalBytes, "host.totalBytes");
  const hostAvailableBytes = nonnegative(snapshot.host?.availableBytes, "host.availableBytes");
  if (hostTotalBytes < 1 || hostAvailableBytes > hostTotalBytes) {
    throw new TypeError("host memory totals are invalid");
  }
  const requestedBytes = nonnegative(snapshot.workload?.requestedBytes ?? 0, "workload.requestedBytes");
  const workload = Object.freeze({
    class: ["batch", "realtime", "exclusive", "observation"].includes(snapshot.workload?.class)
      ? snapshot.workload.class : "batch",
    requestedBytes,
    coldLoad: snapshot.workload?.coldLoad === true,
  });
  const workers = (snapshot.workers ?? []).map((worker, index) =>
    stableWorker(worker, index, observedAt, settings.maximumEvidenceAgeMilliseconds));
  const reasons = [];
  const hostStale = observedAt - hostObservedAt > settings.maximumEvidenceAgeMilliseconds
    || hostObservedAt - observedAt > 1_000;
  if (hostStale) reasons.push(reason("host_memory_evidence_stale", "critical"));
  const driver = snapshot.driver ?? {};
  if (driver.dedicatedMemory?.status !== "unsupported") {
    reasons.push(reason("dedicated_vram_evidence_invalid", "critical"));
  }
  if (workers.some((worker) => worker.stale)) reasons.push(reason("worker_memory_evidence_stale", "critical"));
  if (workers.some((worker) => !worker.cgroup)) reasons.push(reason("worker_cgroup_evidence_missing", "critical"));
  if (workers.some((worker) => worker.runtime.status !== "measured")) reasons.push(reason("worker_runtime_evidence_missing", "critical"));
  if (workers.some((worker) => worker.engineStatus !== "measured")) reasons.push(reason("worker_engine_evidence_unavailable", "warning"));

  const observedCgroupBytes = workers.reduce((total, worker) => total + (worker.cgroup?.currentBytes ?? 0), 0);
  const availableRatio = hostAvailableBytes / hostTotalBytes;
  if (availableRatio <= settings.criticalAvailableRatio) {
    reasons.push(reason("host_available_memory_critical", "critical", { availableRatio }));
  } else if (availableRatio <= settings.warningAvailableRatio) {
    reasons.push(reason("host_available_memory_warning", "warning", { availableRatio }));
  }
  const someAverage10 = snapshot.host?.pressure?.someAverage10;
  const fullAverage10 = snapshot.host?.pressure?.fullAverage10;
  if (typeof fullAverage10 === "number" && fullAverage10 >= settings.criticalPsiFullAverage10) {
    reasons.push(reason("host_memory_psi_critical", "critical", { fullAverage10 }));
  } else if (typeof someAverage10 === "number" && someAverage10 >= settings.warningPsiSomeAverage10) {
    reasons.push(reason("host_memory_psi_warning", "warning", { someAverage10 }));
  }

  const oomWorkerIds = [];
  for (const worker of workers) {
    if (worker.runtime.oomKilled) {
      reasons.push(reason("worker_runtime_oom_killed", "critical", { workerId: worker.workerId }));
      oomWorkerIds.push(worker.workerId);
    }
    if (!worker.cgroup) continue;
    const baseline = eventBaselines.get(worker.workerId) ?? worker.cgroup.events;
    const oomDelta = Math.max(0, worker.cgroup.events.oom - (baseline.oom ?? 0))
      + Math.max(0, worker.cgroup.events.oomKill - (baseline.oomKill ?? 0));
    if (!worker.runtime.oomKilled && oomDelta > 0) {
      reasons.push(reason("worker_cgroup_oom", "critical", { workerId: worker.workerId, eventDelta: oomDelta }));
      oomWorkerIds.push(worker.workerId);
    }
    if (worker.cgroup.maximumBytes !== "max" && worker.cgroup.maximumBytes > 0) {
      // For per-cgroup pressure only, subtract the fresh measured inactive file
      // cache (as Docker's working-set metric does). Missing data subtracts 0.
      const usageRatio = (worker.cgroup.currentBytes - worker.cgroup.inactiveFileBytes) / worker.cgroup.maximumBytes;
      if (usageRatio >= settings.criticalCgroupRatio) {
        reasons.push(reason("worker_cgroup_memory_critical", "critical", { workerId: worker.workerId, usageRatio }));
      } else if (usageRatio >= settings.warningCgroupRatio) {
        reasons.push(reason("worker_cgroup_memory_warning", "warning", { workerId: worker.workerId, usageRatio }));
      }
    }
    if (worker.engine
        && worker.engine.allocatedBytes > worker.engine.certifiedEnvelopeBytes
          * (1 + settings.engineEnvelopeToleranceRatio)) {
      reasons.push(reason("engine_envelope_exceeded", "critical", {
        workerId: worker.workerId,
        allocatedBytes: worker.engine.allocatedBytes,
        certifiedEnvelopeBytes: worker.engine.certifiedEnvelopeBytes,
      }));
    }
    if (worker.process && worker.process.residentBytes > worker.cgroup.currentBytes) {
      reasons.push(reason("process_cgroup_evidence_inconsistent", "warning", { workerId: worker.workerId }));
    }
  }
  const critical = reasons.some((item) => item.severity === "critical");
  const warning = reasons.some((item) => item.severity === "warning");
  const state = critical ? "critical" : warning ? "warning" : "healthy";
  return Object.freeze({
    schemaVersion: 1,
    nodeId: snapshot.nodeId,
    observedAt: observedAt.toISOString(),
    state,
    unifiedMemory: Object.freeze({
      totalBytes: hostTotalBytes,
      availableBytes: hostAvailableBytes,
      observedCgroupBytes,
    }),
    dedicatedVram: Object.freeze({
      status: "unavailable",
      reasonCode: "unified_memory_architecture",
    }),
    evidence: Object.freeze({
      host: Object.freeze({ status: hostStale ? "stale" : "current", observedAt: hostObservedAt.toISOString() }),
      cgroupWorkerCount: workers.filter((worker) => worker.cgroup).length,
      processWorkerCount: workers.filter((worker) => worker.process).length,
      engineWorkerCount: workers.filter((worker) => worker.engine).length,
      driver: Object.freeze({
        status: driver.observedAt ? "current" : "unavailable",
        dedicatedMemoryStatus: "unsupported",
      }),
    }),
    oomWorkerIds: Object.freeze([...new Set(oomWorkerIds)].sort()),
    reasons: Object.freeze(reasons),
    actions: uniqueActions(reasons),
    nextEventBaselines: Object.freeze(Object.fromEntries(
      workers.filter((worker) => worker.cgroup).map((worker) => [
        worker.workerId, Object.freeze(structuredClone(worker.cgroup.events)),
      ]),
    )),
  });
}

export class UnifiedMemoryGuard {
  #policy;
  #eventBaselines = new Map();

  constructor({ memoryPolicy = {} } = {}) {
    this.#policy = policy(memoryPolicy);
  }

  evaluate(snapshot) {
    const decision = evaluateUnifiedMemoryPressure(snapshot, {
      memoryPolicy: this.#policy,
      eventBaselines: this.#eventBaselines,
    });
    this.#eventBaselines = new Map(Object.entries(decision.nextEventBaselines));
    return decision;
  }

}

export class MemoryPressureCoordinator {
  #guard;
  #workerRepository;
  #workerLifecycle;
  #events;
  #policy;

  constructor({ guard, workerRepository, workerLifecycle, eventSink, memoryPolicy = {} }) {
    if (!guard?.evaluate || !workerRepository?.list || !workerLifecycle?.unload
        || !workerLifecycle?.recordCrash || !eventSink?.publish) {
      throw new TypeError("memory pressure coordinator dependencies are incomplete");
    }
    this.#guard = guard;
    this.#workerRepository = workerRepository;
    this.#workerLifecycle = workerLifecycle;
    this.#events = eventSink;
    this.#policy = policy(memoryPolicy);
  }

  async reconcile(snapshot, { correlationId = "scheduler.memory-pressure" } = {}) {
    const decision = this.#guard.evaluate(snapshot);
    let workerInventory = null;
    const workers = async () => {
      workerInventory ??= await this.#workerRepository.list({ states: ["ready", "busy", "failed", "circuit_open"] });
      if (!Array.isArray(workerInventory)) throw new TypeError("memory pressure Worker inventory is invalid");
      return workerInventory;
    };
    const fenced = [];
    for (const workerId of decision.oomWorkerIds) {
      const worker = (await workers()).find((candidate) => candidate?.workerId === workerId);
      if (worker && isProtectedResidentWorker(worker)) continue;
      await this.#workerLifecycle.recordCrash({
        workerId, reasonCode: "worker_memory_oom", correlationId,
        now: new Date(decision.observedAt),
      });
      fenced.push(workerId);
    }
    const unloaded = [];
    if (decision.actions.includes("unload_idle_workers")) {
      const idle = (await workers())
        .filter((worker) => worker.lifecycleState === undefined || worker.lifecycleState === "ready")
        .filter((worker) => !worker.activeAttemptIds?.length && !isProtectedResidentWorker(worker))
        .sort((left, right) =>
          (right.resources?.unifiedMemoryBytes ?? 0) - (left.resources?.unifiedMemoryBytes ?? 0)
          || left.workerId.localeCompare(right.workerId))
        .slice(0, this.#policy.maximumIdleUnloadsPerSweep);
      for (const worker of idle) {
        await this.#workerLifecycle.unload({
          workerId: worker.workerId, correlationId, reason: "memory_pressure",
          now: new Date(decision.observedAt),
        });
        unloaded.push(worker.workerId);
      }
    }
    await this.#events.publish({
      type: "scheduler.unified_memory_pressure",
      nodeId: snapshot.nodeId,
      occurredAt: decision.observedAt,
      correlationId,
      payload: {
        state: decision.state,
        healthy: decision.state !== "critical",
        reasonCodes: decision.reasons.map((item) => item.code),
        fencedWorkerIds: fenced,
        unloadedWorkerIds: unloaded,
      },
    });
    return Object.freeze({ decision, fenced: Object.freeze(fenced), unloaded: Object.freeze(unloaded) });
  }
}

export const defaultUnifiedMemoryPolicy = DEFAULT_POLICY;
