import { createHash } from "node:crypto";
import https from "node:https";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function bytesDigest(value, name) {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) throw new TypeError(`${name} is invalid`);
  return `sha256:${value.toString("hex")}`;
}

function parsedJson(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

export class StaticMaintenanceCatalog {
  #values;
  constructor({ candidates }) {
    if (!Array.isArray(candidates)) throw new TypeError("maintenance candidate catalog is invalid");
    this.#values = Object.freeze(candidates.map((item) => Object.freeze(structuredClone(item))));
  }
  async list() { return this.#values; }
  async get({ kind, candidateKey }) {
    const value = this.#values.find((item) => item.kind === kind && item.candidateKey === candidateKey);
    if (!value) throw new PlatformError("maintenance_candidate_not_found", "Maintenance candidate was not found", { status: 404 });
    return value;
  }
}

export class PostgresMaintenanceTopologySource {
  #database; #localNodeId;
  constructor({database, localNodeId}) {
    if (!database?.query || !UUID.test(localNodeId ?? '')) throw new TypeError('Local device maintenance configuration is required');
    this.#database=database; this.#localNodeId=localNodeId;
  }
  async describe({targetNodeIds=null}={}) {
    if(targetNodeIds!==null && (!Array.isArray(targetNodeIds)||targetNodeIds.length!==1||targetNodeIds[0]!==this.#localNodeId))
      throw new PlatformError('maintenance_targets_invalid','Only this appliance can be maintained',{status:400});
    const result=await this.#database.query("SELECT id,node_key,lifecycle_state,health FROM compute.nodes WHERE id=$1 AND lifecycle_state<>'removed'",[this.#localNodeId]);
    const nodes=result.rows.map(row=>({nodeId:row.id,nodeKey:row.node_key,lifecycleState:row.lifecycle_state,healthState:parsedJson(row.health)?.state??'unknown'}));
    return {nodes,readyServingNodeIds:nodes.filter(n=>n.lifecycleState==='ready'&&n.healthState==='healthy').map(n=>n.nodeId)};
  }
}

export class PostgresMaintenanceModelCompatibility {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("maintenance model compatibility requires PostgreSQL transactions");
    this.#database = database;
  }
  async evaluate({ candidate }) {
    const keys = candidate?.execution?.revalidationProfileKeys ?? [];
    if (!Array.isArray(keys) || keys.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_.-]{2,191}$/.test(item))) throw new TypeError("maintenance revalidation profile selection is invalid");
    if (keys.length === 0) return Object.freeze({ evidenceDigest: digest({ candidateDigest: candidate.digest, profiles: [] }), incompatibleProfileIds: [], requiresRevalidationProfileIds: [] });
    const result = await this.#database.query(`SELECT id,profile_key,certification_state FROM compute.model_profiles
      WHERE profile_key=ANY($1::text[]) ORDER BY profile_key`, [keys]);
    if (result.rows.length !== new Set(keys).size) throw new PlatformError("update_model_profile_missing", "A maintenance model profile is unavailable", { status: 409 });
    const incompatible = result.rows.filter((row) => new Set(["failed", "deprecated"]).has(row.certification_state)).map((row) => row.id);
    const revalidation = result.rows.filter((row) => !incompatible.includes(row.id)).map((row) => row.id);
    return Object.freeze({ evidenceDigest: digest({ candidateDigest: candidate.digest, profiles: result.rows.map((row) => ({ id: row.id, state: row.certification_state })) }),
      incompatibleProfileIds: Object.freeze(incompatible), requiresRevalidationProfileIds: Object.freeze(revalidation) });
  }
  async fenceAndQueueRevalidation({ profileIds, planId, phase }) {
    if (!Array.isArray(profileIds) || profileIds.some((item) => !UUID.test(item ?? "")) || !UUID.test(planId ?? "") || !new Set(["before_update", "after_update"]).has(phase)) throw new TypeError("maintenance model fencing request is invalid");
    if (phase === "after_update") return Object.freeze({ queuedProfileIds: Object.freeze([...profileIds]), evidenceDigest: digest({ planId, phase, profileIds }) });
    await this.#database.transaction(async (database) => {
      for (const profileId of [...new Set(profileIds)].sort()) {
        const current = (await database.query("SELECT * FROM compute.model_profiles WHERE id=$1 FOR UPDATE", [profileId])).rows[0];
        if (!current) throw new PlatformError("update_model_profile_missing", "A maintenance model profile is unavailable", { status: 409 });
        if (current.certification_state === "revalidation_required") continue;
        if (new Set(["failed", "deprecated"]).has(current.certification_state)) throw new PlatformError("update_model_profile_incompatible", "A maintenance model profile cannot be revalidated", { status: 409 });
        const nextRevision = Number(current.lifecycle_revision) + 1, now = new Date().toISOString();
        await database.query(`UPDATE compute.model_profiles SET certification_state='revalidation_required',lifecycle_revision=$2,
          lifecycle_reason_key='model.lifecycle.maintenance_fenced',lifecycle_evidence_refs=$3::jsonb,lifecycle_updated_at=$4 WHERE id=$1`,
        [profileId, nextRevision, JSON.stringify([`maintenance-plan:${planId}`]), now]);
        await database.query(`INSERT INTO compute.model_profile_lifecycle_events
          (model_profile_id,profile_revision,from_state,to_state,reason_key,evidence_refs,occurred_at)
          VALUES ($1,$2,$3,'revalidation_required','model.lifecycle.maintenance_fenced',$4::jsonb,$5)`,
        [profileId, nextRevision, current.certification_state, JSON.stringify([`maintenance-plan:${planId}`]), now]);
      }
    });
    return Object.freeze({ queuedProfileIds: Object.freeze([...profileIds]), evidenceDigest: digest({ planId, phase, profileIds }) });
  }
}

export class PostgresMaintenanceDrainController {
  #database; #service;
  constructor({ database, managedNodeService }) {
    if (!database?.query || typeof managedNodeService?.setDrain !== "function") throw new TypeError("maintenance drain controller dependencies are incomplete");
    this.#database = database; this.#service = managedNodeService;
  }
  async #change({ nodeId, planId, draining }) {
    const result = await this.#database.query(`SELECT nodes.revision,plans.requested_by FROM compute.nodes nodes
      JOIN platform.maintenance_plans plans ON plans.id=$2 WHERE nodes.id=$1`, [nodeId, planId]);
    const row = result.rows[0];
    if (!row) throw new PlatformError("update_drain_context_missing", "Maintenance drain context is unavailable", { status: 409 });
    const saved = await this.#service.setDrain({ context: { identityId: row.requested_by, permissions: ["node:manage"] }, nodeId,
      expectedRevision: Number(row.revision), draining });
    return Object.freeze({ passed: true, evidenceDigest: digest({ nodeId, planId, draining, revision: saved.revision, lifecycleState: saved.lifecycleState }) });
  }
  drain({ nodeId, planId }) { return this.#change({ nodeId, planId, draining: true }); }
  resume({ nodeId, planId }) { return this.#change({ nodeId, planId, draining: false }); }
}

function safeResponse(value, operation) {
  if (!value || value.operation !== operation || value.passed !== true || !DIGEST.test(value.evidenceDigest ?? "")) {
    throw new PlatformError("update_controller_protocol_invalid", "Maintenance controller returned invalid evidence", { status: 502 });
  }
  return Object.freeze({ passed: true, evidenceDigest: value.evidenceDigest });
}

export class HttpsMaintenanceExecutor {
  #database; #endpointConfig; #localNodeId; #tls;
  constructor({ database, localNodeId, endpoint, ca, certificate, privateKey }) {
    if (!database?.query || !UUID.test(localNodeId ?? "") || !endpoint || !["127.0.0.1", "localhost", "::1"].includes(endpoint.host) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !Buffer.isBuffer(ca) || !Buffer.isBuffer(certificate) || !Buffer.isBuffer(privateKey)) throw new TypeError("maintenance executor configuration is invalid");
    this.#database = database;
    this.#localNodeId = localNodeId; this.#endpointConfig = Object.freeze({ ...endpoint });
    this.#tls = { ca: Buffer.from(ca), cert: Buffer.from(certificate), key: Buffer.from(privateKey) };
  }
  async #endpoint(nodeId) {
    if (nodeId !== this.#localNodeId) throw new PlatformError("maintenance_targets_invalid", "Only this appliance can be maintained", {status: 400});
    return this.#endpointConfig;
  }
  async #call(nodeId, operation, body) {
    const endpoint = await this.#endpoint(nodeId), payload = Buffer.from(JSON.stringify(body));
    const value = await new Promise((resolve, reject) => {
      const request = https.request({ host: endpoint.host, port: endpoint.port, servername: endpoint.serverName,
        path: `/v1/platform/${operation}`, method: "POST", ca: this.#tls.ca, cert: this.#tls.cert, key: this.#tls.key,
        minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true, timeout: 45_000,
        headers: { "content-type": "application/json", "content-length": payload.byteLength } }, (response) => {
        const chunks = []; let size = 0;
        response.on("data", (chunk) => { size += chunk.byteLength; if (size > 64 << 10) request.destroy(new Error("maintenance response too large")); else chunks.push(chunk); });
        response.on("end", () => {
          let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(new Error("maintenance response invalid")); return; }
          if (response.statusCode !== 200) { reject(new PlatformError(parsed?.error?.code ?? "update_controller_failed", "Maintenance controller rejected the operation", { status: 409 })); return; }
          resolve(parsed);
        });
      });
      request.on("timeout", () => request.destroy(new Error("maintenance controller timeout")));
      request.on("error", reject); request.end(payload);
    }).catch((error) => { if (error instanceof PlatformError) throw error; throw new PlatformError("update_controller_unavailable", "Maintenance controller is unavailable", { cause: error, status: 502, retryable: true }); });
    return value;
  }
  async stagePlatform({ nodeId, candidate, planId }) { return safeResponse(await this.#call(nodeId, "stage", { nodeId, planId, candidateDigest: candidate.digest }), "stage"); }
  async applyPlatform({ nodeId, candidate, planId }) { return safeResponse(await this.#call(nodeId, "apply", { nodeId, planId, candidateDigest: candidate.digest }), "apply"); }
  async rollbackPlatform({ nodeId, planId, candidateDigest }) { return safeResponse(await this.#call(nodeId, "rollback", { nodeId, planId, candidateDigest }), "rollback"); }
  async applyHost() { throw new PlatformError("update_host_execution_not_configured", "Host maintenance execution requires the separately approved host channel", { status: 409 }); }
  async rollbackHost() { throw new PlatformError("update_host_execution_not_configured", "Host maintenance rollback requires the separately approved host channel", { status: 409 }); }
  async verifyNode({ nodeId, candidate, planId }) {
    const value = await this.#call(nodeId, "postcheck", { nodeId, planId, candidateDigest: candidate.digest });
    if (!value || value.operation !== "postcheck" || typeof value.passed !== "boolean" || !DIGEST.test(value.evidenceDigest ?? "")) throw new PlatformError("update_controller_protocol_invalid", "Maintenance post-check evidence is invalid", { status: 502 });
    return Object.freeze({ passed: value.passed, evidenceDigest: value.evidenceDigest });
  }
  async verifyAppliance({ candidate, targetNodeIds, planId }) {
    if (targetNodeIds?.length !== 1 || targetNodeIds[0] !== this.#localNodeId) throw new PlatformError("maintenance_targets_invalid", "Only this appliance can be maintained", {status: 400});
    const checks = await Promise.all(targetNodeIds.map(async (nodeId) => ({ nodeId, value: await this.verifyNode({ nodeId, candidate, planId }) })));
    return Object.freeze({ passed: checks.every((item) => item.value.passed), evidenceDigest: digest({ planId, candidateDigest: candidate.digest,
      nodes: checks.map((item) => ({ nodeId: item.nodeId, evidenceDigest: item.value.evidenceDigest, passed: item.value.passed })) }) });
  }
  close() { this.#tls.ca.fill(0); this.#tls.cert.fill(0); this.#tls.key.fill(0); }
}
