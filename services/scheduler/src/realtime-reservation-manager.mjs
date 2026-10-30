import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { validateReservation } from "./lease-manager.mjs";

const CAPABILITIES = new Set(["asr", "translation", "codec", "webrtc-gateway"]);
const CAPACITY_ERRORS = new Set([
  "lease_capacity_exhausted",
  "node_capacity_unknown",
  "node_codec_capacity_unknown",
  "realtime_codec_capacity_exhausted",
  "node_exclusive_pending",
  "node_exclusive_active",
  "node_not_ready",
  "stale_node_generation",
  "unified_memory_pressure",
]);
const MINIMUM_LIFETIME_SECONDS = 30;
const MAXIMUM_LIFETIME_SECONDS = 3_600;
const DEFAULT_CONNECTION_GRACE_MILLISECONDS = 30_000;

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function instant(value, name) {
  const resolved = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(resolved.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return resolved;
}

function codecDirections(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("codecDirections must be an object");
  }
  const normalized = {};
  for (const key of ["encodeSessions", "decodeSessions"]) {
    const amount = value[key] ?? 0;
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new TypeError(`codecDirections.${key} must be a non-negative safe integer`);
    }
    normalized[key] = amount;
  }
  return Object.freeze(normalized);
}

function candidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("realtime placement candidate must be an object");
  }
  if (!Number.isSafeInteger(value.nodeGeneration) || value.nodeGeneration < 1) {
    throw new TypeError("candidate.nodeGeneration must be a positive safe integer");
  }
  const latencyBudgetMilliseconds = value.latencyBudgetMilliseconds;
  if (!Number.isSafeInteger(latencyBudgetMilliseconds)
      || latencyBudgetMilliseconds < 10
      || latencyBudgetMilliseconds > 10_000) {
    throw new TypeError("candidate.latencyBudgetMilliseconds must be between 10 and 10000");
  }
  return Object.freeze({
    nodeId: required(value.nodeId, "candidate.nodeId"),
    nodeGeneration: value.nodeGeneration,
    modelProfileId: value.modelProfileId === null ? null : required(value.modelProfileId, "candidate.modelProfileId"),
    route: ["local", "managed_node"].includes(value.route) ? value.route : "local",
    resources: validateReservation(value.resources),
    codecDirections: codecDirections(value.codecDirections),
    latencyBudgetMilliseconds,
    observedLatencyMilliseconds: Number.isFinite(value.observedLatencyMilliseconds)
      ? Math.max(0, value.observedLatencyMilliseconds)
      : Number.POSITIVE_INFINITY,
    warm: value.warm === true,
  });
}

function publicReservation(session) {
  const resources = session.resources;
  return Object.freeze({
    reservation_id: session.sessionId,
    reservation_kind: "realtime",
    priority_class: "latency",
    latency_budget_milliseconds: session.latencyBudgetMilliseconds,
    protected_from_batch: true,
    resources: Object.freeze({
      cpu_millis: resources.cpuMillis,
      unified_memory_bytes: resources.unifiedMemoryBytes,
      accelerator_units: resources.acceleratorUnits,
      codec_sessions: resources.codecSessions,
      storage_bytes: resources.storageBytes,
      network_bits_per_second: resources.networkBitsPerSecond,
      codec_encode_sessions: session.codecDirections.encodeSessions,
      codec_decode_sessions: session.codecDirections.decodeSessions,
    }),
  });
}

function publicSession(session) {
  return Object.freeze({
    sessionId: session.sessionId,
    state: session.state,
    capability: session.capability,
    model: session.requestedModel,
    expiresAt: session.expiresAt.toISOString(),
    reservation: publicReservation(session),
  });
}

export class RealtimeReservationManager {
  #repository;
  #placementResolver;
  #clock;
  #connectionGraceMilliseconds;
  #retryAfterSeconds;
  #memoryGuard;
  #memorySnapshotProvider;

  constructor({
    repository,
    placementResolver,
    clock = () => new Date(),
    connectionGraceMilliseconds = DEFAULT_CONNECTION_GRACE_MILLISECONDS,
    retryAfterSeconds = 5,
    memoryGuard = null,
    memorySnapshotProvider = null,
  }) {
    const requiredMethods = [
      "acquireRealtimeReservation", "connectRealtimeSession", "heartbeatRealtimeSession",
      "releaseRealtimeSession", "reconcileRealtimeSessions", "listActiveRealtimeSessions",
    ];
    if (!repository || requiredMethods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("realtime reservation repository is incomplete");
    }
    if (!placementResolver?.resolve) throw new TypeError("realtime placement resolver is required");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (!Number.isSafeInteger(connectionGraceMilliseconds)
        || connectionGraceMilliseconds < 1_000
        || connectionGraceMilliseconds > 60_000) {
      throw new TypeError("connection grace must be between 1000 and 60000 milliseconds");
    }
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 300) {
      throw new TypeError("retryAfterSeconds must be between 1 and 300");
    }
    if ((memoryGuard === null) !== (memorySnapshotProvider === null)
        || (memoryGuard && (!memoryGuard.evaluate || !memorySnapshotProvider?.snapshot))) {
      throw new TypeError("memory guard and snapshot provider must be configured together");
    }
    this.#repository = repository;
    this.#placementResolver = placementResolver;
    this.#clock = clock;
    this.#connectionGraceMilliseconds = connectionGraceMilliseconds;
    this.#retryAfterSeconds = retryAfterSeconds;
    this.#memoryGuard = memoryGuard;
    this.#memorySnapshotProvider = memorySnapshotProvider;
  }

  async admit({
    ownerIdentityId, correlationId = null, capability, model = null,
    expiresInSeconds = 300, input = {}, output = {}, admissionKey = randomUUID(),
  }) {
    required(ownerIdentityId, "ownerIdentityId");
    required(admissionKey, "admissionKey");
    if (!CAPABILITIES.has(capability)) throw new TypeError("realtime capability is invalid");
    if (model !== null) required(model, "model");
    if (!Number.isSafeInteger(expiresInSeconds)
        || expiresInSeconds < MINIMUM_LIFETIME_SECONDS
        || expiresInSeconds > MAXIMUM_LIFETIME_SECONDS) {
      throw new TypeError("realtime lifetime must be between 30 and 3600 seconds");
    }
    const now = instant(this.#clock(), "clock");
    const resolved = await this.#placementResolver.resolve({
      ownerIdentityId, capability, model, input: structuredClone(input), output: structuredClone(output),
    });
    if (!Array.isArray(resolved)) throw new TypeError("realtime placement resolver must return an array");
    const candidates = resolved.map(candidate).sort((left, right) =>
      Number(right.warm) - Number(left.warm)
      || left.observedLatencyMilliseconds - right.observedLatencyMilliseconds
      || left.latencyBudgetMilliseconds - right.latencyBudgetMilliseconds
      || left.nodeId.localeCompare(right.nodeId));
    const rejected = [];
    for (const placement of candidates) {
      try {
        const expiresAt = new Date(now.getTime() + expiresInSeconds * 1_000);
        if (this.#memoryGuard) {
          const snapshot = await this.#memorySnapshotProvider.snapshot({
            nodeId: placement.nodeId,
            capability,
            modelProfileId: placement.modelProfileId,
            observedAt: now,
          });
          this.#memoryGuard.evaluate({
            ...snapshot,
            workload: {
              ...(snapshot.workload ?? {}),
              class: "realtime",
              requestedBytes: placement.resources.unifiedMemoryBytes,
              coldLoad: !placement.warm,
            },
          });
        }
        const session = await this.#repository.acquireRealtimeReservation({
          sessionId: randomUUID(), admissionKey, ownerIdentityId, correlationId,
          capability, requestedModel: model, modelProfileId: placement.modelProfileId,
          nodeId: placement.nodeId, nodeGeneration: placement.nodeGeneration,
          route: placement.route, resources: placement.resources,
          codecDirections: placement.codecDirections,
          latencyBudgetMilliseconds: placement.latencyBudgetMilliseconds,
          leaseToken: randomUUID(), admittedAt: now,
          connectionDeadlineAt: new Date(Math.min(
            expiresAt.getTime(), now.getTime() + this.#connectionGraceMilliseconds,
          )),
          expiresAt,
        });
        return publicSession(session);
      } catch (error) {
        if (!CAPACITY_ERRORS.has(error?.code)) throw error;
        rejected.push(Object.freeze({ nodeId: placement.nodeId, code: error.code }));
      }
    }
    throw new PlatformError("realtime_capacity_unavailable", "Realtime capacity is unavailable", {
      status: 429,
      retryable: true,
      details: Object.freeze({
        retryAfterSeconds: this.#retryAfterSeconds,
        candidateCount: candidates.length,
        reasons: rejected,
      }),
    });
  }

  async connect({ ownerIdentityId, sessionId, connectionId = randomUUID(), now = this.#clock() }) {
    required(ownerIdentityId, "ownerIdentityId");
    required(sessionId, "sessionId");
    required(connectionId, "connectionId");
    return publicSession(await this.#repository.connectRealtimeSession({
      ownerIdentityId, sessionId, connectionId, connectedAt: instant(now, "now"),
    }));
  }

  async heartbeat({ ownerIdentityId, sessionId, connectionId, now = this.#clock() }) {
    required(ownerIdentityId, "ownerIdentityId");
    required(sessionId, "sessionId");
    required(connectionId, "connectionId");
    return publicSession(await this.#repository.heartbeatRealtimeSession({
      ownerIdentityId, sessionId, connectionId, heartbeatAt: instant(now, "now"),
    }));
  }

  async disconnect({
    ownerIdentityId, sessionId, connectionId, reason = "websocket_disconnect", now = this.#clock(),
  }) {
    required(ownerIdentityId, "ownerIdentityId");
    required(sessionId, "sessionId");
    required(connectionId, "connectionId");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw new TypeError("disconnect reason is invalid");
    return publicSession(await this.#repository.releaseRealtimeSession({
      ownerIdentityId, sessionId, connectionId, reason, releasedAt: instant(now, "now"),
    }));
  }

  async reconcile({ now = this.#clock() } = {}) {
    return this.#repository.reconcileRealtimeSessions({ reconciledAt: instant(now, "now") });
  }

  async active({ now = this.#clock() } = {}) {
    const sessions = await this.#repository.listActiveRealtimeSessions({ observedAt: instant(now, "now") });
    return Object.freeze(sessions.map(publicSession));
  }
}

export class RealtimeConnectionLifecycle {
  #reservations;
  #clock;
  #heartbeatIntervalMilliseconds;

  constructor({ reservations, clock = () => new Date(), heartbeatIntervalMilliseconds = 10_000 }) {
    if (!reservations?.connect || !reservations?.heartbeat || !reservations?.disconnect) {
      throw new TypeError("realtime reservation manager is required");
    }
    if (!Number.isSafeInteger(heartbeatIntervalMilliseconds)
        || heartbeatIntervalMilliseconds < 1_000
        || heartbeatIntervalMilliseconds > 30_000) {
      throw new TypeError("heartbeat interval must be between 1000 and 30000 milliseconds");
    }
    this.#reservations = reservations;
    this.#clock = clock;
    this.#heartbeatIntervalMilliseconds = heartbeatIntervalMilliseconds;
  }

  async attach({ socket, ownerIdentityId, sessionId, connectionId = randomUUID() }) {
    if (!socket?.once || !socket?.destroy) throw new TypeError("socket is required");
    const session = await this.#reservations.connect({ ownerIdentityId, sessionId, connectionId, now: this.#clock() });
    let finished = false;
    let heartbeat = null;
    let expiry = null;
    const finish = async (reason = "websocket_disconnect") => {
      if (finished) return;
      finished = true;
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      try {
        await this.#reservations.disconnect({
          ownerIdentityId, sessionId, connectionId, reason, now: this.#clock(),
        });
      } catch {
        // The expiry reconciler is the durable fallback if cleanup cannot commit.
      }
    };
    socket.once("close", () => { void finish("websocket_disconnect"); });
    socket.once("end", () => { void finish("websocket_disconnect"); });
    socket.once("error", () => { void finish("websocket_error"); });
    heartbeat = setInterval(() => {
      void this.#reservations.heartbeat({
        ownerIdentityId, sessionId, connectionId, now: this.#clock(),
      }).catch(() => {
        socket.destroy();
        void finish("heartbeat_failed");
      });
    }, this.#heartbeatIntervalMilliseconds);
    heartbeat.unref?.();
    const expiresIn = Math.max(1, new Date(session.expiresAt).getTime() - instant(this.#clock(), "clock").getTime());
    expiry = setTimeout(() => {
      socket.destroy();
      void finish("session_expired");
    }, expiresIn);
    expiry.unref?.();
    return Object.freeze({ session, connectionId, finish });
  }
}

export const realtimeReservationPolicy = Object.freeze({
  minimumLifetimeSeconds: MINIMUM_LIFETIME_SECONDS,
  maximumLifetimeSeconds: MAXIMUM_LIFETIME_SECONDS,
  defaultConnectionGraceMilliseconds: DEFAULT_CONNECTION_GRACE_MILLISECONDS,
});
