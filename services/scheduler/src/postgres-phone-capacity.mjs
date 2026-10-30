import { randomUUID } from "node:crypto";
import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { phoneRuntimeResources } from "./virtual-phone-capacity.mjs";
import { phoneApprovedNodes } from "./phone-approved-nodes.mjs";
import { installedPhoneRom, installedPhoneRuntime, LEGACY_PHONE_ROM } from "./phone-rom.mjs";
import { phoneStorageObservation } from "./phone-storage-observation.mjs";
const first = result => result.rows[0] ?? null;
const fail = (code, reason) => { throw new PlatformError(code, "虚拟手机运行节点暂未就绪。", { status: 409, retryable: true, details: { reason } }); };
const guestNodeRole = role => role === "appliance-core";
const mapped = row => row && ({ id: row.id, phoneId: row.phone_id, ownerId: row.owner_id,
  generation: Number(row.generation), nodeId: row.node_id, nodeGeneration: Number(row.node_generation),
  reservationId: row.reservation_id, imageDigest: row.image_digest, state: row.state, containerId: row.container_id,
  memoryBytes: Number(row.memory_bytes), cpuMillis: row.cpu_millis });

export class PostgresPhoneCapacity {
  #database; #nodes; #storage; #clock;
  constructor({ database, approvedNodes, localNodeId, storageProvider = null, clock = () => new Date() }) {
    if (!database?.transaction || !database?.query || !Array.isArray(approvedNodes)) {
      throw new TypeError("Phone capacity requires shared PostgreSQL, approved nodes");
    }
    this.#nodes = phoneApprovedNodes(approvedNodes);
    if (!localNodeId || this.#nodes.size !== 1 || !this.#nodes.has(localNodeId)) {
      throw new TypeError("Phone capacity requires the single local appliance installation");
    }
    if (storageProvider !== null && typeof storageProvider.read !== "function") throw TypeError("Phone storage observation requires a reader");
    this.#storage = storageProvider;
    this.#database = database; this.#clock = clock;
  }
  async status() {
    const records = [];
    for (const node of this.#nodes.values()) {
      const row = first(await this.#database.query(`SELECT n.generation,n.lifecycle_state,n.recovery_state,n.appliance_role,n.architecture,n.trust_kind,
        n.node_key,n.labels->>'displayName' AS display_name,n.last_seen_at,
        p.encryption_mode,p.encryption_status,p.compatibility_status,p.health_state,p.lifecycle_state AS pool_state,
        (SELECT count(*)::integer FROM platform.phone_runs r WHERE r.node_id=n.id AND r.state='running') AS running_count,
        (SELECT count(*)::integer FROM platform.phone_runs r WHERE r.node_id=n.id AND r.state NOT IN ('running','stopped')) AS starting_count,
        (SELECT count(*)::integer FROM platform.phone_runs r WHERE r.node_id=n.id AND r.state<>'stopped') AS running
        FROM compute.nodes n LEFT JOIN objects.storage_pools p ON p.node_id=n.id AND p.pool_id=$2 WHERE n.id=$1`, [node.nodeId, node.poolId]));
      const ready = row?.lifecycle_state === "ready" && row.recovery_state === "healthy" && guestNodeRole(row.appliance_role)
        && row.trust_kind === "managed_appliance" && ["arm64", "aarch64"].includes(row.architecture)
        && Number.isSafeInteger(Number(row.generation)) && Number(row.generation) >= node.nodeGeneration;
      let storage = ready && row.encryption_mode === "luks2" && row.encryption_status === "verified"
        && row.compatibility_status === "verified" && row.health_state === "healthy" && row.pool_state === "active";
      if (storage && this.#storage) {
        try { await this.#storageRead({...node,nodeGeneration:Number(row.generation)}); } catch { storage = false; }
      }
      records.push({ nodeId: node.nodeId, nodeGeneration: Number(row?.generation), running: row?.running ?? 0,
        roms: node.roms ?? [{ romVersionId: LEGACY_PHONE_ROM, imageDigest: node.imageDigest }],
        nodeName: row?.display_name?.trim().slice(0,120) || row?.node_key || null, address: null,
        runningCount: row?.running_count ?? null, startingCount: row?.starting_count ?? null,
        observedAt: row ? new Date(this.#clock()).toISOString() : null, lastSeenAt: row?.last_seen_at ?? null,
        reasonCode: !ready ? "phone_node_unavailable" : !storage ? "phone_storage_unavailable" : null });
    }
    return records;
  }
  async #storageRead(node) {
    return phoneStorageObservation(await this.#storage.read({ nodeId: node.nodeId, nodeGeneration: node.nodeGeneration }),
      { ...node, now: this.#clock() });
  }
  async placement({ rom } = {}) {
    const nodes = (await this.status()).filter(node => !node.reasonCode && (!rom || installedPhoneRom(this.#nodes.get(node.nodeId), rom.id, rom.imageDigest)));
    if (rom && !nodes.length) fail("phone_rom_not_installed", "requested_version_not_installed");
    if (!nodes.length) fail("phone_storage_unavailable", "no_managed_encrypted_node");
    const selected = {...this.#nodes.get(nodes[0].nodeId),nodeGeneration:nodes[0].nodeGeneration};
    return { nodeId: selected.nodeId, poolId: selected.poolId,
      ...(rom ? { romVersionId: rom.id, imageDigest: rom.imageDigest } : {}),
      ...(this.#storage ? { storageObservation: await this.#storageRead(selected) } : {}) };
  }
  async acquireRun({ phone, operation, policy }) {
    const approved = this.#nodes.get(phone.nodeId);
    if (!approved || approved.poolId !== phone.poolId) fail("phone_node_unavailable", "node_not_approved");
    const installed = installedPhoneRuntime(approved, phone);
    if (!installed) fail("phone_rom_not_installed", "pinned_version_not_installed");
    return this.#database.transaction(async db => {
      // Serialize run identity with node recovery; this is not a resource ledger.
      const node = first(await db.query(`SELECT * FROM compute.nodes WHERE id=$1 FOR UPDATE`, [phone.nodeId]));
      const current = first(await db.query(`SELECT * FROM platform.phones WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [phone.id, phone.ownerId]));
      const op = first(await db.query(`SELECT * FROM platform.phone_operations WHERE id=$1 AND phone_id=$2 AND owner_id=$3
        AND state IN ('queued','executing')`, [operation.id, phone.id, phone.ownerId]));
      if (!current || !op || current.state !== "starting" || !current.running_charged
          || current.rom_version_id !== phone.romVersionId
          || Number(current.generation) !== operation.generation || Number(op.generation) !== operation.generation) fail("phone_stale_run", "operation_changed");
      const existing = first(await db.query(`SELECT * FROM platform.phone_runs WHERE phone_id=$1 AND generation=$2`, [phone.id, operation.generation]));
      if (existing) {
        if (existing.state === "stopped" || !installedPhoneRuntime(approved, phone, existing.image_digest) || existing.node_id !== approved.nodeId
            || Number(existing.node_generation) < approved.nodeGeneration || Number(existing.node_generation) !== Number(node?.generation)) fail("phone_stale_run", "run_changed");
        return mapped(existing);
      }
      if (node?.trust_kind !== "managed_appliance" || !guestNodeRole(node.appliance_role) || node.lifecycle_state !== "ready"
          || node.recovery_state !== "healthy" || !Number.isSafeInteger(Number(node.generation)) || Number(node.generation) < approved.nodeGeneration
          || !["arm64", "aarch64"].includes(node.architecture)) fail("phone_node_unavailable", "managed_guest_node_not_ready");
      const identity = first(await db.query(`SELECT status FROM iam.identities WHERE id=$1`, [phone.ownerId]));
      if (identity?.status !== "active") fail("phone_permission_required", "owner_inactive");
      const pool = first(await db.query(`SELECT * FROM objects.storage_pools WHERE pool_id=$1 AND node_id=$2`, [phone.poolId, phone.nodeId]));
      if (pool?.encryption_mode !== "luks2" || pool.encryption_status !== "verified" || pool.health_state !== "healthy"
          || pool.lifecycle_state !== "active" || pool.compatibility_status !== "verified") fail("phone_storage_unavailable", "pool_not_ready");
      const currentGeneration=Number(node.generation);
      if (this.#storage) await this.#storageRead({...approved,nodeGeneration:currentGeneration});
      const at = new Date(this.#clock());
      const exclusive = (await db.query(`SELECT id::text FROM compute.node_exclusive_intents WHERE node_id=$1
        AND (state='acquired' OR (state='pending' AND deadline_at>$2))
        UNION ALL SELECT id::text FROM compute.lease_sets WHERE node_id=$1 AND state='active' AND node_exclusive AND expires_at>$2
        UNION ALL SELECT id FROM compute.protected_office_set_transactions WHERE node_id=$1 AND transaction_state NOT IN ('succeeded','rolled-back')`,
      [phone.nodeId, at])).rows;
      if (exclusive.length) fail("phone_capacity_unavailable", "node_exclusive_or_maintenance");
      // Other guests' configured maxima do not book this appliance's CPU/RAM.
      // Start normally; the exact runtime reports allocation or OOM failures.
      return mapped(first(await db.query(`INSERT INTO platform.phone_runs(id,phone_id,owner_id,generation,node_id,node_generation,
        reservation_id,image_digest,state,memory_bytes,cpu_millis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10) RETURNING *`,
      [randomUUID(), phone.id, phone.ownerId, operation.generation, phone.nodeId, currentGeneration, randomUUID(), installed.imageDigest,
        phoneRuntimeResources.unifiedMemoryBytes, phoneRuntimeResources.cpuMillis])));
    });
  }
  async releaseRun({ phone, run, stopResult }) {
    if (stopResult?.runtimeStopped !== true || stopResult.runId !== run.id) fail("phone_stop_unconfirmed", "exact_stop_required");
    return this.#database.transaction(async db => {
      await db.query(`SELECT id FROM compute.nodes WHERE id=$1 FOR UPDATE`, [phone.nodeId]);
      const value = first(await db.query(`SELECT * FROM platform.phone_runs WHERE id=$1 AND phone_id=$2 AND owner_id=$3
        AND generation=$4 AND node_id=$5 AND node_generation=$6 AND image_digest=$7 FOR UPDATE`,
      [run.id, phone.id, phone.ownerId, run.generation, run.nodeId, run.nodeGeneration, run.imageDigest]));
      if (!value) fail("phone_stale_run", "run_changed");
      if (value.state !== "stopped") await db.query(`UPDATE platform.phone_runs SET state='stopped',stopped_at=clock_timestamp(),
        clean_shutdown=$2,updated_at=clock_timestamp() WHERE id=$1`, [run.id, stopResult.cleanShutdown === true]);
    });
  }
}
