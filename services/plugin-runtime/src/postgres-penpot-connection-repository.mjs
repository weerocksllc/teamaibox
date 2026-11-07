/** One explicit browser target per identity, not an execution queue. A stale
 * tab cannot heartbeat, disconnect or replace a newer generation. */
export class PostgresPenpotConnectionRepository {
  #database;
  constructor({ database }) {
    if (!database?.query) throw new TypeError('PostgreSQL is required');
    this.#database = database;
  }
  async select({ identityId, expectedGeneration, binding, now }) {
    if (expectedGeneration === 0) {
      const { rows } = await this.#database.query(`INSERT INTO design.editor_connections
      (identity_id,generation,binding,heartbeat_at,disconnected_at)
      SELECT $1,1,$3,$4,NULL WHERE $2=0
      ON CONFLICT (identity_id) DO UPDATE SET generation=design.editor_connections.generation+1,
        binding=$3,heartbeat_at=$4,disconnected_at=NULL
      WHERE design.editor_connections.generation=$2
      RETURNING generation`, [identityId, expectedGeneration, binding, new Date(now)]);
      return rows[0] ? Number(rows[0].generation) : null;
    }
    const result = await this.#database.query(`UPDATE design.editor_connections
      SET generation=generation+1,binding=$3,heartbeat_at=$4,disconnected_at=NULL
      WHERE identity_id=$1 AND generation=$2 RETURNING generation`,
    [identityId, expectedGeneration, binding, new Date(now)]);
    return result.rows[0] ? Number(result.rows[0].generation) : null;
  }
  async get(identityId) {
    const { rows } = await this.#database.query(`SELECT generation,binding,heartbeat_at,disconnected_at
      FROM design.editor_connections WHERE identity_id=$1`, [identityId]);
    const row = rows[0];
    return row ? { ...row.binding, generation: Number(row.generation),
      heartbeatAt: new Date(row.heartbeat_at).getTime(), disconnected: Boolean(row.disconnected_at) } : null;
  }
  async heartbeat({ identityId, platformSessionId, connectionId, generation, now }) {
    const result = await this.#database.query(`UPDATE design.editor_connections SET heartbeat_at=$5
      WHERE identity_id=$1 AND binding->>'platformSessionId'=$2 AND binding->>'connectionId'=$3
        AND generation=$4 AND disconnected_at IS NULL
        AND heartbeat_at>$5::timestamptz-interval '12 seconds' AND heartbeat_at<=$5`,
    [identityId, platformSessionId, connectionId, generation, new Date(now)]);
    return result.rowCount === 1;
  }
  async disconnect({ identityId, platformSessionId, connectionId, generation, now }) {
    const result = await this.#database.query(`UPDATE design.editor_connections SET disconnected_at=$5
      WHERE identity_id=$1 AND binding->>'platformSessionId'=$2 AND binding->>'connectionId'=$3 AND generation=$4`,
    [identityId, platformSessionId, connectionId, generation, new Date(now)]);
    return result.rowCount === 1;
  }
}
