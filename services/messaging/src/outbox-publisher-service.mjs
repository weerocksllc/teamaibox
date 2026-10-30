import { createHash } from "node:crypto";


function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL outbox result is invalid");
  return result.rows;
}


function json(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}


export class OutboxPublisherService {
  #database;
  #jetstream;
  #publisher;
  #timer = null;
  #running = false;
  #lastPublishedAt = null;
  #lastFailureAt = null;

  constructor({ database, jetstream, publisher = "messaging-outbox-01" }) {
    if (!database?.query || !jetstream?.ensureStream || !jetstream?.publish || !jetstream?.streamInfo
      || typeof publisher !== "string" || !/^[a-z][a-z0-9._-]{2,127}$/.test(publisher)) {
      throw new TypeError("outbox publisher dependencies are incomplete");
    }
    this.#database = database;
    this.#jetstream = jetstream;
    this.#publisher = publisher;
  }

  async start() {
    if (this.#running) return;
    await this.#jetstream.ensureStream();
    this.#running = true;
    const poll = async () => {
      if (!this.#running) return;
      try { await this.drainOnce(); } catch { this.#lastFailureAt = new Date(); }
      if (this.#running) this.#timer = setTimeout(poll, 100);
    };
    await poll();
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async drainOnce(limit = 100) {
    const events = rows(await this.#database.query(
      "SELECT * FROM platform.claim_outbox($1,$2,30)",
      [this.#publisher, limit],
    ));
    let published = 0;
    for (const event of events) {
      try {
        const envelope = {
          schemaVersion: Number(event.schema_version), eventId: event.event_id,
          eventType: event.event_type, aggregate: {
            type: event.aggregate_type, id: event.aggregate_id, version: Number(event.aggregate_version),
          },
          payload: json(event.payload), headers: json(event.headers),
          occurredAt: new Date(event.occurred_at).toISOString(),
        };
        const acknowledgement = await this.#jetstream.publish(event.subject, envelope);
        const marked = rows(await this.#database.query(
          "SELECT platform.mark_outbox_published($1,$2,$3,$4) AS marked",
          [event.event_id, event.claim_token, acknowledgement.stream, acknowledgement.sequence],
        ))[0];
        if (marked?.marked !== true) throw new Error("outbox publication fence changed");
        published += 1;
        this.#lastPublishedAt = new Date();
      } catch (error) {
        const errorDigest = createHash("sha256").update(String(error?.message ?? "publish_failed")).digest("hex");
        await this.#database.query(
          "SELECT platform.release_outbox_claim($1,$2,$3,1)",
          [event.event_id, event.claim_token, `publish_failed:${errorDigest}`],
        );
        this.#lastFailureAt = new Date();
      }
    }
    return { claimed: events.length, published };
  }

  async health() {
    const stream = await this.#jetstream.streamInfo();
    const pending = rows(await this.#database.query(
      "SELECT count(*)::bigint AS count FROM platform.outbox_events WHERE published_at IS NULL",
    ))[0];
    return {
      ready: this.#running,
      stream: stream.config?.name,
      messages: Number(stream.state?.messages ?? 0),
      pending: Number(pending.count),
      lastPublishedAt: this.#lastPublishedAt?.toISOString() ?? null,
      lastFailureAt: this.#lastFailureAt?.toISOString() ?? null,
    };
  }
}
