import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requireLocalApplianceExecutionTarget } from "./appliance-execution-target.mjs";

import { PluginAdministrationService } from "../src/plugins/plugin-administration-service.mjs";
import { FilePluginSourceCatalog } from "../../../services/plugin-runtime/src/file-plugin-source-catalog.mjs";
import {
  FileBearerTokenProvider,
  HttpsMarketplacePluginSource,
  OciRegistryPluginSource,
  OfflinePluginBundleSource,
} from "../../../services/plugin-runtime/src/real-plugin-sources.mjs";
import { PluginImportService, PluginSourceRouter } from "../../../services/plugin-runtime/src/plugin-import-service.mjs";
import { PluginLifecycleService } from "../../../services/plugin-runtime/src/plugin-lifecycle-service.mjs";
import { PostgresPluginImportRepository } from "../../../services/plugin-runtime/src/postgres-import-repository.mjs";
import { PostgresPluginLifecycleRepository } from "../../../services/plugin-runtime/src/postgres-lifecycle-repository.mjs";
import { PluginSandboxPolicy } from "../../../services/plugin-runtime/src/sandbox-policy.mjs";
import { DelegatedUserTokenService } from "../../../services/plugin-runtime/src/delegated-user-token-service.mjs";
import { ComputeCapabilityRegistrationService } from "../../../services/plugin-runtime/src/compute-capability-registration-service.mjs";
import { PostgresPluginAccessRepository } from "../../../services/plugin-runtime/src/postgres-plugin-access-repository.mjs";
import { PostgresDelegatedAccessControl } from "../../../services/plugin-runtime/src/postgres-delegated-access-control.mjs";
import { InternalSchedulerPluginAuthority } from "../../../services/plugin-runtime/src/internal-scheduler-plugin-authority.mjs";
import { HmacNodeAgentCommandSigner } from "../../../services/scheduler/src/node-agent-command-signer.mjs";
import { NodeAgentHttpsTransport } from "../../../services/scheduler/src/node-agent-https-transport.mjs";
import { NodeAgentWorkerSpecFactory } from "../../../services/scheduler/src/node-agent-worker-spec-factory.mjs";
import { ProtectedNodeAgentClient } from "../../../services/scheduler/src/protected-node-agent-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

function required(value, name, pattern = null) {
  if (typeof value !== "string" || value.length < 1 || (pattern && !pattern.test(value))) throw new TypeError(`${name} is invalid`);
  return value;
}
function integer(value, name, minimum, maximum) {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError(`${name} is invalid`); return result;
}
async function protectedBytes(path, name, maximum = 1 << 20) {
  if (!isAbsolute(path ?? "")) throw new TypeError(`${name} must be an absolute path`);
  const bytes = await readFile(path); if (bytes.byteLength < 1 || bytes.byteLength > maximum) { bytes.fill(0); throw new TypeError(`${name} is invalid`); } return bytes;
}
async function protectedBase64urlKey(path, name) {
  const encoded = await protectedBytes(path, name, 4096);
  try {
    const text = encoded.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,171}$/.test(text)) throw new TypeError(`${name} is invalid`);
    const key = Buffer.from(text, "base64url");
    if (key.byteLength < 32 || key.byteLength > 128 || key.toString("base64url") !== text) { key.fill(0); throw new TypeError(`${name} is invalid`); }
    return key;
  } finally { encoded.fill(0); }
}
export async function resolveNodeAgentCertificateFingerprint({ configured = null, path = null } = {}) {
  let protectedValue = null;
  if (path) {
    const bytes = await protectedBytes(path, "PLATFORM_PLUGIN_NODE_AGENT_FINGERPRINT_FILE", 4096);
    try { protectedValue = bytes.toString("utf8").trim(); }
    finally { bytes.fill(0); }
    if (/^[a-f0-9]{64}$/.test(protectedValue)) protectedValue = `sha256:${protectedValue}`;
    if (!SHA256.test(protectedValue)) throw new TypeError("plugin Node Agent certificate fingerprint file is invalid");
  }
  if (configured !== null && configured !== undefined && !SHA256.test(configured)) {
    throw new TypeError("node.expectedCertificateFingerprint is invalid");
  }
  if (protectedValue && configured && protectedValue !== configured) {
    throw new TypeError("plugin Node Agent certificate fingerprint sources differ");
  }
  return required(protectedValue ?? configured, "node.expectedCertificateFingerprint", SHA256);
}
async function jsonFile(path, name, maximum = 1 << 20) {
  const bytes = await protectedBytes(path, name, maximum);
  try { const value = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required"); return value; }
  finally { bytes.fill(0); }
}
function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function positiveProbeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function healthObservationLimit(probes, requiredConsecutive, pollMilliseconds) {
  const startup = probes?.startup ?? {};
  const readiness = probes?.readiness ?? {};
  const startupSeconds = positiveProbeInteger(startup.intervalSeconds, 1)
    * positiveProbeInteger(startup.failureThreshold, 6);
  const readinessSeconds = positiveProbeInteger(readiness.intervalSeconds, 1) * requiredConsecutive;
  const budgetMilliseconds = Math.min(120_000, Math.max(10_000, (startupSeconds + readinessSeconds) * 1_000));
  const timedObservations = pollMilliseconds === 0 ? requiredConsecutive + 8 : Math.ceil(budgetMilliseconds / pollMilliseconds) + 1;
  return Math.min(180, Math.max(requiredConsecutive + 8, timedObservations));
}

function applicationIngress(value) {
  if (!value || typeof value !== "object" || typeof value.networkName !== "string" || !/^[a-z][a-z0-9-]{2,127}$/.test(value.networkName)
    || !Number.isSafeInteger(value.containerPort) || value.containerPort < 1024 || value.containerPort > 65535) {
    throw new TypeError("plugin application ingress configuration is invalid");
  }
  return Object.freeze({ networkName: value.networkName, containerPort: value.containerPort });
}

class ProcessPluginLockManager {
  #locks = new Map();
  async runExclusive(key, operation) {
    const previous = this.#locks.get(key) ?? Promise.resolve(); let release;
    const next = new Promise((resolve) => { release = resolve; }), chained = previous.then(() => next); this.#locks.set(key, chained); await previous;
    try { return await operation(); } finally { release(); if (this.#locks.get(key) === chained) this.#locks.delete(key); }
  }
}

class FailClosedPluginMigrationRunner {
  async begin() {
    return Object.freeze({
      async apply() { const error = new Error("Plugin data migrations require a configured migration executor"); error.code = "plugin_migration_executor_unavailable"; throw error; },
      async commit() {}, async rollback() {},
    });
  }
}

export class ProtectedPluginNodeAgent {
  #client; #imports; #sandboxPolicy; #nodeGeneration; #pollMilliseconds; #sleep; #applicationIngress; #runtimeNamespace;
  #bindingResolver; #recoveryBindingUpdater;
  constructor({ client, imports, sandboxPolicy, nodeGeneration, pollMilliseconds = 500,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), applicationIngress: ingress = null,
    runtimeNamespace = "team-ai-box-default", bindingResolver = null, recoveryBindingUpdater = null }) {
    if (!client?.startWorker || !client?.workerHealth || !client?.stopWorker || !imports?.get || !imports?.list
      || !sandboxPolicy?.compile || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1
      || !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 0 || typeof sleep !== "function"
      || typeof runtimeNamespace !== "string" || !KEY.test(runtimeNamespace)) {
      throw new TypeError("protected plugin Node Agent dependencies are incomplete");
    }
    this.#client = client; this.#imports = imports; this.#sandboxPolicy = sandboxPolicy; this.#nodeGeneration = nodeGeneration;
    this.#pollMilliseconds = pollMilliseconds; this.#sleep = sleep; this.#applicationIngress = ingress === null ? null : applicationIngress(ingress);
    this.#runtimeNamespace = runtimeNamespace;
    this.#bindingResolver = bindingResolver;
    this.#recoveryBindingUpdater = recoveryBindingUpdater;
  }
  #workerId(pluginId, slot, generation) { return deterministicUuid(`teamaibox:plugin-worker:${this.#runtimeNamespace}:${generation}:${pluginId}:${slot}`); }
  #authority(pluginId, slot, generation) { return Object.freeze({ leaseId: deterministicUuid(`teamaibox:plugin-lease:${this.#runtimeNamespace}:${pluginId}:${slot}`), fencingToken: 1, nodeGeneration: generation }); }
  #access(pluginId, slot, manifest) {
    if (manifest.type !== "ApplicationPlugin") return null;
    if (!this.#applicationIngress || !manifest.entryPoints?.web || manifest.entryPoints.web.integration !== "iframe") {
      const error = new Error("ApplicationPlugin ingress is unavailable"); error.code = "plugin_application_ingress_unavailable"; throw error;
    }
    return Object.freeze({
      containerPort: this.#applicationIngress.containerPort,
      networkName: this.#applicationIngress.networkName,
      pathPrefix: manifest.entryPoints.web.path,
      integration: "iframe",
    });
  }
  async #facts(pluginId, version, slot, operationKey, starting = false) {
    const imported = await this.#imports.get(pluginId, version);
    if (!imported?.manifest) throw new Error("verified plugin manifest is unavailable");
    const runtimeImages = imported.manifest.images.filter((item) => new Set(["application", "worker"]).has(item.role));
    if (runtimeImages.length !== 1 || runtimeImages[0].variants.length !== 1) {
      const error = new Error("This runtime requires exactly one signed ARM64 application or worker image"); error.code = "plugin_runtime_image_topology_unsupported"; throw error;
    }
    const image = runtimeImages[0], variant = image.variants[0];
    if (variant.architecture !== "linux/arm64/v8" || !SHA256.test(variant.digest ?? "")) throw new Error("verified ARM64 image is unavailable");
    const sandbox = await this.#sandboxPolicy.compile({ manifest: imported.manifest, pluginId, version, operationKey });
    const localContentId = SHA256.test(variant.reference ?? "");
    if (localContentId && variant.reference !== variant.digest) throw new Error("offline plugin image content ID differs from manifest");
    const reference = localContentId || variant.reference.includes("@sha256:") ? variant.reference : `${variant.reference}@${variant.digest}`;
    const access = this.#access(pluginId, slot, imported.manifest);
    if (access && sandbox.network.networkName !== access.networkName) {
      const error = new Error("ApplicationPlugin ingress differs from sandbox policy"); error.code = "plugin_application_ingress_policy_mismatch"; throw error;
    }
    const generation = this.#bindingResolver ? await this.#bindingResolver({pluginId, version, slot, starting}) : this.#nodeGeneration;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('Plugin runtime binding is invalid');
    return { imported, sandbox, reference, access, workerId: this.#workerId(pluginId, slot, generation), authority: this.#authority(pluginId, slot, generation) };
  }
  async stage({ pluginId, version, slot, operationKey }) { await this.#facts(pluginId, version, slot, operationKey); }
  async start({ pluginId, version, slot, operationKey }) {
    const { imported, sandbox, reference, access, workerId, authority } = await this.#facts(pluginId, version, slot, operationKey, true);
    const manifest = imported.manifest;
    await this.#client.startWorker({ authority, correlationId: operationKey, worker: {
      workerId, attemptId: "", modelProfileId: "", workloadKind: manifest.type === "ApplicationPlugin" ? "application-plugin" : "compute-plugin",
      pluginId, image: reference, network: sandbox.network.networkName, networkPolicyId: sandbox.network.policyId,
      apiScopes: [...sandbox.api.scopes], egressHosts: [...sandbox.network.allowedHosts],
      limits: { memoryBytes: sandbox.limits.memoryBytes, cpuQuotaMicros: Math.max(1_000, sandbox.limits.cpuLimitMillicores * 100),
        pidsLimit: sandbox.limits.pidsLimit, ephemeralBytes: Math.min(manifest.resources.ephemeralStorageBytes, 34_359_738_368), openFilesLimit: sandbox.limits.openFilesLimit },
      security: sandbox.security,
      mounts: sandbox.filesystem.volumes.map((item) => ({ type: "volume", source: item.source, target: item.target, readOnly: item.readOnly })),
      publishedPorts: [], applicationPort: access?.containerPort ?? 0,
      devices: [...sandbox.devices], environment: { TEAMAIBOX_PLUGIN_ID: pluginId }, command: [], healthCommand: [],
    } });
  }
  async waitHealthy({ pluginId, version, slot, probes, requiredConsecutive, operationKey }) {
    const facts = await this.#facts(pluginId, version, slot, operationKey); let consecutive = 0, observations = 0, last = null;
    const maximumObservations = healthObservationLimit(probes, requiredConsecutive, this.#pollMilliseconds);
    while (observations < maximumObservations) {
      observations += 1;
      try {
        last = await this.#client.workerHealth({ workerId: facts.workerId, authority: facts.authority, correlationId: `${operationKey}:health:${observations}` });
        if (last?.status === "running" && new Set(["healthy", "not_configured"]).has(last.health)) consecutive += 1; else consecutive = 0;
      } catch { consecutive = 0; }
      if (consecutive >= requiredConsecutive) return Object.freeze({ healthy: true, consecutive, observations, runtimeGeneration: facts.authority.nodeGeneration, runtimeHealth: last?.health ?? "unknown", containerId: last?.containerId ?? null,
        ...(facts.access ? { access: Object.freeze({ pathPrefix: facts.access.pathPrefix, integration: facts.access.integration, transport: "node-agent-mtls-proxy" }) } : {}) });
      if (last?.status && last.status !== "running") return Object.freeze({ healthy: false, consecutive, observations, runtimeHealth: last.health ?? "unknown", runtimeStatus: last.status });
      if (last?.health === "unhealthy") return Object.freeze({ healthy: false, consecutive, observations, runtimeHealth: "unhealthy", runtimeStatus: last.status });
      await this.#sleep(this.#pollMilliseconds);
    }
    return Object.freeze({ healthy: false, consecutive, observations, maximumObservations, runtimeHealth: last?.health ?? "unknown", runtimeStatus: last?.status ?? "unknown" });
  }
  async promote() {}
  async recoverApplication(input) {
    const facts = await this.#facts(input.pluginId, input.version, input.slot, input.operationKey);
    if (facts.imported.state !== "verified" || facts.imported.manifest.type !== "ApplicationPlugin"
      || facts.sandbox.devices.length !== 0) throw new Error("plugin_boot_recovery_not_admitted");
    let health;
    try {
      health = await this.#client.workerHealth({ workerId: facts.workerId, authority: facts.authority,
        correlationId: `${input.operationKey}:inspect` });
    } catch (error) {
      // This exact code is the Agent's authenticated not-found response.
      // Generic health/ownership, transport and fencing failures cannot mutate.
      if (error?.code !== "managed_worker_not_found") throw error;
    }
    const restarted = health?.status !== "running";
    if (restarted) {
      if (health && !new Set(["created", "exited", "dead", "removed"]).has(health.status)) {
        throw new Error("plugin_boot_recovery_state_invalid");
      }
      await this.#stop(input.pluginId, input.version, input.slot, `${input.operationKey}:remove-stopped`, false);
      // Retained generations may address an existing app after a reconnect,
      // but cannot authorize a new container. Only after exact owned removal
      // succeeds bind the replacement to the current node generation.
      if (this.#recoveryBindingUpdater) await this.#recoveryBindingUpdater({ ...input,
        previousGeneration: facts.authority.nodeGeneration });
      await this.start(input);
    }
    const result = await this.waitHealthy({ ...input, probes: facts.imported.manifest.health, requiredConsecutive: 3 });
    if (!result.healthy) throw new Error("plugin_boot_recovery_health_failed");
    return Object.freeze({ ...result, restarted });
  }
  async resolveApplicationRoute({ pluginId, version, slot, operationKey = "plugin-route-resolve" }) {
    const facts = await this.#facts(pluginId, version, slot, operationKey);
    if (!facts.access) return null;
    const health = await this.#client.workerHealth({ workerId: facts.workerId, authority: facts.authority, correlationId: `${operationKey}:health` });
    if (health?.status !== "running" || !new Set(["healthy", "not_configured"]).has(health?.health)) return null;
    return Object.freeze({ pluginKey: pluginId, pathPrefix: facts.access.pathPrefix, integration: facts.access.integration,
      healthy: true, transport: "node-agent-mtls-proxy", observedAt: new Date().toISOString() });
  }
  async fetchApplication({ pluginId, version, slot, method, path, operationKey = "plugin-content-fetch" }) {
    const facts = await this.#facts(pluginId, version, slot, operationKey);
    if (!facts.access || !new Set(["GET", "HEAD"]).has(method) || typeof path !== "string"
      || !(path === facts.access.pathPrefix || path.startsWith(facts.access.pathPrefix + "/") || path.startsWith(facts.access.pathPrefix + "?"))) {
      const error = new Error("ApplicationPlugin content path is unavailable"); error.code = "plugin_application_path_denied"; throw error;
    }
    return this.#client.fetchApplication({ workerId: facts.workerId, authority: facts.authority, method, path,
      correlationId: `${operationKey}:content` });
  }
  async #stop(pluginId, version, slot, operationKey, tolerateMissing) {
    const facts = await this.#facts(pluginId, version, slot, operationKey);
    try { await (this.#client.stopApplication ?? this.#client.stopWorker).call(this.#client, { workerId: facts.workerId, authority: facts.authority, gracePeriodSeconds: 5, correlationId: operationKey }); }
    catch (error) { if (!tolerateMissing) throw error; }
  }
  stop(input) { return this.#stop(input.pluginId, input.version, input.slot, input.operationKey, false); }
  retire(input) { return this.#stop(input.pluginId, input.version, input.slot, input.operationKey, false); }
  removeStaged(input) { return this.#stop(input.pluginId, input.version, input.slot, input.operationKey, true); }
  async removeRuntime({ pluginId, operationKey }) {
    const imports = await this.#imports.list();
    const versions = imports.filter((item) => item.pluginId === pluginId).sort((left, right) => right.version.localeCompare(left.version));
    for (const version of versions) for (const slot of ["blue", "green"]) await this.#stop(pluginId, version.version, slot, `${operationKey}:remove:${slot}`, true);
  }
}

export class ProtectedPluginApplicationRouteSource {
  #repository; #nodeAgent;
  constructor({ repository, nodeAgent }) {
    if (!repository?.listPlugins || !nodeAgent?.resolveApplicationRoute || !nodeAgent?.fetchApplication) throw new TypeError("plugin application route dependencies are incomplete");
    this.#repository = repository; this.#nodeAgent = nodeAgent;
  }
  #plugins(pluginKey = null) {
    // Administration needs version/migration history; routing only needs the
    // current runtime. Keep the legacy adapter contract for in-memory stores.
    return this.#repository.listRuntimePlugins
      ? this.#repository.listRuntimePlugins({ pluginKey }) : this.#repository.listPlugins();
  }
  async routes({ pluginKey = null } = {}) {
    const plugins = await this.#plugins(pluginKey);
    const routes = await Promise.all(plugins.filter((plugin) => (pluginKey === null || plugin?.pluginId === pluginKey)
      && plugin?.pluginType === "ApplicationPlugin" && plugin.lifecycleState === "enabled"
      && plugin.currentVersion && new Set(["blue", "green"]).has(plugin.activeSlot)).map(async (plugin) => {
      try { return await this.#nodeAgent.resolveApplicationRoute({ pluginId: plugin.pluginId, version: plugin.currentVersion, slot: plugin.activeSlot,
        operationKey: `route-${plugin.pluginId}-${plugin.generation}` }); }
      catch { return null; }
    }));
    return Object.freeze(routes.filter(Boolean));
  }
  async fetch({ pluginKey, method, path }) {
    const plugin = (await this.#plugins(pluginKey)).find((item) => item?.pluginId === pluginKey
      && item.pluginType === "ApplicationPlugin" && item.lifecycleState === "enabled" && item.currentVersion
      && new Set(["blue", "green"]).has(item.activeSlot));
    if (!plugin) return null;
    try {
      return await this.#nodeAgent.fetchApplication({ pluginId: plugin.pluginId, version: plugin.currentVersion, slot: plugin.activeSlot,
        method, path, operationKey: `content-${plugin.pluginId}-${plugin.generation}` });
    } catch { return null; }
  }
}

export async function createPluginSourceAdaptersFromEnvironment(environment) {
  if (environment.PLATFORM_PLUGIN_SOURCE_MODE === 'offline') {
    const offline = new OfflinePluginBundleSource({
      root: required(environment.PLATFORM_PLUGIN_OFFLINE_BUNDLE_ROOT, 'PLATFORM_PLUGIN_OFFLINE_BUNDLE_ROOT'),
    });
    return Object.freeze({ sourceRouter: new PluginSourceRouter({ 'offline-bundle': offline }), close() {} });
  }
  if (environment.PLATFORM_PLUGIN_SOURCE_MODE && environment.PLATFORM_PLUGIN_SOURCE_MODE !== 'configured') {
    throw new TypeError('Plugin source mode is invalid');
  }
  const temporary = [];
  const adapters = [];
  try {
    const marketplaceCa = environment.PLATFORM_PLUGIN_MARKETPLACE_CA_FILE
      ? await protectedBytes(environment.PLATFORM_PLUGIN_MARKETPLACE_CA_FILE, "PLATFORM_PLUGIN_MARKETPLACE_CA_FILE") : null;
    if (marketplaceCa) temporary.push(marketplaceCa);
    const registryCa = environment.PLATFORM_PLUGIN_REGISTRY_CA_FILE
      ? await protectedBytes(environment.PLATFORM_PLUGIN_REGISTRY_CA_FILE, "PLATFORM_PLUGIN_REGISTRY_CA_FILE") : null;
    if (registryCa) temporary.push(registryCa);
    const marketplaceAuthorization = environment.PLATFORM_PLUGIN_MARKETPLACE_TOKEN_FILE
      ? new FileBearerTokenProvider({ path: environment.PLATFORM_PLUGIN_MARKETPLACE_TOKEN_FILE }) : null;
    const registryAuthorization = new FileBearerTokenProvider({
      path: required(environment.PLATFORM_PLUGIN_REGISTRY_TOKEN_FILE, "PLATFORM_PLUGIN_REGISTRY_TOKEN_FILE"),
    });
    const marketplace = new HttpsMarketplacePluginSource({
      origin: required(environment.PLATFORM_PLUGIN_MARKETPLACE_ORIGIN, "PLATFORM_PLUGIN_MARKETPLACE_ORIGIN"),
      authorizationProvider: marketplaceAuthorization,
      ca: marketplaceCa,
    });
    adapters.push(marketplace);
    const registry = new OciRegistryPluginSource({
      origin: required(environment.PLATFORM_PLUGIN_REGISTRY_ORIGIN, "PLATFORM_PLUGIN_REGISTRY_ORIGIN"),
      allowedReferenceHosts: required(environment.PLATFORM_PLUGIN_REGISTRY_REFERENCE_HOSTS,
        "PLATFORM_PLUGIN_REGISTRY_REFERENCE_HOSTS").split(",").map((item) => item.trim()),
      authorizationProvider: registryAuthorization,
      ca: registryCa,
    });
    adapters.push(registry);
    const offline = new OfflinePluginBundleSource({
      root: required(environment.PLATFORM_PLUGIN_OFFLINE_BUNDLE_ROOT, "PLATFORM_PLUGIN_OFFLINE_BUNDLE_ROOT"),
    });
    return Object.freeze({
      sourceRouter: new PluginSourceRouter({ marketplace, "private-registry": registry, "offline-bundle": offline }),
      close() { for (const adapter of adapters) adapter.close?.(); },
    });
  } catch (error) {
    for (const adapter of adapters) adapter.close?.();
    throw error;
  } finally {
    for (const bytes of temporary) bytes.fill(0);
  }
}

export async function createPluginRuntimeFromEnvironment(environment, { database, audit = async () => {} } = {}) {
  if (!database?.query || !database?.transaction) throw new TypeError("plugin runtime requires PostgreSQL");
  const config = await jsonFile(environment.PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE, "PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE");
  requireLocalApplianceExecutionTarget(environment, config.node);
  const importPolicy = await jsonFile(environment.PLATFORM_PLUGIN_IMPORT_POLICY_FILE, "PLATFORM_PLUGIN_IMPORT_POLICY_FILE");
  const sandboxPolicyDocument = await jsonFile(environment.PLATFORM_PLUGIN_SANDBOX_POLICY_FILE, "PLATFORM_PLUGIN_SANDBOX_POLICY_FILE");
  if (config.schemaVersion !== 1 || !UUID.test(config.node?.nodeId ?? "") || !Number.isSafeInteger(config.node?.nodeGeneration)
    || config.node.nodeGeneration < 1 || !Array.isArray(config.capabilities)) throw new TypeError("plugin runtime configuration is invalid");
  const secrets = [];
  let sourceAdapters = null;
  try {
    const expectedCertificateFingerprint = await resolveNodeAgentCertificateFingerprint({
      configured: config.node.expectedCertificateFingerprint,
      path: environment.PLATFORM_PLUGIN_NODE_AGENT_FINGERPRINT_FILE,
    });
    const commandBytes = await protectedBytes(environment.PLATFORM_PLUGIN_NODE_AGENT_COMMAND_KEY_FILE, "PLATFORM_PLUGIN_NODE_AGENT_COMMAND_KEY_FILE", 4096);
    secrets.push(commandBytes);
    const commandKey = Buffer.from(commandBytes.toString("utf8").trim(), "base64");
    secrets.push(commandKey);
    if (commandKey.byteLength < 32 || commandKey.byteLength > 128) throw new TypeError("plugin Node Agent command key is invalid");
    const ca = await protectedBytes(environment.PLATFORM_PLUGIN_NODE_AGENT_CA_FILE, "PLATFORM_PLUGIN_NODE_AGENT_CA_FILE"); secrets.push(ca);
    const certificate = await protectedBytes(environment.PLATFORM_PLUGIN_NODE_AGENT_CLIENT_CERT_FILE, "PLATFORM_PLUGIN_NODE_AGENT_CLIENT_CERT_FILE"); secrets.push(certificate);
    const privateKey = await protectedBytes(environment.PLATFORM_PLUGIN_NODE_AGENT_CLIENT_KEY_FILE, "PLATFORM_PLUGIN_NODE_AGENT_CLIENT_KEY_FILE"); secrets.push(privateKey);
    const delegationPepper = await protectedBase64urlKey(environment.PLATFORM_PLUGIN_DELEGATION_PEPPER_FILE, "PLATFORM_PLUGIN_DELEGATION_PEPPER_FILE"); secrets.push(delegationPepper);
    const sourceCatalog = new FilePluginSourceCatalog({ path: required(environment.PLATFORM_PLUGIN_SOURCE_CATALOG_FILE, "PLATFORM_PLUGIN_SOURCE_CATALOG_FILE") });
    sourceAdapters = await createPluginSourceAdaptersFromEnvironment(environment);
    const imports = new PostgresPluginImportRepository({ database });
    const lifecycleRepository = new PostgresPluginLifecycleRepository({ database, lockManager: new ProcessPluginLockManager() });
    const importService = new PluginImportService({ sourceRouter: sourceAdapters.sourceRouter,
      trustStore: { resolve: (keyId) => sourceCatalog.resolveTrust(keyId) }, repository: imports,
      environment: { async capabilities() { return [...config.capabilities]; }, async dependency(pluginId) { const plugin = await lifecycleRepository.getPlugin(pluginId); return plugin?.currentVersion ? { version: plugin.currentVersion, enabled: plugin.lifecycleState === "enabled" } : null; }, async permissionDecision() { return { allowed: true }; } },
      policy: importPolicy });
    const sandboxPolicy = new PluginSandboxPolicy({ policy: sandboxPolicyDocument, auditSink: { async record(event) { await audit({ ...event, domain: "plugin", outcome: "denied" }); } } });
    const signer = new HmacNodeAgentCommandSigner({ keyId: required(config.node.commandKeyId, "node.commandKeyId", KEY), key: commandKey });
    const transport = new NodeAgentHttpsTransport({ host: required(config.node.host, "node.host"), port: integer(config.node.port, "node.port", 1024, 65535),
      expectedServerName: required(config.node.expectedServerName, "node.expectedServerName"), expectedCertificateFingerprint, ca, certificate, privateKey });
    const resolveGeneration = async () => {
        const result = await database.query('SELECT generation,lifecycle_state FROM compute.nodes WHERE id=$1', [config.node.nodeId]);
        const node = result.rows[0];
        if (!node || !['ready', 'draining'].includes(node.lifecycle_state)) throw new Error('Plugin node is unavailable');
        return Number(node.generation);
      };
    const client = new ProtectedNodeAgentClient({ nodeId: config.node.nodeId, nodeGeneration: config.node.nodeGeneration, transport, commandSigner: signer, workerSpecFactory: new NodeAgentWorkerSpecFactory(),
      allowRetainedRuntime: true, resolveGeneration });
    const nodeAgent = new ProtectedPluginNodeAgent({ client, imports, sandboxPolicy, nodeGeneration: config.node.nodeGeneration,
      pollMilliseconds: integer(config.healthPollMilliseconds ?? 500, "healthPollMilliseconds", 100, 10_000),
      applicationIngress: applicationIngress(config.applicationIngress),
      bindingResolver: async input => lifecycleRepository.resolveRuntimeGeneration({...input,
        legacyGeneration: config.node.nodeGeneration, currentGeneration: await resolveGeneration()}),
      recoveryBindingUpdater: async input => lifecycleRepository.rebindRecoveredApplication({ ...input,
        currentGeneration: await resolveGeneration() }),
      runtimeNamespace: required(environment.PLATFORM_PLUGIN_RUNTIME_NAMESPACE ?? "team-ai-box-default", "PLATFORM_PLUGIN_RUNTIME_NAMESPACE", KEY) });
    const accessRepository = new PostgresPluginAccessRepository({ database });
    const schedulerAuthority = new InternalSchedulerPluginAuthority();
    const delegatedUserTokenService = new DelegatedUserTokenService({ repository: accessRepository,
      accessControl: new PostgresDelegatedAccessControl({ database }), authorityVerifier: schedulerAuthority,
      auditSink: { async record(event) { await audit({ ...event, actorIdentityId: event.identityId ?? null, domain: "plugin",
        outcome: event.action?.endsWith("_failed") ? "denied" : "succeeded" }); } }, tokenPepper: delegationPepper });
    const lifecycleService = new PluginLifecycleService({ verifiedImports: imports, repository: lifecycleRepository, nodeAgent,
      migrationRunner: new FailClosedPluginMigrationRunner(), sandboxPolicy, delegationRevoker: delegatedUserTokenService,
      lifecycleAuthority: schedulerAuthority, audit });
    const computeCapabilityRegistrationService = new ComputeCapabilityRegistrationService({ repository: accessRepository,
      schedulerAuthority, auditSink: { async record(event) { await audit({ ...event, domain: "plugin", outcome: "succeeded" }); } } });
    const recovery = new PluginStartupRecovery({ lifecycleService, audit });
    return Object.freeze({ service: new PluginAdministrationService({ imports, lifecycleRepository, importService, lifecycleService, audit }),
      applicationRouteSource: new ProtectedPluginApplicationRouteSource({ repository: lifecycleRepository, nodeAgent }),
      delegatedUserTokenService, computeCapabilityRegistrationService, schedulerAuthority,
      startRecovery() { recovery.start(); },
      close() { recovery.close(); client.close(); sourceAdapters.close(); } });
  } catch (error) {
    sourceAdapters?.close();
    throw error;
  } finally { for (const secret of secrets) secret.fill(0); }
}

// Finish the boot recovery even when dependencies come up late. Successful
// applications are remembered, and the loop ends once all pending work is done;
// this is not a watchdog that restarts apps after they have recovered.
// The lifecycle lock still makes disable/upgrade win over a pending recovery.
export class PluginStartupRecovery {
  #service; #audit; #clock; #sleep; #closed = false; #runPromise;
  #abort = new AbortController();
  constructor({ lifecycleService, audit = async () => {}, clock = () => Date.now(),
    sleep = (ms, signal) => delay(ms, undefined, { signal, ref: false }) }) {
    this.#service = lifecycleService; this.#audit = audit; this.#clock = clock; this.#sleep = sleep;
  }
  start() { void this.run().catch(() => {}); }
  close() { this.#closed = true; this.#abort.abort(); }
  run() { return this.#runPromise ??= this.#recover(); }
  async #record(action, outcome) {
    // An unavailable audit sink must not strand otherwise recoverable apps.
    try { await this.#audit({ action, domain: "plugin", outcome, occurredAt: new Date(this.#clock()).toISOString() }); }
    catch { /* Recovery remains pending independently of diagnostics. */ }
  }
  async #recover() {
    const startedAt = this.#clock(), completed = new Set();
    let retryDelay = 5_000, waitingRecorded = false;
    for (let attempt = 1; !this.#closed; attempt++) {
      try {
        const result = await this.#service.recoverEnabledApplications({
          operationKey: `plugin-boot-${attempt}-${this.#clock()}`, completed,
          canContinue: () => !this.#closed,
        });
        if (result.pending === 0) {
          if (waitingRecorded && !this.#closed) await this.#record("plugin.boot_recovery_completed", "succeeded");
          return;
        }
      } catch { /* A dependency may not yet be listening during appliance boot. */ }
      if (this.#closed) return;
      if (!waitingRecorded && this.#clock() - startedAt >= 300_000) {
        waitingRecorded = true;
        await this.#record("plugin.boot_recovery_waiting", "failed");
      }
      if (this.#closed) return;
      try { await this.#sleep(retryDelay, this.#abort.signal); }
      catch (error) { if (this.#closed) return; throw error; }
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
  }
}
