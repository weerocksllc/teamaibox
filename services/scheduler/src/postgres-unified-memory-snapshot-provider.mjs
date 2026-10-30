import { PostgresClusterMetricRepository } from "./postgres-cluster-metric-repository.mjs";
import { UnifiedMemoryGuard } from "./unified-memory-guard.mjs";

const ACTIVE_WORKER_STATES = Object.freeze([
  "starting", "preparing", "ready", "busy", "draining", "stopping",
]);

function instant(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return result;
}

function environmentInteger(environment, name, fallback, minimum, maximum) {
  const raw = environment?.[name];
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside its supported range`);
  }
  return value;
}

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL unified-memory result is invalid");
  return result.rows;
}

function bytes(value, fallback = 0) {
  const resolved = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(resolved) && resolved >= 0 ? resolved : fallback;
}

function unavailableEngine() {
  return Object.freeze({ status: "unavailable" });
}

function unavailableRuntime() {
  return Object.freeze({ status: "unavailable", oomKilled: false });
}

function engine(value) {
  if (value?.status !== "measured") return unavailableEngine();
  return Object.freeze({
    status: "measured",
    allocatedBytes: bytes(value.allocatedBytes),
    modelBytes: bytes(value.modelBytes),
    cacheBytes: bytes(value.cacheBytes),
    certifiedEnvelopeBytes: bytes(value.certifiedEnvelopeBytes),
  });
}

function runtime(value) {
  if (value?.status !== "measured" || typeof value.oomKilled !== "boolean") return unavailableRuntime();
  return Object.freeze({ status: "measured", oomKilled: value.oomKilled });
}

function cgroup(value) {
  if (!value || typeof value !== "object") return null;
  return Object.freeze({
    currentBytes: bytes(value.currentBytes),
    ...(Number.isSafeInteger(value.inactiveFileBytes) && value.inactiveFileBytes >= 0
      && value.inactiveFileBytes <= value.currentBytes ? { inactiveFileBytes: value.inactiveFileBytes } : {}),
    maximumBytes: value.maximumBytes === "max" ? "max" : bytes(value.maximumBytes),
    events: Object.freeze(Object.fromEntries(
      ["high", "max", "oom", "oomKill", "oomGroupKill"].map((key) => [key, bytes(value.events?.[key])]),
    )),
  });
}

function process(value) {
  return value && Number.isSafeInteger(value.residentBytes) && value.residentBytes >= 0
    ? Object.freeze({ residentBytes: value.residentBytes }) : null;
}

function failedClosedSnapshot({ nodeId, observedAt }) {
  return Object.freeze({
    nodeId,
    observedAt,
    host: Object.freeze({
      observedAt: new Date(0), totalBytes: 1, availableBytes: 0, pressure: Object.freeze({}),
    }),
    driver: Object.freeze({
      dedicatedMemory: Object.freeze({ status: "unsupported", reasonCode: "unified_memory_architecture" }),
    }),
    workers: Object.freeze([]),
    workload: Object.freeze({ coldLoad: true }),
  });
}

export function unifiedMemoryPolicyFromEnvironment(environment = process.env) {
  return Object.freeze({
    maximumEvidenceAgeMilliseconds: environmentInteger(environment,
      "PLATFORM_UNIFIED_MEMORY_MAXIMUM_EVIDENCE_AGE_MILLISECONDS", 15_000, 1_000, 300_000),
  });
}

export class PostgresUnifiedMemorySnapshotProvider {
  #database;
  #metrics;
  #clock;

  constructor({ database, metricRepository = null, clock = () => new Date() }) {
    if (!database?.query || !database?.transaction || typeof clock !== "function") {
      throw new TypeError("PostgreSQL unified-memory snapshot dependencies are invalid");
    }
    this.#database = database;
    this.#metrics = metricRepository ?? new PostgresClusterMetricRepository({ database });
    if (!this.#metrics?.latestForNode) throw new TypeError("Cluster metric repository is invalid");
    this.#clock = clock;
  }

  async snapshot({ nodeId, modelProfileId = null, observedAt = this.#clock(), includeAuthenticatedWorkers = true }) {
    if (typeof nodeId !== "string" || nodeId.length === 0) throw new TypeError("nodeId is required");
    const at = instant(observedAt, "observedAt");
    const [record, nodeWorkersResult] = await Promise.all([
      this.#metrics.latestForNode(nodeId),
      this.#database.query(`
        SELECT node.generation AS node_generation, node.lifecycle_state AS node_lifecycle_state,
               worker.id AS worker_id, worker.node_generation AS worker_node_generation,
               worker.model_profile_id,
               worker.lifecycle_state AS worker_lifecycle_state,
               cardinality(worker.active_attempt_ids) AS active_attempt_count
        FROM compute.nodes node
        LEFT JOIN compute.worker_instances worker
          ON worker.node_id=node.id AND worker.node_generation=node.generation
          AND worker.lifecycle_state = ANY($2::text[])
        WHERE node.id=$1
        ORDER BY worker.id`, [nodeId, ACTIVE_WORKER_STATES]),
    ]);
    const nodeWorkers = rows(nodeWorkersResult);
    const node = nodeWorkers[0];
    if (!record || !node || !new Set(["ready", "draining"]).has(node.node_lifecycle_state)
        || Number(node.node_generation) !== record.nodeGeneration) {
      return failedClosedSnapshot({ nodeId, observedAt: at });
    }
    const total = record.snapshot?.domains?.unifiedMemory?.totalBytes;
    const available = record.snapshot?.domains?.unifiedMemory?.availableBytes;
    if (total?.status !== "measured" || available?.status !== "measured"
        || !Number.isSafeInteger(total.value) || total.value < 1
        || !Number.isSafeInteger(available.value) || available.value < 0 || available.value > total.value) {
      return failedClosedSnapshot({ nodeId, observedAt: at });
    }
    const metricWorkers = new Map((record.snapshot.workers ?? []).map((value) => [value.workerId, value]));
    const activeWorkers = nodeWorkers.filter((value) => value.worker_id
      && Number(value.worker_node_generation) === Number(value.node_generation));
    if (includeAuthenticatedWorkers) {
      // Protected residents are managed by the protected-office registry, not
      // by job-attempt worker_instances. Account for current Agent-reported
      // containers too; this grants no execution/placement authority.
      const known = new Set(activeWorkers.map(value => value.worker_id));
      for (const metric of metricWorkers.values()) {
        if (known.has(metric.workerId) || typeof metric.workerId !== "string"
          || !ACTIVE_WORKER_STATES.includes(metric.state)) continue;
        activeWorkers.push({ worker_id: metric.workerId, worker_node_generation: record.nodeGeneration,
          worker_lifecycle_state: metric.state, active_attempt_count: metric.state === "busy" ? 1 : 0,
          model_profile_id: null });
        known.add(metric.workerId);
      }
    }
    const workers = activeWorkers.map((value) => {
      const metric = metricWorkers.get(value.worker_id);
      return Object.freeze({
        workerId: value.worker_id,
        observedAt: record.observedAt,
        lifecycleState: value.worker_lifecycle_state,
        activeAttemptCount: bytes(value.active_attempt_count),
        cgroup: cgroup(metric?.cgroup),
        process: process(metric?.process),
        engine: engine(metric?.engine),
        runtime: runtime(metric?.runtime),
      });
    });
    const pressure = record.snapshot.memoryPressure ?? {};
    const hostPressure = Object.freeze({
      ...(pressure.someAverage10?.status === "measured" ? { someAverage10: pressure.someAverage10.value } : {}),
      ...(pressure.fullAverage10?.status === "measured" ? { fullAverage10: pressure.fullAverage10.value } : {}),
    });
    const warm = activeWorkers.some((value) => value.model_profile_id === modelProfileId
      && new Set(["ready", "busy"]).has(value.worker_lifecycle_state));
    return Object.freeze({
      nodeId,
      observedAt: at,
      host: Object.freeze({
        observedAt: record.observedAt,
        totalBytes: total.value,
        availableBytes: available.value,
        pressure: hostPressure,
      }),
      driver: Object.freeze({
        observedAt: record.observedAt,
        dedicatedMemory: Object.freeze({ status: "unsupported", reasonCode: "unified_memory_architecture" }),
      }),
      workers: Object.freeze(workers),
      workload: Object.freeze({ coldLoad: !warm }),
    });
  }
}

export function createPostgresUnifiedMemoryProtection({ database, environment = process.env, clock = () => new Date() }) {
  const memoryPolicy = unifiedMemoryPolicyFromEnvironment(environment);
  return Object.freeze({
    memoryGuard: new UnifiedMemoryGuard({ memoryPolicy }),
    memorySnapshotProvider: new PostgresUnifiedMemorySnapshotProvider({
      database, clock,
    }),
  });
}
