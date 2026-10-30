import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function publicPlugin(plugin) {
  return Object.freeze({
    pluginId: plugin.pluginId,
    pluginType: plugin.pluginType,
    publisherId: plugin.publisherId,
    protectedOfficial: plugin.protectedOfficial === true,
    lifecycleState: plugin.lifecycleState,
    currentVersion: plugin.currentVersion,
    activeSlot: plugin.activeSlot,
    generation: plugin.generation,
    dataRetentionState: plugin.data?.retentionState ?? null,
    versions: Object.freeze(Object.values(plugin.versions ?? {}).map((version) => Object.freeze({
      version: version.version,
      installState: version.installState,
      slot: version.slot,
      health: version.health ? Object.freeze(structuredClone(version.health)) : null,
      activatedAt: version.activatedAt ?? null,
      retiredAt: version.retiredAt ?? null,
      failedAt: version.failedAt ?? null,
    })).sort((left, right) => left.version.localeCompare(right.version))),
    updatedAt: plugin.updatedAt ?? null,
  });
}

function publicImport(item) {
  return Object.freeze({
    schemaVersion: item.schemaVersion,
    pluginId: item.pluginId,
    pluginType: item.pluginType,
    version: item.version,
    sourceKind: item.sourceKind,
    manifestPayloadDigest: item.manifestPayloadDigest,
    bundlePayloadDigest: item.bundlePayloadDigest,
    imageDigests: Object.freeze([...(item.imageDigests ?? [])]),
    supplyChain: Object.freeze(structuredClone(item.supplyChain ?? {})),
    state: item.state,
    verifiedAt: item.verifiedAt,
  });
}

function requireIdentity(context) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
  return identityId;
}

function requirePermission(context, permission) {
  const identityId = requireIdentity(context);
  if (!context.permissions?.includes(permission)) {
    throw new PlatformError("access_denied", "Plugin administration permission is required", { status: 403 });
  }
  return identityId;
}

function validateLifecycleInput(pluginId, operationKey, version = null) {
  if (!PLUGIN_ID.test(pluginId ?? "") || !OPERATION_KEY.test(operationKey ?? "") || (version !== null && !SEMVER.test(version ?? ""))) {
    throw new PlatformError("plugin_request_invalid", "Plugin lifecycle request is invalid", { status: 400 });
  }
}

export class PluginAdministrationService {
  #imports;
  #lifecycleRepository;
  #importService;
  #lifecycleService;
  #audit;

  constructor({ imports, lifecycleRepository, importService, lifecycleService, audit = async () => {} }) {
    if (!imports?.list || !lifecycleRepository?.listPlugins || !importService || !lifecycleService || typeof audit !== "function") {
      throw new TypeError("Plugin administration dependencies are incomplete");
    }
    this.#imports = imports;
    this.#lifecycleRepository = lifecycleRepository;
    this.#importService = importService;
    this.#lifecycleService = lifecycleService;
    this.#audit = audit;
  }

  async overview({ context }) {
    requirePermission(context, "plugin:view");
    const [imports, plugins] = await Promise.all([this.#imports.list(), this.#lifecycleRepository.listPlugins()]);
    return Object.freeze({
      object: "plugin_administration",
      architecture: "linux/arm64/v8",
      supportedPluginTypes: Object.freeze(["ApplicationPlugin", "ComputePlugin"]),
      supportedSources: Object.freeze(["marketplace", "private-registry", "offline-bundle"]),
      imports: Object.freeze(imports.map(publicImport)),
      plugins: Object.freeze(plugins.filter(Boolean).map(publicPlugin)),
    });
  }

  async importPlugin({ context, sourceKind, pluginId = null, version = null, reference = null, bundleId = null, expectedBundleDigest = null }) {
    const actorIdentityId = requirePermission(context, "plugin:manage");
    let action;
    try {
      if (sourceKind === "marketplace") {
        if (!PLUGIN_ID.test(pluginId ?? "") || !SEMVER.test(version ?? "")) throw new PlatformError("plugin_request_invalid", "Marketplace plugin identity is invalid", { status: 400 });
        action = () => this.#importService.importFromMarketplace({ pluginId, version });
      } else if (sourceKind === "private-registry") {
        if (typeof reference !== "string" || reference.length < 8 || reference.length > 512 || /[\u0000-\u001f\u007f]/u.test(reference)) throw new PlatformError("plugin_request_invalid", "Private registry reference is invalid", { status: 400 });
        action = () => this.#importService.importFromPrivateRegistry({ reference });
      } else if (sourceKind === "offline-bundle") {
        if (typeof bundleId !== "string" || bundleId.length < 8 || bundleId.length > 256 || !SHA256.test(expectedBundleDigest ?? "")) throw new PlatformError("plugin_request_invalid", "Offline bundle identity and checksum are required", { status: 400 });
        action = () => this.#importService.importOfflineBundle({ bundleId, expectedBundleDigest });
      } else throw new PlatformError("plugin_source_invalid", "Plugin source is invalid", { status: 400 });
      const imported = await action();
      await this.#audit({ action: "plugin.imported", actorIdentityId, pluginId: imported.pluginId, version: imported.version,
        sourceKind, state: imported.state, bundlePayloadDigest: imported.bundlePayloadDigest, outcome: "succeeded" });
      return publicImport(imported);
    } catch (error) {
      await this.#audit({ action: "plugin.import_failed", actorIdentityId, pluginId: PLUGIN_ID.test(pluginId ?? "") ? pluginId : "plugin.import",
        sourceKind: typeof sourceKind === "string" ? sourceKind : "invalid", reasonCode: error.code ?? "failed", outcome: error.status === 403 ? "denied" : "failed" });
      throw error;
    }
  }

  async lifecycle({ context, pluginId, operation, version = null, operationKey, purgeData = false }) {
    requirePermission(context, "plugin:manage");
    validateLifecycleInput(pluginId, operationKey, new Set(["install", "upgrade"]).has(operation) ? version : null);
    const input = { context, pluginId, operationKey };
    if (operation === "install") return this.#lifecycleService.install({ ...input, version });
    if (operation === "upgrade") return this.#lifecycleService.upgrade({ ...input, version });
    if (operation === "enable") return this.#lifecycleService.enable(input);
    if (operation === "disable") return this.#lifecycleService.disable(input);
    if (operation === "uninstall") return this.#lifecycleService.uninstall({ ...input, purgeData });
    throw new PlatformError("plugin_operation_invalid", "Plugin lifecycle operation is invalid", { status: 400 });
  }
}
