import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Persists content-safe Worker lifecycle facts in the operational timeline. */
export class PostgresWorkerEventSink {
  #database;
  constructor({ database }) {
    if (typeof database?.query !== "function") throw new TypeError("PostgreSQL worker event sink requires a query adapter");
    this.#database = database;
  }

  async publish(event) {
    if (!event || !UUID.test(event.workerId ?? "") || !UUID.test(event.nodeId ?? "")
        || typeof event.type !== "string" || !/^worker\.[a-z0-9_.-]{2,120}$/.test(event.type)
        || typeof event.correlationId !== "string") throw new TypeError("worker lifecycle event is invalid");
    const jobId = UUID.test(event.payload?.jobId ?? "") ? event.payload.jobId : null;
    const attemptId = UUID.test(event.payload?.attemptId ?? "") ? event.payload.attemptId : null;
    const severity = /(failed|crashed|circuit)/.test(event.type) ? "error" : "info";
    await this.#database.query(`INSERT INTO platform.diagnostic_signals
      (id,signal_kind,correlation_id,producer_kind,producer_key,event_key,severity,observed_at,data,facts,job_ids,attempt_ids)
      VALUES ($1,'trace',$2,'worker',$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::uuid[],$10::uuid[])`, [
      randomUUID(), event.correlationId, event.workerId, event.type, severity, event.occurredAt,
      JSON.stringify({ nodeId: event.nodeId, modelProfileId: event.modelProfileId, generation: event.generation }),
      JSON.stringify(event.payload ?? {}), jobId ? [jobId] : [], attemptId ? [attemptId] : [],
    ]);
  }
}
