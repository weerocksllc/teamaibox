import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {
  projectManagedNodeLeaseCapacity,
} from "./managed-node-scheduling.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const LABEL_KEY = /^[a-z][a-z0-9_.-]{1,63}$/;
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,127}$/;
const RESOURCE_KEY = /^[a-z][A-Za-z0-9]{1,63}$/;
const FORBIDDEN_FACT = /(?:secret|token|password|credential|private|authorization|cookie|endpoint|uri|url)/i;
const PRECISION = /^[a-z][a-z0-9_-]{1,31}$/;

function fail(code, message, status = 400, details = null, retryable = false) { throw new PlatformError(code, message, { status, details, retryable }); }
function admin(context) { if (!UUID.test(context?.identityId ?? "")) fail("invalid_session", "Authentication is required", 401); if (!context.permissions?.includes("node:manage")) fail("managed_node_permission_required", "Managed node administrator permission is required", 403); return context.identityId; }
function viewer(context) { if (!UUID.test(context?.identityId ?? "")) fail("invalid_session", "Authentication is required", 401); if (!context.permissions?.some((permission) => permission === "node:view" || permission === "node:manage")) fail("managed_node_permission_required", "Managed node view permission is required", 403); return context.identityId; }
function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("managed_node_inventory_invalid", `${field} is invalid`, 400, { field }); return value; }
function text(value, field, maximum = 256) { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail("managed_node_inventory_invalid", `${field} is invalid`, 400, { field }); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function translated(error) {
  if (typeof error?.code === "string" && (error.code.startsWith("managed_node_") || error.code.startsWith("node_enrollment_") || error.code === "stale_node_generation")) {
    // A concurrent heartbeat/admin update is not revoked node authority. The
    // caller must refresh/retry; the conflicting write is still rejected.
    fail(error.code, error.message, 409, null, error.code === "managed_node_revision_conflict");
  }
  throw error;
}

function labels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) fail("managed_node_labels_invalid", "Managed node labels are invalid");
  const entries = Object.entries(value).map(([name, content]) => { if (!LABEL_KEY.test(name) || name.startsWith("teamaibox.") || typeof content !== "string" || !LABEL_VALUE.test(content)) fail("managed_node_labels_invalid", "Managed node labels are invalid"); return [name, content]; }).sort(([a], [b]) => a.localeCompare(b));
  return Object.freeze(Object.fromEntries(entries));
}

function noSensitiveFacts(value, path = "inventory") {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) { if (FORBIDDEN_FACT.test(name)) fail("managed_node_inventory_sensitive", "Managed node inventory contains a forbidden field", 400, { field: `${path}.${name}` }); if (child && typeof child === "object") noSensitiveFacts(child, `${path}.${name}`); }
}

function stringList(value, field, pattern = KEY, maximum = 64) { if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !pattern.test(item)) || new Set(value).size !== value.length) fail("managed_node_inventory_invalid", `${field} is invalid`); return Object.freeze([...value].sort()); }
function resourceMap(value, field, { allowEmpty = false, required = [] } = {}) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32 || (!allowEmpty && Object.keys(value).length < 1) || required.some((key) => !Object.hasOwn(value, key))) fail("managed_node_inventory_invalid", `${field} is invalid`); return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, amount]) => [RESOURCE_KEY.test(key) ? key : fail("managed_node_inventory_invalid", `${field} key is invalid`), integer(amount, `${field}.${key}`)]).sort(([a], [b]) => a.localeCompare(b)))); }

function normalizeInventory(value) {
  noSensitiveFacts(value);
  if (!value || value.schemaVersion !== 1 || value.architecture !== "arm64" || !VERSION.test(value.agentVersion ?? "") || !value.resources || !value.health) fail("managed_node_inventory_invalid", "Managed node inventory declaration is invalid");
  if (!new Set(["healthy", "degraded"]).has(value.health.state)) fail("managed_node_inventory_invalid", "Managed node health is invalid");
  const runtimes = (value.runtimes ?? []).map((item, index) => { if (!item || !KEY.test(item.runtimeKey ?? "") || !VERSION.test(item.version ?? "") || !SHA256.test(item.imageDigest ?? "")) fail("managed_node_inventory_invalid", `runtimes.${index} is invalid`); return Object.freeze({ runtimeKey: item.runtimeKey, version: item.version, imageDigest: item.imageDigest }); });
  const profiles = (value.modelProfiles ?? []).map((item, index) => { if (!item || !UUID.test(item.profileId ?? "") || !KEY.test(item.profileKey ?? "") || !SHA256.test(item.profileFingerprint ?? "") || !new Set(["certified", "experimental", "revalidation_required"]).has(item.lifecycleState)) fail("managed_node_inventory_invalid", `modelProfiles.${index} is invalid`); return Object.freeze({ profileId: item.profileId, profileKey: item.profileKey, profileFingerprint: item.profileFingerprint, lifecycleState: item.lifecycleState, operations: stringList(item.operations ?? [], `modelProfiles.${index}.operations`) }); });
  const capabilities = (value.capabilities ?? []).map((item, index) => { if (!item || !KEY.test(item.capabilityKey ?? "") || !new Set(["available", "degraded", "unavailable"]).has(item.state) || !SHA256.test(item.evidenceDigest ?? "")) fail("managed_node_inventory_invalid", `capabilities.${index} is invalid`); return Object.freeze({ capabilityKey: item.capabilityKey, state: item.state, evidenceDigest: item.evidenceDigest }); });
  const links = (value.networkLinks ?? []).map((item, index) => { if (!item || !KEY.test(item.linkKey ?? "") || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(item.networkClass ?? "") || !new Set(["healthy", "degraded", "down"]).has(item.health)) fail("managed_node_inventory_invalid", `networkLinks.${index} is invalid`); return Object.freeze({ linkKey: item.linkKey, networkClass: item.networkClass, health: item.health, speedBitsPerSecond: integer(item.speedBitsPerSecond, `networkLinks.${index}.speedBitsPerSecond`), mtu: integer(item.mtu, `networkLinks.${index}.mtu`, 1280, 65_535), latencyMicroseconds: integer(item.latencyMicroseconds, `networkLinks.${index}.latencyMicroseconds`) }); });
  const scheduling = value.schedulerFacts;
  if (!scheduling || !scheduling.accelerator || !scheduling.codec || !scheduling.storage
      || !new Set(["warm", "preparing", "cold"]).has(scheduling.workerState)
      || typeof scheduling.modelArtifactCached !== "boolean") fail("managed_node_inventory_invalid", "schedulerFacts is invalid");
  const accelerator = scheduling.accelerator;
  if (!KEY.test(accelerator.kind ?? "") || typeof accelerator.computeCapability !== "string"
      || !/^\d+(?:\.\d+)?$/.test(accelerator.computeCapability)
      || !SHA256.test(accelerator.evidenceDigest ?? "")) fail("managed_node_inventory_invalid", "schedulerFacts.accelerator is invalid");
  const supportedPrecisions = stringList(accelerator.supportedPrecisions ?? [], "schedulerFacts.accelerator.supportedPrecisions", PRECISION, 32);
  const codec = Object.freeze({ encodeSessions: integer(scheduling.codec.encodeSessions, "schedulerFacts.codec.encodeSessions"), decodeSessions: integer(scheduling.codec.decodeSessions, "schedulerFacts.codec.decodeSessions"), evidenceDigest: SHA256.test(scheduling.codec.evidenceDigest ?? "") ? scheduling.codec.evidenceDigest : fail("managed_node_inventory_invalid", "schedulerFacts.codec.evidenceDigest is invalid") });
  const storage = Object.freeze({ classes: stringList(scheduling.storage.classes ?? [], "schedulerFacts.storage.classes"), evidenceDigest: SHA256.test(scheduling.storage.evidenceDigest ?? "") ? scheduling.storage.evidenceDigest : fail("managed_node_inventory_invalid", "schedulerFacts.storage.evidenceDigest is invalid") });
  const inputArtifactIds = stringList(scheduling.inputArtifactIds ?? [], "schedulerFacts.inputArtifactIds", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 256);
  const resources = Object.freeze({ cpu: resourceMap(value.resources.cpu, "resources.cpu", { required: ["totalMillis", "availableMillis"] }), unifiedMemory: resourceMap(value.resources.unifiedMemory, "resources.unifiedMemory", { required: ["totalBytes", "availableBytes"] }), accelerator: resourceMap(value.resources.accelerator, "resources.accelerator", { required: ["units"] }), codecs: resourceMap(value.resources.codecs, "resources.codecs", { required: ["sessions"] }), storage: resourceMap(value.resources.storage, "resources.storage", { required: ["availableBytes"] }), network: resourceMap(value.resources.network, "resources.network", { required: ["availableBitsPerSecond"] }) });
  if (resources.cpu.totalMillis < 1 || resources.cpu.availableMillis > resources.cpu.totalMillis || resources.unifiedMemory.totalBytes < 1 || resources.unifiedMemory.availableBytes > resources.unifiedMemory.totalBytes) fail("managed_node_inventory_invalid", "Managed node available resources exceed totals");
  const reservations = resourceMap(value.reservations ?? {}, "reservations", { required: ["cpuMillis", "unifiedMemoryBytes", "acceleratorUnits", "codecSessions", "storageBytes", "networkBitsPerSecond"] });
  return Object.freeze({ schemaVersion: 1, architecture: "arm64", agentVersion: value.agentVersion, health: Object.freeze({ state: value.health.state, errorCode: value.health.errorCode == null ? null : text(value.health.errorCode, "health.errorCode", 128) }),
    runtimes: Object.freeze(runtimes.sort((a, b) => a.runtimeKey.localeCompare(b.runtimeKey))), modelProfiles: Object.freeze(profiles.sort((a, b) => a.profileKey.localeCompare(b.profileKey))), capabilities: Object.freeze(capabilities.sort((a, b) => a.capabilityKey.localeCompare(b.capabilityKey))),
    resources, schedulerFacts: Object.freeze({ accelerator: Object.freeze({ kind: accelerator.kind, computeCapability: accelerator.computeCapability, supportedPrecisions, evidenceDigest: accelerator.evidenceDigest }), codec, storage, workerState: scheduling.workerState, modelArtifactCached: scheduling.modelArtifactCached, inputArtifactIds }),
    networkLinks: Object.freeze(links.sort((a, b) => a.linkKey.localeCompare(b.linkKey))), reservations, activeWorkloads: integer(value.activeWorkloads ?? 0, "activeWorkloads", 0, 100_000) });
}

function publicNode(value) { return Object.freeze({ nodeId: value.nodeId, nodeKey: value.nodeKey, architecture: value.architecture, trustKind: "managed_appliance", lifecycleState: value.lifecycleState, generation: value.generation,
  agentVersion: value.agentVersion, labels: Object.freeze(structuredClone(value.labels)), health: Object.freeze(structuredClone(value.health)), inventory: value.inventory ? Object.freeze(structuredClone(value.inventory)) : null,
  inventoryDigest: value.inventoryDigest, lastSeenAt: value.lastSeenAt ? new Date(value.lastSeenAt).toISOString() : null, certificateNotAfter: value.certificateNotAfter ? new Date(value.certificateNotAfter).toISOString() : null, revision: value.revision, createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString() }); }
export class ManagedNodeService {
  #repository; #localNodeId; #clock; #audit; #staleMs; #healthSink; #onHealthSinkError;
  #observationStartedAt = null; #observationStart = null;
  constructor({ repository, localNodeId, clock = () => new Date(), audit = async () => {}, staleAfterMilliseconds = 45_000,
    healthSink = null, onHealthSinkError = async () => {} }) {
    const methods = ["findNode", "updateNode", "recordHeartbeat", "fenceStale", "awaitFreshHeartbeats"];
    if (!UUID.test(localNodeId ?? "") || !repository || methods.some(method => typeof repository[method] !== "function")
        || typeof clock !== "function" || typeof audit !== "function" || !Number.isSafeInteger(staleAfterMilliseconds)
        || staleAfterMilliseconds < 10_000 || staleAfterMilliseconds > 300_000
        || healthSink !== null && typeof healthSink.recordManagedNodeHealth !== "function") throw new TypeError("Local appliance dependencies are incomplete");
    this.#repository = repository; this.#localNodeId = localNodeId; this.#clock = clock; this.#audit = audit;
    this.#staleMs = staleAfterMilliseconds;
    this.#healthSink = healthSink; this.#onHealthSinkError = onHealthSinkError;
  }
  #assertLocal(nodeId) { if (nodeId !== this.#localNodeId) fail("appliance_node_mismatch", "仅支持本机操作。", 409); }

  // Controller downtime is not an observed node timeout. Quarantine the saved
  // availability before serving requests, then allow one normal heartbeat
  // window. This never renews a lease, rewinds a generation or revives a node
  // already fenced/disabled/removed. Subsequent sweeps use the original timeout.
  async beginObservationWindow({ restartObservation = false } = {}) {
    if (!this.#observationStart || restartObservation) {
      const now = this.#clock();
      this.#observationStartedAt = null;
      this.#observationStart = this.#repository.awaitFreshHeartbeats({ now, nodeId: this.#localNodeId });
    }
    await this.#observationStart;
  }

  async heartbeat({ transportIdentity, nodeId, generation, inventory }) {
    this.#assertLocal(nodeId);
    if (transportIdentity?.mutualTls !== true || transportIdentity.certificateVerified !== true || transportIdentity.subjectNodeId !== nodeId || !SHA256.test(transportIdentity.certificateFingerprint ?? "")) fail("managed_node_mtls_required", "Verified mutual TLS node identity is required", 401);
    const current = await this.#repository.findNode(nodeId), now = this.#clock(); if (!current || current.lifecycleState === "removed") fail("managed_node_not_found", "Managed node was not found", 404);
    if (current.certificateFingerprint !== transportIdentity.certificateFingerprint || current.certificateNotAfter <= now) fail("managed_node_certificate_rejected", "Managed node certificate is not active", 401);
    if (generation !== current.generation) fail("stale_node_generation", "Managed node generation changed", 409, { currentGeneration: current.generation }, true);
    if (current.lifecycleState === "disabled") fail("managed_node_disabled", "Managed node is disabled", 409);
    const normalized = normalizeInventory(inventory), inventoryDigest = digest(JSON.stringify(normalized));
    const admitted = normalized.health.state === "healthy";
    const lifecycleState = current.lifecycleState === "draining" ? "draining" : admitted ? "ready" : "joining";
    const saved = await this.#repository.recordHeartbeat(nodeId, current.revision, { generation, node: { lifecycleState, agentVersion: normalized.agentVersion,
      health: { state: normalized.health.state, errorCode: normalized.health.errorCode, observedAt: now }, inventory: normalized, inventoryDigest,
      capacity: projectManagedNodeLeaseCapacity(normalized), lastSeenAt: now, updatedAt: now } }).catch(translated);
    try { await this.#healthSink?.recordManagedNodeHealth(saved); }
    catch (error) { try { await this.#onHealthSinkError(error, { nodeId, generation, operation: "heartbeat" }); } catch { /* diagnostic reporting is non-authoritative */ } }
    return Object.freeze({ nodeId, generation: saved.generation, lifecycleState: saved.lifecycleState, heartbeatAcceptedAt: now.toISOString(), nextHeartbeatBefore: new Date(now.getTime() + Math.floor(this.#staleMs * 0.66)).toISOString() });
  }

  async list({ context }) { viewer(context); return Object.freeze({ object: "list", data: Object.freeze([await this.#repository.findNode(this.#localNodeId)].filter(Boolean).map(publicNode)) }); }
  async get({ context, nodeId }) { viewer(context); this.#assertLocal(nodeId); const value = await this.#repository.findNode(nodeId); if (!value) fail("managed_node_not_found", "Managed node was not found", 404); return publicNode(value); }
  async updateLabels({ context, nodeId, expectedRevision, nodeLabels }) { this.#assertLocal(nodeId); const administrator = admin(context), current = await this.#repository.findNode(nodeId); if (!current) fail("managed_node_not_found", "Managed node was not found", 404); const now = this.#clock(), saved = await this.#repository.updateNode(nodeId, expectedRevision, { labels: labels(nodeLabels), updatedAt: now }).catch(translated); await this.#audit({ action: "compute.node_labels_updated", actorIdentityId: administrator, nodeId, occurredAt: now.toISOString() }); return publicNode(saved); }
  async setEnabled({ context, nodeId, expectedRevision, enabled }) { this.#assertLocal(nodeId); const administrator = admin(context), current = await this.#repository.findNode(nodeId); if (!current) fail("managed_node_not_found", "Managed node was not found", 404); if (typeof enabled !== "boolean" || (enabled ? !new Set(["disabled", "offline"]).has(current.lifecycleState) : !new Set(["joining", "ready", "draining", "offline"]).has(current.lifecycleState))) fail("managed_node_transition_invalid", "Managed node enable transition is invalid", 409); const now = this.#clock(), saved = await this.#repository.updateNode(nodeId, expectedRevision, { lifecycleState: enabled ? "joining" : "disabled", generation: current.generation + 1, health: enabled ? { state: "unknown", errorCode: null, observedAt: now } : { state: "offline", errorCode: "node_disabled", observedAt: now }, updatedAt: now }).catch(translated); await this.#audit({ action: enabled ? "compute.node_enabled" : "compute.node_disabled", actorIdentityId: administrator, nodeId, generation: saved.generation, occurredAt: now.toISOString() }); return publicNode(saved); }
  async setDrain({ context, nodeId, expectedRevision, draining }) { this.#assertLocal(nodeId); const administrator = admin(context), current = await this.#repository.findNode(nodeId); if (!current) fail("managed_node_not_found", "Managed node was not found", 404); if (typeof draining !== "boolean" || (draining ? current.lifecycleState !== "ready" : current.lifecycleState !== "draining") || (!draining && current.health.state !== "healthy")) fail("managed_node_transition_invalid", "Managed node drain transition is invalid", 409); const now = this.#clock(), saved = await this.#repository.updateNode(nodeId, expectedRevision, { lifecycleState: draining ? "draining" : "ready", updatedAt: now }).catch(translated); await this.#audit({ action: draining ? "compute.node_drain_started" : "compute.node_drain_cancelled", actorIdentityId: administrator, nodeId, occurredAt: now.toISOString() }); return publicNode(saved); }
  async reconcileStale({ now = this.#clock() } = {}) {
    if (this.#observationStart) {
      await this.#observationStart;
      // The first sweep starts after HTTP listen. Slow control-plane startup
      // must not consume the node's opportunity to deliver its first heartbeat.
      this.#observationStartedAt ??= now;
    }
    if (this.#observationStartedAt && now.getTime() - this.#observationStartedAt.getTime() < this.#staleMs) {
      return Object.freeze({ fenced: Object.freeze([]) });
    }
    const cutoff = new Date(now.getTime() - this.#staleMs), fenced = await this.#repository.fenceStale({ cutoff, now, nodeId: this.#localNodeId }); for (const node of fenced) { await this.#audit({ action: "compute.node_stale_fenced", nodeId: node.nodeId, generation: node.generation, occurredAt: now.toISOString() }); try { await this.#healthSink?.recordManagedNodeHealth(node); } catch (error) { try { await this.#onHealthSinkError(error, { nodeId: node.nodeId, generation: node.generation, operation: "stale_fence" }); } catch { /* diagnostic reporting is non-authoritative */ } } } return Object.freeze({ fenced: Object.freeze(fenced.map(publicNode)) });
  }
}
