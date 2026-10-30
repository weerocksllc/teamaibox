import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { PostgresRealtimeReservationRepository } from "../../../services/scheduler/src/postgres-realtime-reservation-repository.mjs";
import { createPostgresUnifiedMemoryProtection } from "../../../services/scheduler/src/postgres-unified-memory-snapshot-provider.mjs";
import { RealtimeReservationManager } from "../../../services/scheduler/src/realtime-reservation-manager.mjs";
import { OpenAiRealtimeSpeechTransport } from "./realtime-speech-transport.mjs";

const CAPABILITIES = new Set(["asr", "translation", "codec", "webrtc-gateway"]);
const ROUTES = new Set(["local"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CERTIFIED = new Set(["certified"]);
const RESOURCE_KEYS = Object.freeze([
  "cpuMillis", "unifiedMemoryBytes", "acceleratorUnits", "codecSessions",
  "storageBytes", "networkBitsPerSecond",
]);

function key(value, name) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{1,191}$/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function optionalModel(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f]{1,512}$/u.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function placement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !CAPABILITIES.has(value.capability)
      || !ROUTES.has(value.route) || typeof value.resources !== "object" || Array.isArray(value.resources)
      || typeof value.codecDirections !== "object" || Array.isArray(value.codecDirections)) {
    throw new TypeError("Realtime placement is invalid");
  }
  const model = optionalModel(value.model, "Realtime placement model");
  const profileKey = value.modelProfileKey === null || value.modelProfileKey === undefined
    ? null : key(value.modelProfileKey, "Realtime model profile key");
  if (new Set(["asr", "translation"]).has(value.capability) && (!model || !profileKey)) {
    throw new TypeError("Realtime speech placements require a model and certified profile");
  }
  const latencyBudgetMilliseconds = nonNegativeInteger(value.latencyBudgetMilliseconds, "Realtime latency budget");
  if (latencyBudgetMilliseconds < 10 || latencyBudgetMilliseconds > 10_000) throw new TypeError("Realtime latency budget is invalid");
  const observedLatencyMilliseconds = value.observedLatencyMilliseconds === null ? null : Number(value.observedLatencyMilliseconds);
  if (observedLatencyMilliseconds !== null && (!Number.isFinite(observedLatencyMilliseconds) || observedLatencyMilliseconds < 0 || observedLatencyMilliseconds > 60_000)) {
    throw new TypeError("Realtime observed latency is invalid");
  }
  const protectedResident = value.protectedResident ?? null;
  if (protectedResident !== null && (value.capability !== 'asr' || !profileKey
      || !UUID.test(protectedResident.workerId ?? '') || typeof protectedResident.setId !== 'string'
      || !protectedResident.setId.startsWith('factory-office-')
      || !Number.isSafeInteger(protectedResident.maintenanceGeneration) || protectedResident.maintenanceGeneration < 1)) {
    throw new TypeError('Realtime protected resident binding is invalid');
  }
  return Object.freeze({
    capability: value.capability,
    model,
    nodeKey: key(value.nodeKey, "Realtime node key"),
    modelProfileKey: profileKey,
    route: value.route,
    resources: Object.freeze(Object.fromEntries(RESOURCE_KEYS.map((name) => [name, nonNegativeInteger(value.resources[name], `Realtime ${name}`)]))),
    codecDirections: Object.freeze({
      encodeSessions: nonNegativeInteger(value.codecDirections.encodeSessions, "Realtime encode sessions"),
      decodeSessions: nonNegativeInteger(value.codecDirections.decodeSessions, "Realtime decode sessions"),
    }),
    latencyBudgetMilliseconds,
    observedLatencyMilliseconds,
    warm: value.warm === true,
    protectedResident,
  });
}

async function speechTransport(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Realtime speech transport is invalid");
  const allowed = new Set([
    "origin", "model", "maximumChunkBytes", "maximumResponseBytes", "timeoutMilliseconds",
    "credentialFile", "customCaFile", "serverName",
  ]);
  if (Object.keys(value).some((name) => !allowed.has(name))) throw new TypeError("Realtime speech transport contains unsupported fields");
  const credentialPath = value.credentialFile ?? null;
  const caPath = value.customCaFile ?? null;
  if ((credentialPath === null) !== (caPath === null)
      || (credentialPath !== null && (!isAbsolute(credentialPath) || !isAbsolute(caPath)))) {
    throw new TypeError("Realtime speech credential and CA files must both be absolute paths");
  }
  let credential = null;
  let customCa = null;
  try {
    if (credentialPath) {
      const raw = await readFile(credentialPath);
      try {
        const token = raw.toString("utf8").trim();
        if (token.length < 8 || token.length > 8_192 || /[\s,]/.test(token)) throw new TypeError("Realtime speech credential file is invalid");
        credential = Buffer.from(token, "utf8");
      } finally { raw.fill(0); }
      customCa = await readFile(caPath);
    }
    return new OpenAiRealtimeSpeechTransport({
      origin: value.origin,
      model: value.model,
      maximumChunkBytes: value.maximumChunkBytes,
      maximumResponseBytes: value.maximumResponseBytes,
      timeoutMilliseconds: value.timeoutMilliseconds,
      credential,
      customCa,
      serverName: value.serverName ?? null,
    });
  } finally {
    credential?.fill(0);
    customCa?.fill(0);
  }
}

export class PostgresRealtimePlacementResolver {
  #database;
  #placements;
  #localNodeId;

  constructor({ database, placements, localNodeId }) {
    if (!database?.query || !UUID.test(localNodeId ?? '') || !Array.isArray(placements) || placements.length < 1 || placements.length > 64) {
      throw new TypeError("Realtime placement resolver configuration is invalid");
    }
    this.#database = database;
    this.#localNodeId = localNodeId;
    this.#placements = Object.freeze(placements.map(placement));
  }

  async resolve({ capability, model }) {
    if (!CAPABILITIES.has(capability)) return Object.freeze([]);
    const matches = this.#placements.filter((item) => item.capability === capability && item.model === (model ?? null));
    const resolved = [];
    for (const item of matches) {
      const result = await this.#database.query(`
        SELECT node.id AS node_id, node.generation, node.lifecycle_state,
               profile.id AS profile_id, profile.certification_state
        FROM compute.nodes node
        LEFT JOIN compute.model_profiles profile ON profile.profile_key=$2
        WHERE node.node_key=$1 AND node.id=$3::uuid AND node.lifecycle_state <> 'removed'
        LIMIT 1`, [item.nodeKey, item.modelProfileKey, this.#localNodeId]);
      const row = result?.rows?.[0];
      if (!row || row.node_id !== this.#localNodeId || row.lifecycle_state !== "ready") continue;
      if (item.modelProfileKey && !row.profile_id) continue;
      if (item.protectedResident) {
        // Factory profiles do not invent a certification or borrow another
        // box's latency result. Reuse only the exact locally observed set.
        const proof = await this.#database.query(`SELECT 1 FROM compute.protected_office_sets s
          JOIN compute.model_profiles p ON p.id=$3::uuid
          WHERE s.set_id=$1 AND s.node_id=$2::uuid AND s.recovery_state='healthy'
          AND p.placement_class='protected-resident' AND p.recovery_state='healthy'
          AND p.observed_state_revision=p.desired_state_revision
          AND p.maintenance_generation=$5 AND s.maintenance_generation=$5
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.healthy_identities) i
            WHERE i->>'workerId'=$4 AND i->>'modelProfileId'=$3
              AND i->>'placementClass'='protected-resident'
              AND (i->>'maintenanceGeneration')::bigint=$5 AND i->>'healthy'='true')`,
        [item.protectedResident.setId, this.#localNodeId, row.profile_id,
          item.protectedResident.workerId, item.protectedResident.maintenanceGeneration]);
        if (!proof.rows?.length) continue;
      } else if (item.modelProfileKey && !CERTIFIED.has(row.certification_state)) continue;
      resolved.push(Object.freeze({
        nodeId: row.node_id,
        nodeGeneration: Number(row.generation),
        modelProfileId: row.profile_id ?? null,
        route: item.route,
        resources: item.resources,
        codecDirections: item.codecDirections,
        latencyBudgetMilliseconds: item.latencyBudgetMilliseconds,
        observedLatencyMilliseconds: item.observedLatencyMilliseconds,
        warm: item.protectedResident ? true : item.warm,
      }));
    }
    return Object.freeze(resolved);
  }
}

export async function createRealtimeRuntimeFromEnvironment(environment, { database } = {}) {
  const path = environment.PLATFORM_REALTIME_PLACEMENT_CONFIG_FILE;
  if (typeof path !== "string" || !isAbsolute(path) || !database?.query || !database?.transaction) {
    throw new TypeError("Realtime runtime requires an absolute policy file and PostgreSQL");
  }
  const bytes = await readFile(path);
  let config;
  try {
    if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) throw new TypeError("Realtime placement policy is invalid");
    config = JSON.parse(bytes.toString("utf8"));
  } finally { bytes.fill(0); }
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.placements)) {
    throw new TypeError("Realtime placement policy is invalid");
  }
  const manager = new RealtimeReservationManager({
    repository: new PostgresRealtimeReservationRepository({ database }),
    placementResolver: new PostgresRealtimePlacementResolver({ database, placements: config.placements,
      localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID }),
    connectionGraceMilliseconds: config.connectionGraceMilliseconds ?? 30_000,
    retryAfterSeconds: config.retryAfterSeconds ?? 5,
    ...createPostgresUnifiedMemoryProtection({ database, environment }),
  });
  const intervalMilliseconds = config.reconcileIntervalMilliseconds ?? 5_000;
  if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000 || intervalMilliseconds > 60_000) {
    throw new TypeError("Realtime reconciliation interval is invalid");
  }
  const realtimeSpeechTransport = await speechTransport(config.speechTransport);
  const timer = setInterval(() => { void manager.reconcile().catch(() => {}); }, intervalMilliseconds);
  timer.unref?.();
  queueMicrotask(() => { void manager.reconcile().catch(() => {}); });
  return Object.freeze({
    realtimeAdmission: manager,
    ...(realtimeSpeechTransport ? { realtimeSpeechTransport } : {}),
    close() {
      clearInterval(timer);
      realtimeSpeechTransport?.close();
    },
  });
}
