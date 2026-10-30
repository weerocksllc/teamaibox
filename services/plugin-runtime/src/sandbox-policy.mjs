import { createHash } from "node:crypto";

const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const HOST = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/;
const SCOPE = /^[a-z][a-z0-9:._-]{2,127}$/;
const SAFE_NAME = /^[a-z][a-z0-9-]{2,127}$/;
const PLUGIN_TYPES = new Set(["ApplicationPlugin", "ComputePlugin"]);

export class PluginSandboxError extends Error {
  constructor(reasonCodes) {
    super("Plugin sandbox policy denied the runtime specification");
    this.name = "PluginSandboxError";
    this.code = "plugin_sandbox_denied";
    this.reasonCodes = Object.freeze([...new Set(reasonCodes)].sort());
  }
}

function invalid(message) {
  throw new TypeError(message);
}

function policyFacts(policy) {
  if (!policy || typeof policy !== "object" || policy.schemaVersion !== 1) invalid("sandbox policy schemaVersion must be 1");
  const runtime = policy.runtime;
  const filesystem = policy.filesystem;
  const network = policy.network;
  const devices = policy.devices;
  if (!runtime || !filesystem || !network || !devices) invalid("sandbox policy sections are required");
  if (!Number.isSafeInteger(runtime.runAsUid) || runtime.runAsUid <= 0
    || !Number.isSafeInteger(runtime.runAsGid) || runtime.runAsGid <= 0
    || runtime.readOnlyRoot !== true || runtime.dropAllCapabilities !== true
    || runtime.noNewPrivileges !== true || typeof runtime.seccompProfile !== "string") {
    invalid("sandbox non-root security baseline is invalid");
  }
  for (const field of ["maximumPids", "maximumOpenFiles", "maximumTmpfsBytes"]) {
    if (!Number.isSafeInteger(runtime[field]) || runtime[field] < 1) invalid(`sandbox ${field} is invalid`);
  }
  if (typeof filesystem.volumePrefix !== "string" || !filesystem.volumePrefix.startsWith("teamaibox-plugin-")
    || new Set([filesystem.dataTarget, filesystem.cacheTarget, filesystem.runtimeTarget]).size !== 3
    || [filesystem.dataTarget, filesystem.cacheTarget, filesystem.runtimeTarget]
      .some((target) => typeof target !== "string" || !target.startsWith("/"))) {
    invalid("sandbox filesystem namespace policy is invalid");
  }
  if (network.noneNetwork !== "none" || typeof network.applicationIngressNetwork !== "string"
    || !SAFE_NAME.test(network.applicationIngressNetwork) || typeof network.egressNetwork !== "string"
    || !SAFE_NAME.test(network.egressNetwork) || network.applicationIngressNetwork === network.egressNetwork
    || network.egressProxyOnly !== true
    || !Array.isArray(network.forbiddenHosts) || typeof network.wildcardsAllowed !== "boolean") {
    invalid("sandbox network policy is invalid");
  }
  for (const type of PLUGIN_TYPES) if (!Array.isArray(devices[type])) invalid(`sandbox device policy for ${type} is required`);
  return policy;
}

function volumeName(policy, pluginId, suffix) {
  const identity = createHash("sha256").update(pluginId, "utf8").digest("hex").slice(0, 32);
  return `${policy.filesystem.volumePrefix}${identity}-${suffix}`;
}

function normalizedHosts(manifest, policy, reasons) {
  const hosts = [...manifest.permissions.network.egressHosts].map((host) => host.toLowerCase()).sort();
  const forbidden = new Set(policy.network.forbiddenHosts.map((host) => host.toLowerCase()));
  for (const host of hosts) {
    if (!HOST.test(host) || forbidden.has(host) || (!policy.network.wildcardsAllowed && host.includes("*"))
      || host === "0.0.0.0" || host.startsWith("127.") || host === "::1" || host.startsWith("169.254.")) {
      reasons.push("network_destination_forbidden");
    }
  }
  if (manifest.permissions.network.mode === "none" && hosts.length) reasons.push("network_policy_mismatch");
  if (manifest.permissions.network.mode === "allowlist" && !hosts.length) reasons.push("network_policy_mismatch");
  return hosts;
}

function normalizedScopes(manifest, reasons) {
  const scopes = [...manifest.permissions.platformApiScopes].sort();
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !SCOPE.test(scope) || scope.includes("*") || scope.startsWith("admin:"))) {
    reasons.push("api_scope_forbidden");
  }
  return scopes;
}

function normalizedDevices(manifest, policy, reasons) {
  const declared = [...manifest.permissions.devices].sort();
  const allowed = new Set(policy.devices[manifest.type]);
  if (declared.some((device) => !allowed.has(device))) reasons.push("device_forbidden");
  if (manifest.type === "ApplicationPlugin" && declared.length) reasons.push("application_device_forbidden");
  if (declared.length && !manifest.resources.accelerator) reasons.push("device_resource_missing");
  const mapped = declared.flatMap((device) => policy.devices.runtimeMapping[device] ?? []);
  if (mapped.length < declared.length) reasons.push("device_mapping_missing");
  return [...new Set(mapped)].sort();
}

function requestedViolations(requested, declared, reasons) {
  if (!requested || typeof requested !== "object") return;
  if (requested.runAsUid === 0 || requested.runAsGid === 0 || requested.user === "root") reasons.push("root_user_forbidden");
  if (requested.privileged === true) reasons.push("privileged_forbidden");
  if (requested.hostPid === true || requested.hostIpc === true) reasons.push("host_namespace_forbidden");
  if (requested.hostNetwork === true || requested.network === "host") reasons.push("host_network_forbidden");
  if (requested.dockerSocket === true) reasons.push("docker_socket_forbidden");
  if (Array.isArray(requested.mounts) && requested.mounts.length) {
    reasons.push(requested.mounts.some((mount) => JSON.stringify(mount).toLowerCase().includes("docker.sock"))
      ? "docker_socket_forbidden" : "host_mount_forbidden");
  }
  if (Array.isArray(requested.apiScopes) && requested.apiScopes.some((scope) => !declared.scopes.includes(scope))) reasons.push("undeclared_api_scope");
  if (Array.isArray(requested.devices) && requested.devices.some((device) => !declared.devices.includes(device))) reasons.push("undeclared_device");
  if (Array.isArray(requested.egressHosts) && requested.egressHosts.some((host) => !declared.hosts.includes(String(host).toLowerCase()))) reasons.push("undeclared_network_destination");
  for (const key of Object.keys(requested)) {
    if (!new Set([
      "runAsUid", "runAsGid", "user", "privileged", "hostPid", "hostIpc",
      "hostNetwork", "network", "dockerSocket", "mounts", "apiScopes",
      "devices", "egressHosts",
    ]).has(key)) reasons.push("runtime_override_forbidden");
  }
}

function boundedAudit({ pluginId, pluginType, operationKey, reasonCodes, occurredAt }) {
  return Object.freeze({
    schemaVersion: 1,
    action: "plugin.sandbox.denied",
    pluginId,
    pluginType,
    operationKey: typeof operationKey === "string" && operationKey.length <= 128 ? operationKey : null,
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
    occurredAt,
  });
}

export class PluginSandboxPolicy {
  #policy;
  #auditSink;
  #clock;

  constructor({ policy, auditSink, clock = () => new Date() }) {
    if (!auditSink?.record) invalid("sandbox audit sink is required");
    this.#policy = policyFacts(structuredClone(policy));
    this.#auditSink = auditSink;
    this.#clock = clock;
  }

  async compile({ manifest, pluginId = manifest?.id, version, operationKey, requested = {} }) {
    if (!manifest || !PLUGIN_ID.test(pluginId ?? "") || manifest.id !== pluginId || !PLUGIN_TYPES.has(manifest.type)) {
      invalid("a valid plugin manifest identity is required for sandbox compilation");
    }
    const reasons = [];
    const hosts = normalizedHosts(manifest, this.#policy, reasons);
    const scopes = normalizedScopes(manifest, reasons);
    const devices = normalizedDevices(manifest, this.#policy, reasons);
    requestedViolations(requested, { hosts, scopes, devices }, reasons);
    if (reasons.length) {
      try {
        await this.#auditSink.record(boundedAudit({
          pluginId,
          pluginType: manifest.type,
          operationKey,
          reasonCodes: reasons,
          occurredAt: this.#clock().toISOString(),
        }));
      } catch { /* audit transport failure never converts a denial into allow */ }
      throw new PluginSandboxError(reasons);
    }
    const networkMode = manifest.permissions.network.mode;
    const noEgressApplication = manifest.type === "ApplicationPlugin" && networkMode === "none";
    const tmpfsBytes = Math.min(manifest.resources.ephemeralStorageBytes, this.#policy.runtime.maximumTmpfsBytes);
    const dataVolume = volumeName(this.#policy, pluginId, "data");
    const cacheVolume = volumeName(this.#policy, pluginId, "cache");
    return Object.freeze({
      schemaVersion: 1,
      pluginId,
      pluginType: manifest.type,
      version,
      security: Object.freeze({
        runAsUid: this.#policy.runtime.runAsUid,
        runAsGid: this.#policy.runtime.runAsGid,
        readOnlyRoot: true,
        dropAllCapabilities: true,
        noNewPrivileges: true,
        privileged: false,
        hostPid: false,
        hostIpc: false,
        hostNetwork: false,
        dockerSocket: false,
        seccompProfile: this.#policy.runtime.seccompProfile,
      }),
      filesystem: Object.freeze({
        namespace: `plugin.${pluginId}`,
        hostMounts: Object.freeze([]),
        volumes: Object.freeze([
          Object.freeze({ source: dataVolume, target: this.#policy.filesystem.dataTarget, readOnly: false, purpose: "persistent-data" }),
          Object.freeze({ source: cacheVolume, target: this.#policy.filesystem.cacheTarget, readOnly: false, purpose: "rebuildable-cache" }),
        ]),
        tmpfs: Object.freeze([
          Object.freeze({ target: "/tmp", sizeBytes: tmpfsBytes, options: "rw,noexec,nosuid,nodev" }),
          Object.freeze({ target: this.#policy.filesystem.runtimeTarget, sizeBytes: Math.min(tmpfsBytes, 67108864), options: "rw,noexec,nosuid,nodev" }),
        ]),
      }),
      network: Object.freeze({
        mode: networkMode,
        networkName: noEgressApplication
          ? this.#policy.network.applicationIngressNetwork
          : networkMode === "none" ? this.#policy.network.noneNetwork : this.#policy.network.egressNetwork,
        egressProxyOnly: true,
        allowedHosts: Object.freeze(hosts),
        policyId: networkMode === "none"
          ? ""
          : `sha256:${createHash("sha256").update(`${pluginId}\n${hosts.join("\n")}`, "utf8").digest("hex")}`,
      }),
      api: Object.freeze({
        audience: `plugin:${pluginId}`,
        scopes: Object.freeze(scopes),
        credentialMode: manifest.type === "ApplicationPlugin" ? "request-bound-delegated-user" : "projected-scheduler-file",
        permanentCredentials: false,
      }),
      devices: Object.freeze(devices),
      limits: Object.freeze({
        memoryBytes: manifest.resources.unifiedMemoryBytes,
        cpuRequestMillicores: manifest.resources.cpu.requestMillicores,
        cpuLimitMillicores: manifest.resources.cpu.limitMillicores,
        pidsLimit: this.#policy.runtime.maximumPids,
        openFilesLimit: this.#policy.runtime.maximumOpenFiles,
      }),
    });
  }
}
