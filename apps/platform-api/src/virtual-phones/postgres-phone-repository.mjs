import { randomUUID } from "node:crypto";
import { PHONE_POLICY, PHONE_SPEC, failPhone, requestFingerprint, phoneErrorCode } from "./contracts.mjs";
import { LEGACY_PHONE_ROM } from "../../../../services/scheduler/src/phone-rom.mjs";

const first = result => result.rows[0] ?? null;
const rom = row => row && ({ id: row.id, familyId: row.family_id, name: row.display_name,
  version: row.version_label, baseBuildId: row.base_build_id, imageDigest: row.runtime_image_digest,
  googlePlay: row.google_play, experimental: row.experimental, cameraCapability: row.camera_capability,
  createEnabled: row.create_enabled });
const phoneSelect = `SELECT p.*,to_jsonb(v) AS rom FROM platform.phones p
  JOIN platform.phone_rom_versions v ON v.id=p.rom_version_id`;
const phone = row => row && ({ id: row.id, ownerId: row.owner_id, name: row.name, state: row.state,
  revision: Number(row.revision), generation: Number(row.generation), specId: row.spec_id, baseBuildId: row.base_build_id,
  nodeId: row.node_id, poolId: row.pool_id, volumeId: row.volume_id, storageBytes: Number(row.storage_bytes),
  runningCharged: row.running_charged, errorCode: row.error_code, createdAt: row.created_at,
  updatedAt: row.updated_at, deletedAt: row.deleted_at, romVersionId: row.rom_version_id, rom: rom(row.rom) });
const operation = row => row && ({ id: row.id, phoneId: row.phone_id, ownerId: row.owner_id, action: row.action,
  idempotencyKey: row.idempotency_key, fingerprint: row.request_fingerprint, state: row.state,
  generation: Number(row.generation), startAfterCreate: row.start_after_create, errorCode: row.error_code,
  createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at });
const run = row => row && ({ id: row.id, phoneId: row.phone_id, ownerId: row.owner_id, generation: Number(row.generation),
  nodeId: row.node_id, nodeGeneration: Number(row.node_generation), reservationId: row.reservation_id,
  imageDigest: row.image_digest, state: row.state, memoryBytes: Number(row.memory_bytes), cpuMillis: row.cpu_millis,
  containerId: row.container_id, cleanShutdown: row.clean_shutdown, stoppedAt: row.stopped_at });

async function owned(db, ownerId, phoneId, lock = false) {
  const value = phone(first(await db.query(`${phoneSelect} WHERE p.id=$1 AND p.owner_id=$2
    AND p.state<>'deleted'${lock ? " FOR UPDATE OF p" : ""}`, [phoneId, ownerId])));
  if (!value) failPhone("phone_not_found");
  return value;
}
async function existingOperation(db, ownerId, action, key, fingerprint) {
  const value = operation(first(await db.query(`SELECT * FROM platform.phone_operations
    WHERE owner_id=$1 AND action=$2 AND idempotency_key=$3`, [ownerId, action, key])));
  if (value && value.fingerprint !== fingerprint) failPhone("phone_idempotency_conflict");
  return value;
}
async function insertOperation(db, { id, phoneId, ownerId, action, key, fingerprint, generation, startAfterCreate = false }) {
  return operation(first(await db.query(`INSERT INTO platform.phone_operations
    (id,phone_id,owner_id,action,idempotency_key,request_fingerprint,generation,start_after_create)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [id, phoneId, ownerId, action, key, fingerprint, generation, startAfterCreate])));
}
async function openOperation(db, phoneId) {
  return operation(first(await db.query(`SELECT * FROM platform.phone_operations
    WHERE phone_id=$1 AND state IN ('queued','executing')`, [phoneId])));
}

/** Durable control facts. Runtime methods must supply exact, verified results; no public callback accepts them. */
export class PostgresPhoneRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("Phone repository requires PostgreSQL transactions");
    this.#database = database;
  }

  async #ownerTransaction(ownerId, policy, callback, { allowInactive = false } = {}) {
    return this.#database.transaction(async db => {
      const identity = first(await db.query(`SELECT status,identity_kind FROM iam.identities WHERE id=$1 FOR SHARE`, [ownerId]));
      if (!identity || identity.identity_kind !== "local_user" || (!allowInactive && identity.status !== "active")) {
        failPhone("phone_permission_required");
      }
      const inserted = await db.query(`INSERT INTO platform.phone_quotas(owner_id,stored_limit,running_limit) VALUES ($1,$2,$3)
        ON CONFLICT(owner_id) DO NOTHING RETURNING owner_id`, [ownerId, policy.storedPerUser, policy.runningPerUser]);
      const quota = first(await db.query(`SELECT * FROM platform.phone_quotas WHERE owner_id=$1 FOR UPDATE`, [ownerId]));
      return callback(db, { storedPerUser: quota.stored_limit, runningPerUser: quota.running_limit,
        revision: Number(quota.revision), newlyCreated: inserted.rows.length === 1 });
    });
  }

  async list(ownerId) {
    return (await this.#database.query(`${phoneSelect} WHERE p.owner_id=$1 AND p.state<>'deleted'
      ORDER BY p.created_at,p.id`, [ownerId])).rows.map(phone);
  }
  async romCatalog() {
    // Migration-only versions preserve old wrapper identities. They belong on
    // those phones' details, not in the list of systems offered for new phones.
    return (await this.#database.query(`SELECT * FROM platform.phone_rom_versions
      WHERE id NOT LIKE 'aosp-17-runtime-%' ORDER BY family_id,created_at,id`)).rows.map(rom);
  }
  async getRom(id) {
    const value = rom(first(await this.#database.query(`SELECT * FROM platform.phone_rom_versions WHERE id=$1`, [id])));
    if (!value) failPhone("phone_rom_unavailable");
    return value;
  }
  async get(ownerId, phoneId) { return owned(this.#database, ownerId, phoneId); }
  async findRequest(ownerId, action, key, input) {
    return existingOperation(this.#database, ownerId, action, key, requestFingerprint(input));
  }
  async chargedOwners() {
    return (await this.#database.query(`SELECT DISTINCT owner_id FROM platform.phones WHERE running_charged`)).rows.map(row => row.owner_id);
  }
  async getOperation(ownerId, operationId) {
    const value = operation(first(await this.#database.query(`SELECT * FROM platform.phone_operations WHERE id=$1 AND owner_id=$2`,
      [operationId, ownerId])));
    if (!value) failPhone("phone_not_found");
    return value;
  }
  async currentRun(ownerId, phoneId) {
    await this.get(ownerId, phoneId);
    return run(first(await this.#database.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND owner_id=$2
      AND state<>'stopped'`, [phoneId, ownerId])));
  }
  async latestRun(ownerId, phoneId) {
    await this.get(ownerId, phoneId);
    return run(first(await this.#database.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND owner_id=$2
      ORDER BY generation DESC LIMIT 1`, [phoneId, ownerId])));
  }
  async quota(ownerId, policy = PHONE_POLICY) {
    const value = first(await this.#database.query(`SELECT stored_limit,running_limit,revision FROM platform.phone_quotas WHERE owner_id=$1`, [ownerId]));
    const counts = first(await this.#database.query(`SELECT count(*)::integer AS stored,
      count(*) FILTER(WHERE running_charged)::integer AS running FROM platform.phones WHERE owner_id=$1 AND state<>'deleted'`, [ownerId]));
    return { storedPerUser: value ? value.stored_limit : policy.storedPerUser, runningPerUser: value ? value.running_limit : policy.runningPerUser,
      stored: counts.stored, running: counts.running, revision: Number(value?.revision ?? 0) };
  }
  async setQuota(ownerId, quota) {
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async (db, current) => {
      if (quota.expectedRevision !== undefined && quota.expectedRevision !== (current.newlyCreated ? 0 : current.revision)) failPhone("phone_state_conflict");
      await db.query(`UPDATE platform.phone_quotas SET stored_limit=$2,running_limit=$3,revision=revision+1,
        updated_at=clock_timestamp() WHERE owner_id=$1`, [ownerId, quota.storedPerUser, quota.runningPerUser]);
      return { storedPerUser: quota.storedPerUser, runningPerUser: quota.runningPerUser,
        revision: current.revision + 1 }; // Tightening quota never destroys phones or frees reservations.
    }, { allowInactive: true });
  }

  async featurePolicy() {
    const value = first(await this.#database.query(`SELECT enabled,revision FROM platform.phone_feature_policy WHERE singleton`));
    return value ? { enabled: value.enabled, revision: Number(value.revision) } : null;
  }
  async setFeaturePolicy(actorId, { enabled, expectedRevision }) {
    const value = first(await this.#database.query(`INSERT INTO platform.phone_feature_policy(singleton,enabled,updated_by)
      SELECT true,$1,$2 WHERE $3::bigint=0
      ON CONFLICT(singleton) DO NOTHING RETURNING enabled,revision`, [enabled, actorId, expectedRevision]));
    if (value) return { enabled: value.enabled, revision: Number(value.revision) };
    const updated = first(await this.#database.query(`UPDATE platform.phone_feature_policy SET enabled=$1,updated_by=$2,
      revision=revision+1,updated_at=clock_timestamp() WHERE singleton AND revision=$3 RETURNING enabled,revision`,
    [enabled, actorId, expectedRevision]));
    if (!updated) failPhone("phone_state_conflict");
    return { enabled: updated.enabled, revision: Number(updated.revision) };
  }
  async administrationQuotas({ search = "", after = null }, policy = PHONE_POLICY) {
    // Counts and quota facts only: never select phone IDs, labels, data, grants or run targets.
    const literal = search.replace(/[\\%_]/g, value => `\\${value}`);
    const rows = (await this.#database.query(`SELECT i.id,i.login_name,i.display_name,i.status,
      (CASE WHEN q.owner_id IS NULL THEN $1 ELSE q.stored_limit END)::integer AS stored_limit,
      (CASE WHEN q.owner_id IS NULL THEN $2 ELSE q.running_limit END)::integer AS running_limit,
      coalesce(q.revision,0) AS revision,
      (SELECT count(*)::integer FROM platform.phones p WHERE p.owner_id=i.id AND p.state<>'deleted') AS stored,
      (SELECT count(*)::integer FROM platform.phones p WHERE p.owner_id=i.id AND p.running_charged) AS running
      FROM iam.identities i LEFT JOIN platform.phone_quotas q ON q.owner_id=i.id
      WHERE i.identity_kind='local_user' AND ($3::uuid IS NULL OR i.id>$3::uuid)
      AND ($4='' OR i.login_name ILIKE $5 OR i.display_name ILIKE $5)
      ORDER BY i.id LIMIT 51`, [policy.storedPerUser, policy.runningPerUser, after, search, `%${literal}%`])).rows;
    const data = rows.slice(0, 50).map(row => ({ ownerId: row.id, loginName: row.login_name,
      displayName: row.display_name, status: row.status, storedPerUser: row.stored_limit, runningPerUser: row.running_limit,
      revision: Number(row.revision), stored: row.stored, running: row.running }));
    return { object: "list", data, nextCursor: rows.length > 50 ? data.at(-1).ownerId : null };
  }

  async requestCreate({ ownerId, input, key, placement, policy = PHONE_POLICY }) {
    const fingerprint = requestFingerprint(input);
    return this.#ownerTransaction(ownerId, policy, async (db, quota) => {
      const prior = await existingOperation(db, ownerId, "create", key, fingerprint);
      if (prior) return prior;
      const selected = rom(first(await db.query(`SELECT * FROM platform.phone_rom_versions WHERE id=$1 FOR SHARE`, [input.romVersionId ?? LEGACY_PHONE_ROM])));
      if (!selected?.createEnabled) failPhone("phone_rom_unavailable");
      if (placement?.romVersionId !== undefined && (placement.romVersionId !== selected.id || placement.imageDigest !== selected.imageDigest)) failPhone("phone_rom_not_installed");
      const count = first(await db.query(`SELECT count(*)::integer AS n FROM platform.phones WHERE owner_id=$1 AND state<>'deleted'`, [ownerId])).n;
      if (quota.storedPerUser !== null && count >= quota.storedPerUser) failPhone("phone_stored_quota");
      if (!placement?.nodeId || !placement?.poolId) failPhone("phone_storage_unavailable");
      const pool = first(await db.query(`SELECT * FROM objects.storage_pools WHERE pool_id=$1 AND node_id=$2 FOR UPDATE`,
        [placement.poolId, placement.nodeId]));
      if (!pool || pool.encryption_mode !== "luks2" || pool.encryption_status !== "verified"
          || pool.compatibility_status !== "verified" || pool.health_state !== "healthy" || pool.lifecycle_state !== "active") {
        failPhone("phone_storage_unavailable");
      }
      const liveAvailable = placement.storageObservation?.availableBytes;
      if (liveAvailable !== undefined && (!Number.isSafeInteger(liveAvailable) || liveAvailable < 0
          || placement.storageObservation.poolId !== pool.pool_id || placement.storageObservation.nodeId !== placement.nodeId
          || Date.now() - +new Date(placement.storageObservation.observedAt) > 10_000
          || !Number.isFinite(+new Date(placement.storageObservation.observedAt)))) failPhone("phone_storage_unavailable");
      const available = liveAvailable === undefined ? Number(pool.available_bytes) : liveAvailable;
      if (!Number.isSafeInteger(available) || available <= 0) {
        failPhone("phone_storage_full");
      }
      const phoneId = randomUUID();
      await db.query(`INSERT INTO platform.phones(id,owner_id,name,state,spec_id,base_build_id,node_id,pool_id,volume_id,storage_bytes,rom_version_id)
        VALUES ($1,$2,$3,'creating',$4,$5,$6,$7,$8,$9,$10)`, [phoneId, ownerId, input.name, PHONE_SPEC.id, selected.baseBuildId,
        placement.nodeId, placement.poolId, randomUUID(), PHONE_SPEC.storageBytes, selected.id]);
      return insertOperation(db, { id: randomUUID(), phoneId, ownerId, action: "create", key, fingerprint,
        generation: 0, startAfterCreate: input.start });
    });
  }

  async requestAction({ ownerId, phoneId, action, input, key, policy = PHONE_POLICY, allowInactive = false }) {
    const fingerprint = requestFingerprint({ phoneId, ...input });
    return this.#ownerTransaction(ownerId, policy, async (db, quota) => {
      const prior = await existingOperation(db, ownerId, action, key, fingerprint);
      if (prior) return prior;
      const current = await owned(db, ownerId, phoneId, true);
      if (await openOperation(db, phoneId)) failPhone("phone_operation_conflict");
      if (current.revision !== input.expectedRevision) failPhone("phone_state_conflict");
      if (!["start", "stop", "restart", "delete"].includes(action)) failPhone("phone_input_invalid");
      if (action === "delete" && input.confirmDelete !== true) failPhone("phone_input_invalid");
      let state, charged = current.runningCharged, generation = current.generation;
      if (action === "start") {
        if (!["stopped", "error"].includes(current.state) || charged) failPhone("phone_state_conflict");
        const count = first(await db.query(`SELECT count(*)::integer AS n FROM platform.phones WHERE owner_id=$1 AND running_charged`, [ownerId])).n;
        if (quota.runningPerUser !== null && count >= quota.runningPerUser) failPhone("phone_running_quota");
        state = "starting"; charged = true; generation += 1;
      } else if (action === "restart") {
        if (current.state !== "running" || !charged) failPhone("phone_state_conflict");
        state = "stopping"; // A new generation is allocated only after exact old-run stop confirmation.
      } else if (action === "stop") {
        if (!charged || !["running", "error", "unavailable"].includes(current.state)) failPhone("phone_state_conflict");
        state = "stopping";
      } else {
        if (current.state === "creating") failPhone("phone_state_conflict");
        state = "deleting";
      }
      await db.query(`UPDATE platform.phones SET state=$3,running_charged=$4,generation=$5,revision=revision+1,
        error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2`, [phoneId, ownerId, state, charged, generation]);
      return insertOperation(db, { id: randomUUID(), phoneId, ownerId, action, key, fingerprint, generation });
    }, { allowInactive: allowInactive && ["stop", "delete"].includes(action) });
  }

  async rename({ ownerId, phoneId, input }) {
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async db => {
      const value = await owned(db, ownerId, phoneId, true);
      if (await openOperation(db, phoneId)) failPhone("phone_operation_conflict");
      if (value.revision !== input.expectedRevision) failPhone("phone_state_conflict");
      await db.query(`UPDATE platform.phones SET name=$3,revision=revision+1,updated_at=clock_timestamp()
        WHERE id=$1 AND owner_id=$2`, [phoneId, ownerId, input.name]);
      return owned(db, ownerId, phoneId);
    });
  }

  async pendingOperations(limit = 20) {
    return (await this.#database.query(`SELECT * FROM platform.phone_operations WHERE state IN ('queued','executing')
      ORDER BY updated_at,id LIMIT $1`, [Math.min(100, Math.max(1, limit))])).rows.map(operation);
  }
  async recordRemoval(ownerId, phoneId) {
    return first(await this.#database.query('SELECT phone_id FROM platform.phone_record_removals WHERE phone_id=$1 AND owner_id=$2', [phoneId, ownerId]));
  }
  async removeRetiredRecord({ ownerId, phoneId, input, nodeId, poolId }) {
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async db => {
      const prior = first(await db.query('SELECT phone_id FROM platform.phone_record_removals WHERE phone_id=$1 AND owner_id=$2', [phoneId, ownerId]));
      if (prior) return { id: phoneId, recordRemoved: true, dataDeleted: false };
      const value = await owned(db, ownerId, phoneId, true);
      if (await openOperation(db, phoneId)) failPhone('phone_operation_conflict');
      if (value.revision !== input.expectedRevision || value.nodeId !== nodeId || value.poolId !== poolId) failPhone('phone_state_conflict');
      if (value.runningCharged || first(await db.query("SELECT id FROM platform.phone_runs WHERE phone_id=$1 AND state<>'stopped'", [phoneId]))) failPhone('phone_stop_unconfirmed');
      await db.query(`INSERT INTO platform.phone_record_removals(phone_id,owner_id,node_id,pool_id,volume_id)
        VALUES($1,$2,$3,$4,$5)`, [phoneId, ownerId, value.nodeId, value.poolId, value.volumeId]);
      await db.query(`UPDATE platform.phones SET state='deleted',deleted_at=clock_timestamp(),revision=revision+1,
        error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2`, [phoneId, ownerId]);
      return { id: phoneId, recordRemoved: true, dataDeleted: false };
    });
  }
  async markExecuting(ownerId, operationId) {
    const result = operation(first(await this.#database.query(`UPDATE platform.phone_operations SET state='executing',updated_at=clock_timestamp()
      WHERE id=$1 AND owner_id=$2 AND state IN ('queued','executing') RETURNING *`, [operationId, ownerId])));
    if (!result) failPhone("phone_state_conflict");
    return result;
  }
  async bindRun({ ownerId, phoneId, operationId, generation, runId, nodeGeneration, reservationId, imageDigest }) {
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async db => {
      const current = await owned(db, ownerId, phoneId, true), op = await openOperation(db, phoneId);
      if (imageDigest !== current.rom.imageDigest) failPhone("phone_stale_run");
      if (!op || op.id !== operationId || current.generation !== generation || op.generation !== generation
          || current.state !== "starting" || !current.runningCharged) failPhone("phone_stale_run");
      const old = run(first(await db.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND generation=$2`, [phoneId, generation])));
      if (old) {
        if (old.id !== runId || old.reservationId !== reservationId || old.imageDigest !== imageDigest
            || old.nodeGeneration !== nodeGeneration || old.state === "stopped") failPhone("phone_stale_run");
        return old;
      }
      return run(first(await db.query(`INSERT INTO platform.phone_runs
        (id,phone_id,owner_id,generation,node_id,node_generation,reservation_id,image_digest,state,memory_bytes,cpu_millis)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10) RETURNING *`,
      [runId, phoneId, ownerId, generation, current.nodeId, nodeGeneration, reservationId, imageDigest, PHONE_SPEC.memoryBytes, PHONE_SPEC.cpuMillis])));
    });
  }

  async completeOperation({ ownerId, operationId, generation, result }) {
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async (db, quota) => {
      const op = operation(first(await db.query(`SELECT * FROM platform.phone_operations WHERE id=$1 AND owner_id=$2`, [operationId, ownerId])));
      if (!op) failPhone("phone_not_found");
      const current = await owned(db, ownerId, op.phoneId, true);
      if (op.generation !== generation || current.generation !== generation || !["queued", "executing"].includes(op.state)) failPhone("phone_stale_run");
      const active = run(first(await db.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND state<>'stopped' FOR UPDATE`, [op.phoneId])));
      if (active && (result.runId !== active.id || generation !== active.generation)) failPhone("phone_stale_run");
      let state;
      if (op.action === "create") {
        if (result.storageReady !== true || result.volumeId !== current.volumeId) failPhone("phone_storage_unavailable");
        state = "stopped";
      } else if (op.action === "start" || (op.action === "restart" && current.state === "starting")) {
        if (!active || result.androidReady !== true || result.mediaReady !== true || !/^[a-f0-9]{64}$/.test(result.containerId ?? "")) failPhone("phone_runtime_unavailable");
        state = "running";
        await db.query(`UPDATE platform.phone_runs SET state='running',container_id=$2,updated_at=clock_timestamp() WHERE id=$1`, [active.id, result.containerId]);
      } else {
        if (result.runtimeStopped !== true) failPhone("phone_stop_unconfirmed");
        if (first(await db.query(`SELECT id FROM platform.phone_access_grants WHERE phone_id=$1
          AND state IN ('issued','connected','revoking') LIMIT 1`, [op.phoneId]))) failPhone("phone_stop_unconfirmed");
        if (op.action === "delete" && (result.dataDeleted !== true || result.volumeId !== current.volumeId)) failPhone("phone_delete_unconfirmed");
        if (active) await db.query(`UPDATE platform.phone_runs SET state='stopped',stopped_at=clock_timestamp(),
          clean_shutdown=$2,updated_at=clock_timestamp() WHERE id=$1`, [active.id, result.cleanShutdown === true]);
        if (op.action === "restart") {
          await db.query(`UPDATE platform.phones SET state='starting',generation=generation+1,revision=revision+1,
            updated_at=clock_timestamp() WHERE id=$1`, [op.phoneId]);
          return operation(first(await db.query(`UPDATE platform.phone_operations SET generation=generation+1,
            state='queued',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [op.id])));
        }
        state = op.action === "delete" ? "deleted" : "stopped";
      }
      const protection = state === "stopped" && ["memory_margin", "memory_pressure", "swap_out"].includes(result.protectionReason);
      await db.query(`UPDATE platform.phones SET state=$2,running_charged=$3,error_code=$4,revision=revision+1,
        deleted_at=CASE WHEN $2='deleted' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1`,
      [op.phoneId, state, state === "running", protection ? "phone_resource_protection" : null]);
      const completed = operation(first(await db.query(`UPDATE platform.phone_operations SET state='succeeded',finished_at=clock_timestamp(),
        updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [op.id])));
      if (op.action === "create" && op.startAfterCreate) {
        const count = first(await db.query(`SELECT count(*)::integer AS n FROM platform.phones WHERE owner_id=$1 AND running_charged`, [ownerId])).n;
        const identity = first(await db.query(`SELECT status FROM iam.identities WHERE id=$1`, [ownerId]));
        if (identity.status === "active" && (quota.runningPerUser === null || count < quota.runningPerUser)) {
          // Provision completion and auto-start intent commit together, surviving a platform crash between phases.
          await db.query(`UPDATE platform.phones SET state='starting',running_charged=true,generation=generation+1,
            revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [op.phoneId]);
          await insertOperation(db, { id: randomUUID(), phoneId: op.phoneId, ownerId, action: "start",
            key: `auto-${op.id}`, fingerprint: requestFingerprint({ phoneId: op.phoneId, expectedRevision: current.revision + 1 }),
            generation: generation + 1 });
        } else {
          await db.query(`UPDATE platform.phones SET error_code=$2,revision=revision+1,updated_at=clock_timestamp()
            WHERE id=$1`, [op.phoneId, identity.status === "active" ? "phone_running_quota" : "phone_permission_required"]);
        }
      }
      return completed;
    }, { allowInactive: true });
  }

  async confirmRunStopped({ ownerId, phoneId, runId, generation, containerId }) {
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async db => {
      const current = await owned(db, ownerId, phoneId, true);
      const value = run(first(await db.query(`SELECT * FROM platform.phone_runs WHERE id=$1 AND phone_id=$2 AND owner_id=$3
        AND generation=$4 FOR UPDATE`, [runId, phoneId, ownerId, generation])));
      if (!value || current.generation !== generation || (value.containerId !== null && value.containerId !== containerId)) failPhone("phone_stale_run");
      if (value.state !== "stopped") await db.query(`UPDATE platform.phone_runs SET state='stopped',stopped_at=clock_timestamp(),
        clean_shutdown=false,updated_at=clock_timestamp() WHERE id=$1`, [runId]);
      // Logical/node resources are released only by the caller's confirmed-stop transaction/path.
      return value;
    }, { allowInactive: true });
  }

  async failOperation({ ownerId, operationId, generation, error, runtimeStopped = false }) {
    const errorCode = phoneErrorCode(error);
    return this.#ownerTransaction(ownerId, PHONE_POLICY, async db => {
      const op = operation(first(await db.query(`SELECT * FROM platform.phone_operations WHERE id=$1 AND owner_id=$2`, [operationId, ownerId])));
      if (!op) failPhone("phone_not_found");
      const current = await owned(db, ownerId, op.phoneId, true);
      if (current.generation !== generation || op.generation !== generation || !["queued", "executing"].includes(op.state)) failPhone("phone_stale_run");
      const active = run(first(await db.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND state<>'stopped'`, [op.phoneId])));
      // Callers cannot release a live reservation with a boolean: the exact run must first be reconciled as stopped.
      if (active && runtimeStopped) failPhone("phone_stop_unconfirmed");
      await db.query(`UPDATE platform.phones SET state=$4,error_code=$2,running_charged=$3,
        revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
      [op.phoneId, errorCode, current.runningCharged && !runtimeStopped,
        errorCode === "phone_node_unavailable" ? "unavailable" : "error"]);
      return operation(first(await db.query(`UPDATE platform.phone_operations SET state='failed',error_code=$2,
        finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [op.id, errorCode])));
    }, { allowInactive: true });
  }
}
