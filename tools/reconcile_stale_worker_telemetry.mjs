import { createManagedNodeRuntimeFromEnvironment } from "/opt/teamaibox/apps/platform-api/server/managed-node-runtime.mjs";
import { createPostgresDatabaseFromEnvironment } from "/opt/teamaibox/packages/persistence/src/postgres-database.mjs";
import { ManagedNodeWorkerControlTransport } from "/opt/teamaibox/services/scheduler/src/managed-node-worker-control-transport.mjs";
import { PostgresWorkerEventSink } from "/opt/teamaibox/services/scheduler/src/postgres-worker-event-sink.mjs";
import { PostgresWorkerRepository } from "/opt/teamaibox/services/scheduler/src/postgres-worker-repository.mjs";
import { WorkerLifecycleManager } from "/opt/teamaibox/services/scheduler/src/worker-lifecycle-manager.mjs";

const workerIds = (process.env.TEAMAIBOX_RECONCILE_WORKER_IDS ?? "").split(",").filter(Boolean);
const correlationId = process.env.TEAMAIBOX_RECONCILE_CORRELATION_ID;
if (!workerIds.length || !workerIds.every((value) => /^[0-9a-f-]{36}$/.test(value))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(correlationId ?? "")) process.exit(2);

const database = await createPostgresDatabaseFromEnvironment(process.env);
let runtime = null;
try {
  await database.ready();
  runtime = await createManagedNodeRuntimeFromEnvironment(process.env, { database, audit: async () => {} });
  const workers = new PostgresWorkerRepository({ database });
  const manager = new WorkerLifecycleManager({
    repository: workers,
    nodeAgent: runtime.nodeAgentRouter,
    workerControl: new ManagedNodeWorkerControlTransport({ workerRepository: workers, nodeAgentRouter: runtime.nodeAgentRouter }),
    eventSink: new PostgresWorkerEventSink({ database }),
  });
  const results = [];
  for (const workerId of workerIds) {
    const current = await workers.get(workerId);
    if (current.activeAttemptIds.length || Object.keys(current.attemptBindings ?? {}).length) {
      throw new Error(`worker ${workerId} has active authority`);
    }
    if (current.lifecycleState === "ready" && current.health.state === "healthy") {
      await manager.recordCrash({ workerId, reasonCode: "worker_telemetry_missing", correlationId, now: new Date() });
    }
    const stopped = await manager.unload({ workerId, correlationId, reason: "telemetry_reconciliation", now: new Date() });
    results.push({ workerId, state: stopped.lifecycleState, health: stopped.health.state,
      activeAttemptCount: stopped.activeAttemptIds.length, bindingCount: Object.keys(stopped.attemptBindings ?? {}).length });
  }
  process.stdout.write(`${JSON.stringify({ status: "reconciled", results })}\n`);
} finally {
  runtime?.close();
  await database.close();
}
