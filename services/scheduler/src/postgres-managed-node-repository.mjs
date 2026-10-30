const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function rows(value) { if (!value || !Array.isArray(value.rows)) throw new TypeError("PostgreSQL managed node result is invalid"); return value.rows; }
function json(value) { return value == null ? null : typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
function date(value) { return value == null ? null : new Date(value); }
function digest(value) { return value == null ? null : `sha256:${Buffer.from(value).toString("hex")}`; }
function bytes(value) { return value == null ? null : Buffer.from(value.slice(7), "hex"); }
function conflict(code, message) { const error = new Error(message); error.code = code; throw error; }

function node(row) { return row ? { nodeId: row.id, nodeKey: row.node_key, architecture: row.architecture, trustKind: row.trust_kind, lifecycleState: row.lifecycle_state,
  generation: Number(row.generation), agentVersion: row.agent_version, labels: json(row.labels), capacity: json(row.capacity), health: json(row.health), inventory: json(row.inventory), inventoryDigest: digest(row.inventory_digest),
  applianceRole: row.appliance_role ?? "appliance-core", desiredState: json(row.desired_state ?? {}),
  desiredStateRevision: Number(row.desired_state_revision ?? 1), observedStateRevision: Number(row.observed_state_revision ?? 0),
  bootstrapAdmissionRequired: row.bootstrap_admission_required ?? false,
  maintenanceGeneration: Number(row.maintenance_generation ?? 1), recoveryState: row.recovery_state ?? "healthy", recoveryReasonCode: row.recovery_reason_code ?? null,
  lastSeenAt: date(row.last_seen_at), certificateFingerprint: digest(row.certificate_fingerprint), certificateNotAfter: date(row.certificate_not_after), certificateRevokedAt: date(row.certificate_revoked_at),
  revision: Number(row.revision), createdAt: date(row.created_at), updatedAt: date(row.updated_at) } : null; }

function translate(error) { if (error?.code === "23505") conflict("appliance_identity_conflict", "The appliance identity or name is already registered"); throw error; }

export class PostgresManagedNodeRepository {
  #database; #localNodeId;
  constructor({ database, localNodeId }) {
    if (!database?.query || !database?.transaction || !UUID.test(localNodeId ?? "")) throw new TypeError("PostgreSQL appliance repository requires transactions and the local identity");
    this.#database = database; this.#localNodeId = localNodeId;
  }
  #assertLocal(id) { if (id !== this.#localNodeId) conflict("appliance_node_mismatch", "Only this appliance may be read or changed"); }
  async ensureLocalAppliance({ nodeKey, certificateFingerprint, certificateNotAfter, agentVersion }) {
    const expires = new Date(certificateNotAfter);
    if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(nodeKey ?? "") || !SHA256.test(certificateFingerprint ?? "")
        || !Number.isFinite(expires.getTime()) || typeof agentVersion !== "string" || !agentVersion.length || agentVersion.length > 128) {
      throw new TypeError("Installed appliance identity facts are incomplete");
    }
    return this.#database.transaction(async transaction => {
      const inserted = rows(await transaction.query(`INSERT INTO compute.nodes
        (id,node_key,architecture,trust_kind,lifecycle_state,appliance_role,bootstrap_admission_required,
         agent_version,certificate_fingerprint,certificate_not_after)
        VALUES ($1,$2,'arm64','managed_appliance','joining','appliance-core',false,$3,$4,$5)
        ON CONFLICT (id) DO NOTHING RETURNING *`,
      [this.#localNodeId, nodeKey, agentVersion, bytes(certificateFingerprint), expires]))[0];
      const saved = node(inserted ?? rows(await transaction.query("SELECT * FROM compute.nodes WHERE id=$1 FOR UPDATE", [this.#localNodeId]))[0]);
      if (!saved || saved.nodeId !== this.#localNodeId || saved.nodeKey !== nodeKey || saved.trustKind !== "managed_appliance"
          || saved.applianceRole !== "appliance-core" || !["arm64","aarch64"].includes(saved.architecture)
          || saved.lifecycleState === "removed" || saved.certificateFingerprint !== certificateFingerprint
          || saved.certificateNotAfter?.getTime() !== expires.getTime()) {
        conflict("appliance_identity_conflict", "Installed appliance identity differs from its saved record; no record was overwritten");
      }
      return saved;
    }).catch(translate);
  }
  async findNode(id) { this.#assertLocal(id); return node(rows(await this.#database.query("SELECT * FROM compute.nodes WHERE id=$1", [id]))[0]); }
  async listNodes() { return rows(await this.#database.query("SELECT * FROM compute.nodes WHERE id=$1", [this.#localNodeId])).map(node); }
  async #saveLocked(transaction, current, expectedRevision, patch) {
    const id = current.nodeId; this.#assertLocal(id);
    if (current.revision !== expectedRevision) conflict("managed_node_revision_conflict", "Managed node revision changed"); const next = { ...current, ...structuredClone(patch) };
    return node(rows(await transaction.query(`UPDATE compute.nodes SET lifecycle_state=$3,generation=$4,agent_version=$5,labels=$6::jsonb,capacity=$7::jsonb,last_seen_at=$8,
      certificate_fingerprint=$9,certificate_not_after=$10,certificate_revoked_at=$11,health=$12::jsonb,inventory=$13::jsonb,inventory_digest=$14,revision=revision+1,updated_at=$15
      WHERE id=$1 AND revision=$2 RETURNING *`, [id, expectedRevision, next.lifecycleState, next.generation, next.agentVersion, JSON.stringify(next.labels), JSON.stringify(next.capacity ?? current.capacity ?? {}), next.lastSeenAt,
      bytes(next.certificateFingerprint), next.certificateNotAfter, next.certificateRevokedAt, JSON.stringify(next.health), next.inventory == null ? null : JSON.stringify(next.inventory), bytes(next.inventoryDigest), next.updatedAt]))[0]);
  }
  async #update(transaction, id, expectedRevision, patch) {
    const current = node(rows(await transaction.query("SELECT * FROM compute.nodes WHERE id=$1 FOR UPDATE", [id]))[0]); if (!current) return null;
    return this.#saveLocked(transaction, current, expectedRevision, patch);
  }
  async updateNode(id, expectedRevision, patch) { this.#assertLocal(id); return this.#database.transaction((transaction) => this.#update(transaction, id, expectedRevision, patch)); }
  async recordHeartbeat(id, expectedRevision, heartbeat) { this.#assertLocal(id); return this.#database.transaction(async (transaction) => { const current = node(rows(await transaction.query("SELECT * FROM compute.nodes WHERE id=$1 FOR UPDATE", [id]))[0]); if (!current) return null; if (current.generation !== heartbeat.generation) conflict("stale_node_generation", "Managed node generation changed"); const saved = await this.#saveLocked(transaction, current, expectedRevision, heartbeat.node);
    await transaction.query(`INSERT INTO compute.node_heartbeat_events (node_id,node_generation,health_state,inventory_digest,observed_at)
      VALUES ($1,$2,$3,$4,$5)`, [id, heartbeat.generation, heartbeat.node.health.state, bytes(heartbeat.node.inventoryDigest), heartbeat.node.lastSeenAt]);
    return saved; }); }
  async awaitFreshHeartbeats({ now, nodeId = this.#localNodeId }) {
    this.#assertLocal(nodeId);
    await this.#database.query(`UPDATE compute.nodes
      SET lifecycle_state=CASE WHEN lifecycle_state='ready' THEN 'joining' ELSE lifecycle_state END,
          health=jsonb_build_object('state','unknown','errorCode','node_heartbeat_pending','observedAt',$1::timestamptz),
          revision=revision+1,updated_at=$1
      WHERE id=$2 AND trust_kind='managed_appliance' AND lifecycle_state IN ('ready','joining','draining')
        AND (last_seen_at IS NULL OR last_seen_at < $1)`, [now, nodeId]);
  }
  async fenceStale({ cutoff, now, nodeId = this.#localNodeId }) { this.#assertLocal(nodeId); return this.#database.transaction(async (transaction) => rows(await transaction.query(`UPDATE compute.nodes SET lifecycle_state='offline',generation=generation+1,
    health=jsonb_build_object('state','offline','errorCode','node_heartbeat_stale','observedAt',$2::timestamptz),revision=revision+1,updated_at=$2
    WHERE id=$3 AND lifecycle_state IN ('ready','joining','draining') AND COALESCE(last_seen_at,created_at) < $1 RETURNING *`, [cutoff, now, nodeId])).map(node)); }
}
