import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { generateSourceClientConfig, sourceClientEnvironment } from "./source-client-config.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE = /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/;
const HOST = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/;
const OPENCODE_ENVIRONMENT = Object.freeze({
  XDG_CONFIG_HOME: "/run/teamaibox/xdg-config",
  OPENCODE_CONFIG: "/run/teamaibox/xdg-config/opencode/opencode.json",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_AUTO_SHARE: "false",
  OPENCODE_PURE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
  OPENCODE_PERMISSION: '{"*":"ask"}',
});

function requireInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Agent sandbox ${name} is invalid`);
  return value;
}

function validatePolicy(policy) {
  if (!policy || policy.schemaVersion !== 1 || policy.policyId !== "official-agent-sandbox.v1") throw new TypeError("Agent sandbox policy is invalid");
  const { runtime, filesystem, network, devices, gateways, opencode } = policy;
  if (!runtime || !filesystem || !network || !devices || !gateways || !opencode
    || runtime.runAsUid <= 0 || runtime.runAsGid <= 0 || runtime.readOnlyRoot !== true
    || runtime.dropAllCapabilities !== true || runtime.noNewPrivileges !== true
    || runtime.seccompProfile !== "builtin" || filesystem.workspaceTarget !== "/workspace"
    || filesystem.hostMountsAllowed !== false || filesystem.dockerSocketAllowed !== false
    || filesystem.crossUserVolumesAllowed !== false || devices.directGpuAllowed !== false
    || devices.allowed.length !== 0 || network.networkName !== "agent-egress-proxy"
    || network.wildcardsAllowed !== false || !Array.isArray(network.requiredHosts)
    || !Array.isArray(network.forbiddenHosts) || !Array.isArray(opencode.command)
    || opencode.disableAutoUpdate !== true || opencode.disableShare !== true
    || opencode.configTarget !== "/run/teamaibox/xdg-config/opencode/opencode.json"
    || !Array.isArray(opencode.approvedPlugins) || opencode.approvedPlugins.length !== 0
    || !opencode.environment
    || Object.keys(opencode.environment).length !== Object.keys(OPENCODE_ENVIRONMENT).length
    || Object.entries(OPENCODE_ENVIRONMENT).some(([name, value]) => opencode.environment[name] !== value)) {
    throw new TypeError("Agent sandbox security policy is incomplete");
  }
  for (const [name, value] of Object.entries(gateways)) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !network.requiredHosts.includes(url.hostname) || url.username || url.password || url.hash) {
      throw new TypeError(`Agent sandbox ${name} gateway is invalid`);
    }
  }
  generateSourceClientConfig(gateways);
  for (const prefix of ["MemoryBytes", "CpuQuotaMicros", "PidsLimit", "EphemeralBytes", "OpenFilesLimit"]) {
    requireInteger(runtime[`default${prefix}`], 1, runtime[`maximum${prefix}`], `default ${prefix}`);
  }
  requireInteger(runtime.idleTimeoutSeconds, 30, 86_400, "idle timeout");
  requireInteger(filesystem.defaultWorkspaceQuotaBytes, 1, filesystem.maximumWorkspaceQuotaBytes, "workspace quota");
  return structuredClone(policy);
}

function validateEgressPolicy(policy, sandboxPolicy) {
  if (!policy || policy.schemaVersion !== 1 || policy.policyId !== "official-agent-egress.v1"
    || !Number.isSafeInteger(policy.revision) || policy.revision < 1
    || policy.packageRepositories?.enabled !== true || policy.packageRepositories.mode !== "internal-only"
    || policy.packageRepositories.gatewayHost !== "source-gateway" || policy.packageRepositories.exposeUpstreamCredentials !== false
    || typeof policy.generalInternet?.enabled !== "boolean" || policy.generalInternet.proxyHost !== "agent-egress-gateway"
    || policy.generalInternet.proxyUrl !== "http://agent-egress-gateway:8080" || !Array.isArray(policy.generalInternet.allowedHosts)) {
    throw new TypeError("Agent administrator egress policy is invalid");
  }
  const allowed = policy.generalInternet.allowedHosts.map((value) => String(value).toLowerCase());
  if (new Set(allowed).size !== allowed.length || !allowed.every((host) => HOST.test(host) && !host.includes("*"))
    || JSON.stringify(allowed) !== JSON.stringify([...allowed].sort())
    || sandboxPolicy.network.forbiddenHosts.some((host) => allowed.includes(host.toLowerCase()))
    || (!policy.generalInternet.enabled && allowed.length > 0)) {
    throw new TypeError("Agent administrator Internet allowlist is invalid");
  }
  return structuredClone(policy);
}

function identity(ownerIdentityId, policy) {
  if (typeof ownerIdentityId !== "string" || !UUID.test(ownerIdentityId)) {
    throw new PlatformError("agent_sandbox_owner_invalid", "Agent sandbox owner identity is invalid", { status: 400 });
  }
  const digest = createHash("sha256").update(ownerIdentityId).digest("hex").slice(0, 32);
  return Object.freeze({
    sandboxKey: `sandbox.${digest}`,
    workspaceKey: `workspace.${digest}`,
    workspaceVolume: `${policy.filesystem.workspaceVolumePrefix}${digest}${policy.filesystem.workspaceVolumeSuffix}`,
  });
}

function hosts(input, policy, egressPolicy) {
  if (!Array.isArray(input)) throw new PlatformError("agent_sandbox_network_invalid", "Agent sandbox network declaration is invalid", { status: 400 });
  const requested = [...new Set(input.map((host) => String(host).toLowerCase()))].sort();
  const allowedInternet = new Set(egressPolicy.generalInternet.allowedHosts);
  if ((!egressPolicy.generalInternet.enabled && requested.length > 0) || requested.some((host) => !allowedInternet.has(host))) {
    throw new PlatformError("agent_sandbox_internet_denied", "Agent Internet destination is not enabled by the administrator", { status: 403 });
  }
  const proxy = requested.length > 0 ? [egressPolicy.generalInternet.proxyHost] : [];
  const values = [...new Set([...policy.network.requiredHosts, ...proxy, ...requested])].sort();
  const forbidden = new Set(policy.network.forbiddenHosts.map((host) => host.toLowerCase()));
  if (values.some((host) => !HOST.test(host) || forbidden.has(host) || host.includes("*")
    || host.startsWith("127.") || host.startsWith("169.254.") || host === "0.0.0.0" || host === "::1")) {
    throw new PlatformError("agent_sandbox_network_invalid", "Agent sandbox network destination is forbidden", { status: 400 });
  }
  return values;
}

function overrides(value) {
  if (!value || typeof value !== "object") return;
  const forbidden = ["runAsUid", "runAsGid", "privileged", "hostPid", "hostIpc", "hostNetwork", "dockerSocket", "mounts", "devices", "seccompProfile"];
  if (forbidden.some((key) => Object.hasOwn(value, key))) {
    throw new PlatformError("agent_sandbox_override_denied", "Agent sandbox security overrides are forbidden", { status: 403 });
  }
}

export class AgentSandboxPolicy {
  #policy;
  #egressPolicy;

  constructor({ policy, egressPolicy }) {
    this.#policy = validatePolicy(policy);
    this.#egressPolicy = validateEgressPolicy(egressPolicy, this.#policy);
  }

  identity(ownerIdentityId) {
    return identity(ownerIdentityId, this.#policy);
  }

  get idleTimeoutMs() {
    return this.#policy.runtime.idleTimeoutSeconds * 1000;
  }

  compile({ ownerIdentityId, workerId, image, egressHosts = [], limits = {}, requested = {} }) {
    if (typeof workerId !== "string" || !UUID.test(workerId) || typeof image !== "string" || !IMAGE.test(image)) {
      throw new PlatformError("agent_sandbox_runtime_invalid", "Agent sandbox runtime identity is invalid", { status: 400 });
    }
    overrides(requested);
    const owner = identity(ownerIdentityId, this.#policy);
    const allowedHosts = hosts(egressHosts, this.#policy, this.#egressPolicy);
    const runtime = this.#policy.runtime;
    const filesystem = this.#policy.filesystem;
    const resolvedLimits = Object.freeze({
      memoryBytes: requireInteger(limits.memoryBytes ?? runtime.defaultMemoryBytes, 64 * 1024 * 1024, runtime.maximumMemoryBytes, "memory limit"),
      cpuQuotaMicros: requireInteger(limits.cpuQuotaMicros ?? runtime.defaultCpuQuotaMicros, 1000, runtime.maximumCpuQuotaMicros, "CPU limit"),
      pidsLimit: requireInteger(limits.pidsLimit ?? runtime.defaultPidsLimit, 1, runtime.maximumPidsLimit, "process limit"),
      ephemeralBytes: requireInteger(limits.ephemeralBytes ?? runtime.defaultEphemeralBytes, 1, runtime.maximumEphemeralBytes, "ephemeral disk limit"),
      openFilesLimit: requireInteger(limits.openFilesLimit ?? runtime.defaultOpenFilesLimit, 64, runtime.maximumOpenFilesLimit, "open file limit"),
      workspaceQuotaBytes: requireInteger(limits.workspaceQuotaBytes ?? filesystem.defaultWorkspaceQuotaBytes, 1, filesystem.maximumWorkspaceQuotaBytes, "workspace quota"),
    });
    const networkPolicyId = `sha256:${createHash("sha256").update(`${ownerIdentityId}\n${allowedHosts.join("\n")}`).digest("hex")}`;
    const internetEnabled = egressHosts.length > 0;
    const sourceClientConfig = generateSourceClientConfig(this.#policy.gateways);
    const sourceEnvironment = sourceClientEnvironment(this.#policy.gateways);
    const nodeSpec = Object.freeze({
        workerId,
        ownerIdentityId,
        sandboxKey: owner.sandboxKey,
        attemptId: "",
        modelProfileId: "",
        workloadKind: "agent-sandbox",
        pluginId: "",
        image,
        network: this.#policy.network.networkName,
        networkPolicyId,
        apiScopes: Object.freeze([]),
        egressHosts: Object.freeze(allowedHosts),
        limits: Object.freeze({
          memoryBytes: resolvedLimits.memoryBytes,
          cpuQuotaMicros: resolvedLimits.cpuQuotaMicros,
          pidsLimit: resolvedLimits.pidsLimit,
          ephemeralBytes: resolvedLimits.ephemeralBytes,
          workspaceQuotaBytes: resolvedLimits.workspaceQuotaBytes,
          openFilesLimit: resolvedLimits.openFilesLimit,
        }),
        security: Object.freeze({
          runAsUid: runtime.runAsUid,
          runAsGid: runtime.runAsGid,
          readOnlyRoot: true,
          dropAllCapabilities: true,
          noNewPrivileges: true,
          privileged: false,
          hostPid: false,
          hostIpc: false,
          hostNetwork: false,
          dockerSocket: false,
          seccompProfile: runtime.seccompProfile,
        }),
        mounts: Object.freeze([{ type: "volume", source: owner.workspaceVolume, target: filesystem.workspaceTarget, readOnly: false }]),
        devices: Object.freeze([]),
        environment: Object.freeze({
          TEAMAIBOX_SANDBOX_KEY: owner.sandboxKey,
          TEAMAIBOX_COMPUTE_GATEWAY_URL: this.#policy.gateways.compute,
          ...sourceEnvironment,
          ...(internetEnabled ? {
            HTTP_PROXY: this.#egressPolicy.generalInternet.proxyUrl,
            HTTPS_PROXY: this.#egressPolicy.generalInternet.proxyUrl,
            NO_PROXY: "compute-gateway,source-gateway",
          } : {}),
          HOME: "/workspace/.teamaibox/home",
          XDG_CONFIG_HOME: this.#policy.opencode.environment.XDG_CONFIG_HOME,
          XDG_DATA_HOME: "/workspace/.teamaibox/data",
          XDG_CACHE_HOME: "/workspace/.teamaibox/cache",
          ...this.#policy.opencode.environment,
        }),
        command: Object.freeze([...this.#policy.opencode.command]),
        healthCommand: Object.freeze([]),
      });
    return Object.freeze({
      schemaVersion: 1,
      identity: owner,
      workspaceQuotaBytes: resolvedLimits.workspaceQuotaBytes,
      runtimeFingerprint: `sha256:${createHash("sha256").update(JSON.stringify({ nodeSpec, sourceClientConfig, egressPolicyRevision: this.#egressPolicy.revision, workspaceQuotaBytes: resolvedLimits.workspaceQuotaBytes })).digest("hex")}`,
      nodeSpec,
      sourceClientConfig,
      egressPolicyRevision: this.#egressPolicy.revision,
    });
  }
}
