import { createHash } from "node:crypto";

const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const SAFE_NAME = /^[a-z][a-z0-9-]{2,63}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const VERSION_RANGE = /^(?:[><=~^]{1,2}[0-9]+\.[0-9]+\.[0-9]+)(?: (?:[><=~^]{1,2}[0-9]+\.[0-9]+\.[0-9]+))*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HTTP_PATH = /^\/[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,254}$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const LOCALE_KEY = /^[a-z][a-z0-9-]{1,63}(?:\.[a-z][a-z0-9-]{1,63})+$/;
const API_NAME = /^[a-z][a-z0-9.-]{2,127}$/;
const SCOPE = /^[a-z][a-z0-9:._-]{2,127}$/;
const MIGRATION_ID = /^[0-9]{6}_[a-z][a-z0-9_]{2,63}$/;
const OCI_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]+$/;
const KEY_ID = /^[a-z][a-z0-9.-]{2,127}\/[a-zA-Z0-9._:-]{1,128}$/;
const HOST_PATTERN = /^[a-zA-Z0-9*][a-zA-Z0-9.*-]{0,252}$/;

const TOP_LEVEL_KEYS = new Set([
  "apiVersion", "id", "type", "version", "official", "publisher",
  "architectures", "images", "entryPoints", "apis", "ui",
  "localization", "themes", "permissions", "resources", "health",
  "migrations", "compatibility", "signature", "extensions",
]);
const PLUGIN_TYPES = new Set(["ApplicationPlugin", "ComputePlugin"]);
const IMAGE_ROLES = new Set(["application", "worker", "migration", "sidecar"]);
const CATEGORIES = new Set(["collaboration", "ai-application", "professional-tool", "infrastructure"]);
const DEVICE_SCOPES = new Set(["accelerator", "video-codec", "audio"]);
const ACCELERATOR_KINDS = new Set(["nvidia-gpu", "nvidia-video-codec"]);
const PLATFORM_LOCALES = Object.freeze(["zh-CN", "en"]);
const PLATFORM_THEMES = Object.freeze(["light", "dark"]);

export class PluginManifestError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = "PluginManifestError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new PluginManifestError(code, path, message);
}

function record(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", path, "must be an object");
  }
  return value;
}

function exactKeys(value, allowed, required, path) {
  const object = record(value, path);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) fail("unknown_field", `${path}.${unknown[0]}`, "is not declared by manifest v1");
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail("missing_field", `${path}.${key}`, "is required");
  }
  return object;
}

function string(value, pattern, path, { min = 1, max = 2048 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    fail("invalid_value", path, "has an invalid string value");
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== "boolean") fail("invalid_type", path, "must be a boolean");
  return value;
}

function integer(value, path, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_value", path, `must be an integer from ${min} through ${max}`);
  }
  return value;
}

function finiteNumber(value, path, minExclusive, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= minExclusive || value > max) {
    fail("invalid_value", path, `must be greater than ${minExclusive} and no greater than ${max}`);
  }
  return value;
}

function array(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("invalid_value", path, `must contain from ${min} through ${max} items`);
  }
  return value;
}

function uniqueStrings(value, path, { min = 0, max = 128, pattern, allowed } = {}) {
  const values = array(value, path, min, max);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const item = string(values[index], pattern, `${path}[${index}]`, { max: 512 });
    if (allowed && !allowed.has(item)) fail("invalid_value", `${path}[${index}]`, "is not supported");
    if (seen.has(item)) fail("duplicate_value", `${path}[${index}]`, "must be unique");
    seen.add(item);
  }
  return values;
}

function enumValue(value, allowed, path) {
  if (!allowed.has(value)) fail("invalid_value", path, "is not supported");
  return value;
}

function validatePublisher(value) {
  const publisher = exactKeys(value, new Set(["id", "displayName", "website"]), new Set(["id", "displayName"]), "$.publisher");
  string(publisher.id, PLUGIN_ID, "$.publisher.id", { max: 128 });
  string(publisher.displayName, null, "$.publisher.displayName", { max: 128 });
  if (publisher.website !== undefined) {
    const website = string(publisher.website, null, "$.publisher.website", { max: 2048 });
    let parsed;
    try { parsed = new URL(website); } catch { fail("invalid_value", "$.publisher.website", "must be an absolute HTTP(S) URL"); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      fail("invalid_value", "$.publisher.website", "must use HTTP or HTTPS");
    }
  }
}

function validateImages(value, pluginType) {
  const images = array(value, "$.images", 1, 32);
  const names = new Set();
  const roles = new Set();
  const rolesByName = new Map();
  for (let index = 0; index < images.length; index += 1) {
    const path = `$.images[${index}]`;
    const image = exactKeys(images[index], new Set(["name", "role", "variants"]), new Set(["name", "role", "variants"]), path);
    const name = string(image.name, SAFE_NAME, `${path}.name`, { max: 64 });
    if (names.has(name)) fail("duplicate_value", `${path}.name`, "image names must be unique");
    names.add(name);
    const role = enumValue(image.role, IMAGE_ROLES, `${path}.role`);
    roles.add(role);
    rolesByName.set(name, role);
    const variants = array(image.variants, `${path}.variants`, 1, 8);
    const architectures = new Set();
    for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
      const variantPath = `${path}.variants[${variantIndex}]`;
      const variant = exactKeys(
        variants[variantIndex],
        new Set(["architecture", "reference", "digest", "mediaType"]),
        new Set(["architecture", "reference", "digest", "mediaType"]),
        variantPath,
      );
      if (variant.architecture !== "linux/arm64/v8") fail("architecture_unsupported", `${variantPath}.architecture`, "must provide the Spark ARM64 variant");
      if (architectures.has(variant.architecture)) fail("duplicate_value", `${variantPath}.architecture`, "each image architecture must be unique");
      architectures.add(variant.architecture);
      string(variant.reference, OCI_REFERENCE, `${variantPath}.reference`, { min: 3, max: 512 });
      string(variant.digest, SHA256, `${variantPath}.digest`, { min: 71, max: 71 });
      if (variant.mediaType !== "application/vnd.oci.image.manifest.v1+json") {
        fail("invalid_value", `${variantPath}.mediaType`, "must identify a pinned OCI image manifest");
      }
    }
  }
  const primaryRole = pluginType === "ApplicationPlugin" ? "application" : "worker";
  const forbiddenRole = pluginType === "ApplicationPlugin" ? "worker" : "application";
  if (!roles.has(primaryRole)) fail("missing_image_role", "$.images", `must include a ${primaryRole} image`);
  if (roles.has(forbiddenRole)) fail("plugin_type_mismatch", "$.images", `${forbiddenRole} images do not belong to ${pluginType}`);
  return { names, roles, rolesByName };
}

function validateEntryPoints(value, pluginType) {
  const entryPoints = exactKeys(value, new Set(["web", "worker"]), new Set(), "$.entryPoints");
  if (pluginType === "ApplicationPlugin") {
    if (!entryPoints.web || entryPoints.worker !== undefined) fail("plugin_type_mismatch", "$.entryPoints", "ApplicationPlugin must declare only a Web entry point");
    const web = exactKeys(entryPoints.web, new Set(["path", "integration"]), new Set(["path", "integration"]), "$.entryPoints.web");
    string(web.path, HTTP_PATH, "$.entryPoints.web.path", { max: 255 });
    enumValue(web.integration, new Set(["iframe", "module"]), "$.entryPoints.web.integration");
  } else {
    if (!entryPoints.worker || entryPoints.web !== undefined) fail("plugin_type_mismatch", "$.entryPoints", "ComputePlugin must declare only a scheduler worker entry point");
    const worker = exactKeys(entryPoints.worker, new Set(["protocol", "capabilityRegistration"]), new Set(["protocol", "capabilityRegistration"]), "$.entryPoints.worker");
    if (worker.protocol !== "teamaibox.worker-control/v1" || worker.capabilityRegistration !== "scheduler-only") {
      fail("invalid_value", "$.entryPoints.worker", "must use worker-control/v1 and scheduler-only registration");
    }
  }
}

function validateApis(value, pluginType) {
  const apis = array(value, "$.apis", 1, 64);
  const names = new Set();
  const expectedAccess = pluginType === "ApplicationPlugin" ? "delegated-user" : "scheduler";
  for (let index = 0; index < apis.length; index += 1) {
    const path = `$.apis[${index}]`;
    const api = exactKeys(apis[index], new Set(["name", "versionRange", "access"]), new Set(["name", "versionRange", "access"]), path);
    const name = string(api.name, API_NAME, `${path}.name`, { max: 128 });
    if (names.has(name)) fail("duplicate_value", `${path}.name`, "API names must be unique");
    names.add(name);
    string(api.versionRange, VERSION_RANGE, `${path}.versionRange`, { max: 128 });
    if (api.access !== expectedAccess) fail("plugin_type_mismatch", `${path}.access`, `${pluginType} APIs must use ${expectedAccess} access`);
  }
}

function validateUi(value, pluginType) {
  const ui = exactKeys(
    value,
    new Set(["displayNameKey", "summaryKey", "icon", "category", "launchPath", "order"]),
    new Set(["displayNameKey", "summaryKey", "icon", "category"]),
    "$.ui",
  );
  string(ui.displayNameKey, LOCALE_KEY, "$.ui.displayNameKey", { max: 128 });
  string(ui.summaryKey, LOCALE_KEY, "$.ui.summaryKey", { max: 128 });
  string(ui.icon, /^[a-z][a-z0-9-]{1,63}$/, "$.ui.icon", { min: 2, max: 64 });
  enumValue(ui.category, CATEGORIES, "$.ui.category");
  if (pluginType === "ApplicationPlugin") string(ui.launchPath, HTTP_PATH, "$.ui.launchPath", { max: 255 });
  else if (ui.launchPath !== undefined) fail("plugin_type_mismatch", "$.ui.launchPath", "ComputePlugin cannot expose a user launch route");
  if (ui.order !== undefined) integer(ui.order, "$.ui.order", 0, 10000);
}

function validateLocalization(value, official) {
  const localization = exactKeys(
    value,
    new Set(["supportedLocales", "fallbackLocale", "supportedDirections", "rtlReady"]),
    new Set(["supportedLocales", "fallbackLocale", "supportedDirections", "rtlReady"]),
    "$.localization",
  );
  const locales = uniqueStrings(localization.supportedLocales, "$.localization.supportedLocales", { min: 1, max: 64, pattern: LOCALE });
  string(localization.fallbackLocale, LOCALE, "$.localization.fallbackLocale", { max: 16 });
  if (!locales.includes(localization.fallbackLocale)) fail("invalid_fallback", "$.localization.fallbackLocale", "must be one of supportedLocales");
  const directions = uniqueStrings(localization.supportedDirections, "$.localization.supportedDirections", { min: 1, max: 2, allowed: new Set(["ltr", "rtl"]) });
  boolean(localization.rtlReady, "$.localization.rtlReady");
  if (localization.rtlReady !== directions.includes("rtl")) fail("direction_mismatch", "$.localization.rtlReady", "must exactly reflect RTL direction support");
  if (!directions.includes("ltr")) fail("direction_mismatch", "$.localization.supportedDirections", "must include ltr for initial platform locales");
  if (official) {
    for (const locale of PLATFORM_LOCALES) {
      if (!locales.includes(locale)) fail("official_compatibility_missing", "$.localization.supportedLocales", `official plugins must support ${locale}`);
    }
  }
}

function validateThemes(value, official) {
  const themes = exactKeys(value, new Set(["supported", "usesSemanticTokens", "livePreferenceEvents"]), new Set(["supported", "usesSemanticTokens", "livePreferenceEvents"]), "$.themes");
  const supported = uniqueStrings(themes.supported, "$.themes.supported", { min: 1, max: 2, allowed: new Set(PLATFORM_THEMES) });
  boolean(themes.usesSemanticTokens, "$.themes.usesSemanticTokens");
  boolean(themes.livePreferenceEvents, "$.themes.livePreferenceEvents");
  if (!themes.usesSemanticTokens) fail("theme_contract_missing", "$.themes.usesSemanticTokens", "plugin surfaces must use semantic platform tokens");
  if (official) {
    for (const theme of PLATFORM_THEMES) {
      if (!supported.includes(theme)) fail("official_compatibility_missing", "$.themes.supported", `official plugins must support ${theme}`);
    }
    if (!themes.livePreferenceEvents) fail("official_compatibility_missing", "$.themes.livePreferenceEvents", "official plugins must follow live preference changes");
  }
}

function validatePermissions(value, pluginType) {
  const permissions = exactKeys(
    value,
    new Set(["platformApiScopes", "delegatedUserToken", "network", "objectNamespaces", "devices"]),
    new Set(["platformApiScopes", "delegatedUserToken", "network", "objectNamespaces", "devices"]),
    "$.permissions",
  );
  uniqueStrings(permissions.platformApiScopes, "$.permissions.platformApiScopes", { max: 128, pattern: SCOPE });
  boolean(permissions.delegatedUserToken, "$.permissions.delegatedUserToken");
  if (permissions.delegatedUserToken !== (pluginType === "ApplicationPlugin")) {
    fail("plugin_type_mismatch", "$.permissions.delegatedUserToken", "must be enabled only for ApplicationPlugin");
  }
  const network = exactKeys(permissions.network, new Set(["mode", "egressHosts"]), new Set(["mode", "egressHosts"]), "$.permissions.network");
  enumValue(network.mode, new Set(["none", "allowlist"]), "$.permissions.network.mode");
  const hosts = uniqueStrings(network.egressHosts, "$.permissions.network.egressHosts", { max: 128, pattern: HOST_PATTERN });
  if ((network.mode === "none") !== (hosts.length === 0)) fail("network_policy_mismatch", "$.permissions.network", "none requires an empty list and allowlist requires at least one host");
  uniqueStrings(permissions.objectNamespaces, "$.permissions.objectNamespaces", { max: 64, pattern: SCOPE });
  const devices = uniqueStrings(permissions.devices, "$.permissions.devices", { max: 8, allowed: DEVICE_SCOPES });
  if (pluginType === "ApplicationPlugin" && devices.length) fail("plugin_type_mismatch", "$.permissions.devices", "ApplicationPlugin cannot request direct device access");
}

function validateResources(value, pluginType) {
  const resources = exactKeys(
    value,
    new Set(["cpu", "unifiedMemoryBytes", "ephemeralStorageBytes", "persistentStorageBytes", "network", "accelerator"]),
    new Set(["cpu", "unifiedMemoryBytes", "ephemeralStorageBytes", "persistentStorageBytes", "network"]),
    "$.resources",
  );
  const cpu = exactKeys(resources.cpu, new Set(["requestMillicores", "limitMillicores"]), new Set(["requestMillicores", "limitMillicores"]), "$.resources.cpu");
  integer(cpu.requestMillicores, "$.resources.cpu.requestMillicores", 1, 1000000);
  integer(cpu.limitMillicores, "$.resources.cpu.limitMillicores", 1, 1000000);
  if (cpu.limitMillicores < cpu.requestMillicores) fail("resource_envelope_invalid", "$.resources.cpu.limitMillicores", "cannot be below the CPU request");
  integer(resources.unifiedMemoryBytes, "$.resources.unifiedMemoryBytes", 16777216);
  integer(resources.ephemeralStorageBytes, "$.resources.ephemeralStorageBytes", 0);
  integer(resources.persistentStorageBytes, "$.resources.persistentStorageBytes", 0);
  const network = exactKeys(resources.network, new Set(["ingressBitsPerSecond", "egressBitsPerSecond"]), new Set(["ingressBitsPerSecond", "egressBitsPerSecond"]), "$.resources.network");
  integer(network.ingressBitsPerSecond, "$.resources.network.ingressBitsPerSecond", 0);
  integer(network.egressBitsPerSecond, "$.resources.network.egressBitsPerSecond", 0);
  if (resources.accelerator !== undefined) {
    if (pluginType !== "ComputePlugin") fail("plugin_type_mismatch", "$.resources.accelerator", "only ComputePlugin can declare accelerator resources");
    const accelerator = exactKeys(resources.accelerator, new Set(["kind", "units"]), new Set(["kind", "units"]), "$.resources.accelerator");
    enumValue(accelerator.kind, ACCELERATOR_KINDS, "$.resources.accelerator.kind");
    finiteNumber(accelerator.units, "$.resources.accelerator.units", 0, 128);
  }
}

function validateProbe(value, path) {
  const probe = exactKeys(value, new Set(["path", "intervalSeconds", "timeoutSeconds", "failureThreshold"]), new Set(["path", "intervalSeconds", "timeoutSeconds", "failureThreshold"]), path);
  string(probe.path, HTTP_PATH, `${path}.path`, { max: 255 });
  integer(probe.intervalSeconds, `${path}.intervalSeconds`, 1, 300);
  integer(probe.timeoutSeconds, `${path}.timeoutSeconds`, 1, 60);
  integer(probe.failureThreshold, `${path}.failureThreshold`, 1, 20);
  if (probe.timeoutSeconds > probe.intervalSeconds) fail("health_probe_invalid", `${path}.timeoutSeconds`, "cannot exceed the probe interval");
}

function validateHealth(value) {
  const health = exactKeys(value, new Set(["startup", "readiness", "liveness"]), new Set(["startup", "readiness", "liveness"]), "$.health");
  for (const probe of ["startup", "readiness", "liveness"]) validateProbe(health[probe], `$.health.${probe}`);
}

function validateMigrations(value, imageFacts) {
  const migrations = array(value, "$.migrations", 0, 256);
  const ids = new Set();
  for (let index = 0; index < migrations.length; index += 1) {
    const path = `$.migrations[${index}]`;
    const migration = exactKeys(migrations[index], new Set(["id", "fromVersion", "toVersion", "imageName", "transactional", "reversible"]), new Set(["id", "fromVersion", "toVersion", "imageName", "transactional", "reversible"]), path);
    const id = string(migration.id, MIGRATION_ID, `${path}.id`, { max: 71 });
    if (ids.has(id)) fail("duplicate_value", `${path}.id`, "migration IDs must be unique");
    ids.add(id);
    string(migration.fromVersion, SEMVER, `${path}.fromVersion`, { max: 128 });
    string(migration.toVersion, SEMVER, `${path}.toVersion`, { max: 128 });
    if (migration.fromVersion === migration.toVersion) fail("migration_invalid", path, "migration versions must differ");
    const imageName = string(migration.imageName, SAFE_NAME, `${path}.imageName`, { max: 64 });
    if (!imageFacts.names.has(imageName)) fail("migration_invalid", `${path}.imageName`, "must reference an image declared by this manifest");
    if (imageFacts.rolesByName.get(imageName) !== "migration") fail("migration_invalid", `${path}.imageName`, "must reference an image with the migration role");
    boolean(migration.transactional, `${path}.transactional`);
    boolean(migration.reversible, `${path}.reversible`);
  }
  if (migrations.length && !imageFacts.roles.has("migration")) fail("migration_invalid", "$.images", "migrations require an image with the migration role");
}

function validateCompatibility(value, pluginId) {
  const compatibility = exactKeys(
    value,
    new Set(["platform", "pluginApi", "runtime", "requiredCapabilities", "dependencies"]),
    new Set(["platform", "pluginApi", "runtime", "requiredCapabilities", "dependencies"]),
    "$.compatibility",
  );
  string(compatibility.platform, VERSION_RANGE, "$.compatibility.platform", { max: 128 });
  string(compatibility.pluginApi, VERSION_RANGE, "$.compatibility.pluginApi", { max: 128 });
  if (compatibility.runtime !== "oci-linux-arm64-v1") fail("runtime_unsupported", "$.compatibility.runtime", "must use the ARM64 OCI runtime contract");
  uniqueStrings(compatibility.requiredCapabilities, "$.compatibility.requiredCapabilities", { max: 128, pattern: SCOPE });
  const dependencies = array(compatibility.dependencies, "$.compatibility.dependencies", 0, 64);
  const ids = new Set();
  for (let index = 0; index < dependencies.length; index += 1) {
    const path = `$.compatibility.dependencies[${index}]`;
    const dependency = exactKeys(dependencies[index], new Set(["pluginId", "versionRange", "optional"]), new Set(["pluginId", "versionRange", "optional"]), path);
    const dependencyId = string(dependency.pluginId, PLUGIN_ID, `${path}.pluginId`, { max: 128 });
    if (dependencyId === pluginId) fail("dependency_invalid", `${path}.pluginId`, "a plugin cannot depend on itself");
    if (ids.has(dependencyId)) fail("duplicate_value", `${path}.pluginId`, "dependency plugin IDs must be unique");
    ids.add(dependencyId);
    string(dependency.versionRange, VERSION_RANGE, `${path}.versionRange`, { max: 128 });
    boolean(dependency.optional, `${path}.optional`);
  }
}

function validateSignature(value) {
  const signature = exactKeys(value, new Set(["format", "algorithm", "keyId", "payloadDigest", "value"]), new Set(["format", "algorithm", "keyId", "payloadDigest", "value"]), "$.signature");
  if (signature.format !== "teamaibox.canonical-json/v1") fail("signature_invalid", "$.signature.format", "is not the supported canonical payload format");
  if (signature.algorithm !== "Ed25519") fail("signature_invalid", "$.signature.algorithm", "must be Ed25519");
  string(signature.keyId, KEY_ID, "$.signature.keyId", { max: 257 });
  string(signature.payloadDigest, SHA256, "$.signature.payloadDigest", { min: 71, max: 71 });
  const encoded = string(signature.value, /^[A-Za-z0-9+/]{86}={0,2}$/, "$.signature.value", { min: 86, max: 88 });
  let decoded;
  try { decoded = Buffer.from(encoded, "base64"); } catch { fail("signature_invalid", "$.signature.value", "must be canonical base64"); }
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) fail("signature_invalid", "$.signature.value", "must be one canonical 64-byte Ed25519 signature");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_type", "$", "canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("invalid_type", "$", "manifest must contain JSON values only");
}

export function manifestSignaturePayload(manifest) {
  const source = record(manifest, "$input");
  const { signature: _signature, ...unsigned } = source;
  return canonicalJson(unsigned);
}

export function manifestPayloadDigest(manifest) {
  return `sha256:${createHash("sha256").update(manifestSignaturePayload(manifest), "utf8").digest("hex")}`;
}

export function validatePluginManifest(manifest, { verifyPayloadDigest = true } = {}) {
  const value = exactKeys(manifest, TOP_LEVEL_KEYS, new Set([...TOP_LEVEL_KEYS].filter((key) => key !== "extensions")), "$");
  if (value.apiVersion !== "teamaibox.io/plugin/v1") fail("api_version_unsupported", "$.apiVersion", "must be teamaibox.io/plugin/v1");
  const pluginId = string(value.id, PLUGIN_ID, "$.id", { max: 128 });
  const pluginType = enumValue(value.type, PLUGIN_TYPES, "$.type");
  string(value.version, SEMVER, "$.version", { max: 128 });
  const official = boolean(value.official, "$.official");
  validatePublisher(value.publisher);
  const architectures = uniqueStrings(value.architectures, "$.architectures", { min: 1, max: 1, allowed: new Set(["linux/arm64/v8"]) });
  if (!architectures.includes("linux/arm64/v8")) fail("architecture_unsupported", "$.architectures", "must include linux/arm64/v8");
  const imageFacts = validateImages(value.images, pluginType);
  validateEntryPoints(value.entryPoints, pluginType);
  validateApis(value.apis, pluginType);
  validateUi(value.ui, pluginType);
  validateLocalization(value.localization, official);
  validateThemes(value.themes, official);
  validatePermissions(value.permissions, pluginType);
  validateResources(value.resources, pluginType);
  validateHealth(value.health);
  validateMigrations(value.migrations, imageFacts);
  validateCompatibility(value.compatibility, pluginId);
  validateSignature(value.signature);
  if (value.extensions !== undefined) record(value.extensions, "$.extensions");
  const payloadDigest = manifestPayloadDigest(value);
  if (verifyPayloadDigest && value.signature.payloadDigest !== payloadDigest) {
    fail("signature_payload_mismatch", "$.signature.payloadDigest", "does not match the canonical unsigned manifest");
  }
  return Object.freeze({
    pluginId,
    pluginType,
    version: value.version,
    official,
    architecture: "linux/arm64/v8",
    payloadDigest,
    imageDigests: Object.freeze(value.images.flatMap((image) => image.variants.map((variant) => variant.digest))),
  });
}
