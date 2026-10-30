import { randomUUID } from "node:crypto";
import { failPhone, identifier, validateGrant } from "./contracts.mjs";

const ACTIVE = "('issued','connected','revoking')";
const first = result => result.rows[0] ?? null;
// Tokens are never returned from persistence; only their SHA-256 is stored.
const grant = r => r && ({ id:r.id, phoneId:r.phone_id, ownerId:r.owner_id, runId:r.run_id,
  generation:Number(r.generation), sessionId:r.session_id, kind:r.kind, state:r.state,
  createdAt:r.created_at, expiresAt:r.expires_at, consumedAt:r.consumed_at });
const liveLogin = `SELECT s.id FROM iam.sessions s JOIN iam.identities i ON i.id=s.identity_id
  WHERE s.id=$1 AND s.identity_id=$2 AND s.revoked_at IS NULL
  AND least(s.idle_expires_at,s.expires_at)>clock_timestamp()
  AND i.status='active' AND i.identity_kind='local_user' AND s.password_version=i.password_version
  FOR SHARE OF s,i`;

/** One connection per phone. Revoking remains occupied until the media runtime
 * confirms the exact peer is closed; a lost reply cannot permit a second peer.
 */
export class PostgresPhoneAccessRepository {
  #database;
  constructor({database}) {
    if (!database?.query || !database?.transaction) throw new TypeError("Phone access requires PostgreSQL");
    this.#database=database;
  }
  async #phone(db, ownerId, phoneId, {running=false}={}) {
    const p=first(await db.query(`SELECT * FROM platform.phones WHERE id=$1 AND owner_id=$2
      AND state<>'deleted' FOR UPDATE`,[identifier(phoneId),identifier(ownerId)]));
    if (!p) failPhone("phone_not_found");
    if (running && p.state!=="running") failPhone("phone_state_conflict");
    return p;
  }
  async #session(db,ownerId,sessionId) {
    if (!first(await db.query(liveLogin,[identifier(sessionId),identifier(ownerId)]))) failPhone("phone_grant_invalid");
  }
  async assertLogin({ownerId,sessionId}) {
    return this.#database.transaction(db=>this.#session(db,ownerId,sessionId));
  }
  async issue({ownerId,phoneId,sessionId,kind,ttlSeconds,tokenHash}) {
    const spec=validateGrant({kind,ttlSeconds});
    if (!Buffer.isBuffer(tokenHash)||tokenHash.length!==32) failPhone("phone_input_invalid");
    return this.#database.transaction(async db=>{
      await this.#session(db,ownerId,sessionId);
      const p=await this.#phone(db,ownerId,phoneId,{running:true});
      const run=first(await db.query(`SELECT id,generation FROM platform.phone_runs WHERE phone_id=$1
        AND owner_id=$2 AND generation=$3 AND state='running' FOR SHARE`,[phoneId,ownerId,p.generation]));
      if (!run) failPhone("phone_runtime_unavailable");
      // Refresh must first revoke the old control peer, including expired
      // connection tickets. ADB grants are also bounded to one per phone.
      if (first(await db.query(`SELECT id FROM platform.phone_access_grants WHERE phone_id=$1 AND kind=$2
        AND state IN ${ACTIVE}`,[phoneId,kind]))) failPhone(kind==="control"?"phone_connection_in_use":"phone_operation_conflict");
      return grant(first(await db.query(`INSERT INTO platform.phone_access_grants
        (id,phone_id,owner_id,run_id,generation,session_id,kind,token_hash,state,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'issued',statement_timestamp(),
          statement_timestamp()+$9*interval '1 second') RETURNING *`,
      [randomUUID(),phoneId,ownerId,run.id,run.generation,sessionId,kind,tokenHash,spec.ttlSeconds])));
    });
  }
  async consume({ownerId,phoneId,sessionId,grantId,tokenHash,kind}) {
    validateGrant({kind});identifier(grantId);
    if (!Buffer.isBuffer(tokenHash)||tokenHash.length!==32) failPhone("phone_grant_invalid");
    return this.#database.transaction(async db=>{
      await this.#session(db,ownerId,sessionId);
      const p=await this.#phone(db,ownerId,phoneId,{running:true});
      const row=first(await db.query(`UPDATE platform.phone_access_grants g SET state='connected',consumed_at=clock_timestamp()
        WHERE g.id=$1 AND g.phone_id=$2 AND g.owner_id=$3 AND g.session_id=$4 AND g.kind=$5 AND g.token_hash=$6
        AND g.generation=$7 AND g.state='issued' AND g.expires_at>clock_timestamp()
        AND g.created_at+interval '60 seconds'>clock_timestamp()
        AND EXISTS(SELECT 1 FROM platform.phone_runs r WHERE r.id=g.run_id AND r.state='running') RETURNING g.*`,
      [grantId,phoneId,ownerId,sessionId,kind,tokenHash,p.generation]));
      if (!row) failPhone("phone_grant_invalid");
      return grant(row);
    });
  }
  async beginRevocation({ownerId,phoneId,sessionId=null,kind=null,grantId=null}) {
    if (sessionId) identifier(sessionId);if (grantId) identifier(grantId);if (kind) validateGrant({kind});
    return this.#database.transaction(async db=>{
      await this.#phone(db,ownerId,phoneId);
      return (await db.query(`UPDATE platform.phone_access_grants SET state='revoking'
        WHERE phone_id=$1 AND owner_id=$2 AND state IN ${ACTIVE}
        AND ($3::uuid IS NULL OR session_id=$3) AND ($4::text IS NULL OR kind=$4)
        AND ($5::uuid IS NULL OR id=$5) RETURNING *`,[phoneId,ownerId,sessionId,kind,grantId])).rows.map(grant);
    });
  }
  async confirmRevoked(expected) {
    const result=first(await this.#database.query(`UPDATE platform.phone_access_grants SET state='revoked',ended_at=clock_timestamp()
      WHERE id=$1 AND phone_id=$2 AND owner_id=$3 AND run_id=$4 AND generation=$5 AND state='revoking' RETURNING *`,
    [expected.id,expected.phoneId,expected.ownerId,expected.runId,expected.generation]));
    if (!result) {
      const existing=first(await this.#database.query(`SELECT * FROM platform.phone_access_grants WHERE id=$1 AND phone_id=$2
        AND owner_id=$3 AND run_id=$4 AND generation=$5 AND state='revoked'`,
      [expected.id,expected.phoneId,expected.ownerId,expected.runId,expected.generation]));
      if (!existing) failPhone("phone_grant_invalid");return grant(existing);
    }
    return grant(result);
  }
  async #active(grantId=null) {
    // Called by the bounded connection reconciler, not by static asset loads.
    return (await this.#database.query(`SELECT g.*, (i.status='active' AND i.identity_kind='local_user'
      AND s.revoked_at IS NULL AND s.password_version=i.password_version
      AND least(s.idle_expires_at,s.expires_at)>clock_timestamp() AND p.state='running'
      AND p.generation=g.generation AND r.state='running' AND g.state<>'revoking'
      AND (g.state='connected' AND g.kind='control' OR g.expires_at>clock_timestamp())) AS authorized
      FROM platform.phone_access_grants g JOIN iam.sessions s ON s.id=g.session_id
      JOIN iam.identities i ON i.id=g.owner_id JOIN platform.phones p ON p.id=g.phone_id
      JOIN platform.phone_runs r ON r.id=g.run_id WHERE g.state IN ${ACTIVE}
      ${grantId ? "AND g.id=$1" : ""}`,grantId?[identifier(grantId)]:[])).rows
      .map(r=>({...grant(r),authorized:r.authorized===true}));
  }
  active() {return this.#active();}
  async getActive(grantId) {return (await this.#active(identifier(grantId)))[0]??null;}
}
