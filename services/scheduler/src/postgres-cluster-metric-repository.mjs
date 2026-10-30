function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL metric result is invalid");
  return result.rows;
}

function json(value) { return typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function bytes(value) { return Buffer.from(value.slice(7), "hex"); }

function mapped(row) {
  return row ? {
    nodeId: row.node_id,
    nodeGeneration: Number(row.node_generation),
    sequence: Number(row.sequence),
    observedAt: new Date(row.observed_at),
    receivedAt: new Date(row.received_at),
    staleAfterMilliseconds: Number(row.stale_after_milliseconds),
    snapshotDigest: digest(row.snapshot_digest),
    snapshot: json(row.snapshot),
  } : null;
}

function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

export class PostgresClusterMetricRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL database adapter with query and transaction is required");
    this.#database = database;
  }

  async record(value) {
    return this.#database.transaction(async (transaction) => {
      const latest = mapped(rows(await transaction.query(`SELECT * FROM compute.node_metric_snapshots
        WHERE node_id=$1 AND node_generation=$2 ORDER BY sequence DESC LIMIT 1 FOR SHARE`, [value.nodeId, value.nodeGeneration]))[0]);
      if (latest && latest.sequence > value.sequence) conflict("node_metric_sequence_stale", "Node metric sequence is older than the recorded snapshot");
      await transaction.query(`INSERT INTO compute.node_metric_snapshots
        (node_id,node_generation,sequence,observed_at,received_at,stale_after_milliseconds,snapshot_digest,snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (node_id,node_generation,sequence) DO NOTHING`,
      [value.nodeId, value.nodeGeneration, value.sequence, value.observedAt, value.receivedAt,
        value.staleAfterMilliseconds, bytes(value.snapshotDigest), JSON.stringify(value.snapshot)]);
      const stored = mapped(rows(await transaction.query(`SELECT * FROM compute.node_metric_snapshots
        WHERE node_id=$1 AND node_generation=$2 AND sequence=$3 FOR SHARE`, [value.nodeId, value.nodeGeneration, value.sequence]))[0]);
      if (!stored || stored.snapshotDigest !== value.snapshotDigest) conflict("node_metric_sequence_conflict", "Node metric sequence already has different facts");
      return stored;
    });
  }

  async latestForNode(nodeId) {
    return mapped(rows(await this.#database.query(`SELECT * FROM compute.node_metric_snapshots
      WHERE node_id=$1 ORDER BY node_generation DESC,sequence DESC LIMIT 1`, [nodeId]))[0]);
  }

  async listLatest() {
    return rows(await this.#database.query(`WITH RECURSIVE node_keys AS (
      (SELECT node_id FROM compute.node_metric_snapshots ORDER BY node_id LIMIT 1)
      UNION ALL
      SELECT next_node.node_id FROM node_keys previous CROSS JOIN LATERAL (
        SELECT node_id FROM compute.node_metric_snapshots WHERE node_id > previous.node_id ORDER BY node_id LIMIT 1
      ) next_node
    ) SELECT latest.* FROM node_keys target CROSS JOIN LATERAL (
      SELECT * FROM compute.node_metric_snapshots WHERE node_id=target.node_id
      ORDER BY node_generation DESC,sequence DESC LIMIT 1
    ) latest ORDER BY target.node_id`)).map(mapped);
  }
}
