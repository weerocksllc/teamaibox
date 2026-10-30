import assert from "node:assert/strict";
import test from "node:test";

import {
  PluginManifestError,
  manifestPayloadDigest,
  manifestSignaturePayload,
  validatePluginManifest,
} from "../src/manifest-validator.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const signatureValue = Buffer.alloc(64, 7).toString("base64");

function baseManifest(type = "ApplicationPlugin") {
  const application = type === "ApplicationPlugin";
  const manifest = {
    apiVersion: "teamaibox.io/plugin/v1",
    id: application ? "example.team-notes" : "example.fast-ocr",
    type,
    version: "1.2.3",
    official: false,
    publisher: {
      id: "example.publisher",
      displayName: "Example Publisher",
      website: "https://plugins.example.test",
    },
    architectures: ["linux/arm64/v8"],
    images: [{
      name: application ? "notes-app" : "ocr-worker",
      role: application ? "application" : "worker",
      variants: [{
        architecture: "linux/arm64/v8",
        reference: application ? "registry.example.test/team/notes" : "registry.example.test/compute/ocr",
        digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      }],
    }],
    entryPoints: application
      ? { web: { path: "/plugins/example.team-notes", integration: "iframe" } }
      : { worker: { protocol: "teamaibox.worker-control/v1", capabilityRegistration: "scheduler-only" } },
    apis: [{
      name: application ? "platform.files" : "worker-control",
      versionRange: ">=1.0.0 <2.0.0",
      access: application ? "delegated-user" : "scheduler",
    }],
    ui: {
      displayNameKey: application ? "notes.catalog.name" : "ocr.catalog.name",
      summaryKey: application ? "notes.catalog.summary" : "ocr.catalog.summary",
      icon: application ? "notebook-tabs" : "scan-text",
      category: application ? "collaboration" : "infrastructure",
      ...(application ? { launchPath: "/apps/example.team-notes" } : {}),
      order: 500,
    },
    localization: {
      supportedLocales: ["en"],
      fallbackLocale: "en",
      supportedDirections: ["ltr"],
      rtlReady: false,
    },
    themes: {
      supported: application ? ["light", "dark"] : ["dark"],
      usesSemanticTokens: true,
      livePreferenceEvents: application,
    },
    permissions: {
      platformApiScopes: application ? ["files:read", "files:write"] : ["compute:report"],
      delegatedUserToken: application,
      network: { mode: "none", egressHosts: [] },
      objectNamespaces: application ? ["notes.data"] : ["ocr.artifacts"],
      devices: application ? [] : ["accelerator"],
    },
    resources: {
      cpu: { requestMillicores: 250, limitMillicores: application ? 1000 : 4000 },
      unifiedMemoryBytes: application ? 134217728 : 8589934592,
      ephemeralStorageBytes: 1073741824,
      persistentStorageBytes: application ? 1073741824 : 0,
      network: { ingressBitsPerSecond: 100000000, egressBitsPerSecond: 100000000 },
      ...(!application ? { accelerator: { kind: "nvidia-gpu", units: 1 } } : {}),
    },
    health: {
      startup: { path: "/health/startup", intervalSeconds: 10, timeoutSeconds: 2, failureThreshold: 12 },
      readiness: { path: "/health/ready", intervalSeconds: 10, timeoutSeconds: 2, failureThreshold: 3 },
      liveness: { path: "/health/live", intervalSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 },
    },
    migrations: [],
    compatibility: {
      platform: ">=0.1.0 <1.0.0",
      pluginApi: ">=1.0.0 <2.0.0",
      runtime: "oci-linux-arm64-v1",
      requiredCapabilities: application ? ["object-references"] : ["nvidia-container-runtime"],
      dependencies: [],
    },
    signature: {
      format: "teamaibox.canonical-json/v1",
      algorithm: "Ed25519",
      keyId: "example.publisher/release-2026",
      payloadDigest: digest,
      value: signatureValue,
    },
  };
  manifest.signature.payloadDigest = manifestPayloadDigest(manifest);
  return manifest;
}

function expectCode(code) {
  return (error) => error instanceof PluginManifestError && error.code === code;
}

test("validates a signed ApplicationPlugin with ARM64 image, delegated APIs, locale, and theme metadata", () => {
  const manifest = baseManifest();
  const result = validatePluginManifest(manifest);
  assert.deepEqual(result, {
    pluginId: "example.team-notes",
    pluginType: "ApplicationPlugin",
    version: "1.2.3",
    official: false,
    architecture: "linux/arm64/v8",
    payloadDigest: manifest.signature.payloadDigest,
    imageDigests: [digest],
  });
  assert.equal(manifestSignaturePayload(manifest).includes("signature"), false);
});

test("validates a scheduler-only ComputePlugin and never invents dedicated VRAM", () => {
  const manifest = baseManifest("ComputePlugin");
  const result = validatePluginManifest(manifest);
  assert.equal(result.pluginType, "ComputePlugin");
  assert.equal(JSON.stringify(manifest).includes("Vram"), false);
  assert.equal(JSON.stringify(manifest).includes("vram"), false);
});

test("rejects type-confused entry points, APIs, devices, and images before container start", () => {
  const entry = baseManifest();
  entry.entryPoints = { worker: { protocol: "teamaibox.worker-control/v1", capabilityRegistration: "scheduler-only" } };
  entry.signature.payloadDigest = manifestPayloadDigest(entry);
  assert.throws(() => validatePluginManifest(entry), expectCode("plugin_type_mismatch"));

  const api = baseManifest("ComputePlugin");
  api.apis[0].access = "delegated-user";
  api.signature.payloadDigest = manifestPayloadDigest(api);
  assert.throws(() => validatePluginManifest(api), expectCode("plugin_type_mismatch"));

  const device = baseManifest();
  device.permissions.devices = ["accelerator"];
  device.signature.payloadDigest = manifestPayloadDigest(device);
  assert.throws(() => validatePluginManifest(device), expectCode("plugin_type_mismatch"));
});

test("rejects missing ARM64 variants, duplicate image identity, and unpinned images", () => {
  const architecture = baseManifest();
  architecture.images[0].variants[0].architecture = "linux/amd64";
  architecture.signature.payloadDigest = manifestPayloadDigest(architecture);
  assert.throws(() => validatePluginManifest(architecture), expectCode("architecture_unsupported"));

  const duplicate = baseManifest();
  duplicate.images.push(structuredClone(duplicate.images[0]));
  duplicate.signature.payloadDigest = manifestPayloadDigest(duplicate);
  assert.throws(() => validatePluginManifest(duplicate), expectCode("duplicate_value"));

  const unpinned = baseManifest();
  unpinned.images[0].variants[0].digest = "latest";
  unpinned.signature.payloadDigest = manifestPayloadDigest(unpinned);
  assert.throws(() => validatePluginManifest(unpinned), expectCode("invalid_value"));
});

test("requires a supported fallback, direction consistency, and complete official locale/theme coverage", () => {
  const fallback = baseManifest();
  fallback.localization.fallbackLocale = "zh-CN";
  fallback.signature.payloadDigest = manifestPayloadDigest(fallback);
  assert.throws(() => validatePluginManifest(fallback), expectCode("invalid_fallback"));

  const direction = baseManifest();
  direction.localization.rtlReady = true;
  direction.signature.payloadDigest = manifestPayloadDigest(direction);
  assert.throws(() => validatePluginManifest(direction), expectCode("direction_mismatch"));

  const official = baseManifest();
  official.official = true;
  official.signature.payloadDigest = manifestPayloadDigest(official);
  assert.throws(() => validatePluginManifest(official), expectCode("official_compatibility_missing"));

  official.localization.supportedLocales = ["zh-CN", "en"];
  official.themes.supported = ["light"];
  official.signature.payloadDigest = manifestPayloadDigest(official);
  assert.throws(() => validatePluginManifest(official), expectCode("official_compatibility_missing"));

  official.themes.supported = ["light", "dark"];
  official.themes.livePreferenceEvents = false;
  official.signature.payloadDigest = manifestPayloadDigest(official);
  assert.throws(() => validatePluginManifest(official), expectCode("official_compatibility_missing"));
});

test("binds the signature declaration to canonical unsigned content", () => {
  const manifest = baseManifest();
  manifest.resources.unifiedMemoryBytes += 1;
  assert.throws(() => validatePluginManifest(manifest), expectCode("signature_payload_mismatch"));

  const malformed = baseManifest();
  malformed.signature.value = "not-a-signature";
  assert.throws(() => validatePluginManifest(malformed), expectCode("invalid_value"));
});

test("rejects unknown members, invalid resource envelopes, and unsafe migration references", () => {
  const unknown = baseManifest();
  unknown.dockerSocket = true;
  unknown.signature.payloadDigest = manifestPayloadDigest(unknown);
  assert.throws(() => validatePluginManifest(unknown), expectCode("unknown_field"));

  const resource = baseManifest();
  resource.resources.cpu.limitMillicores = 100;
  resource.signature.payloadDigest = manifestPayloadDigest(resource);
  assert.throws(() => validatePluginManifest(resource), expectCode("resource_envelope_invalid"));

  const migration = baseManifest();
  migration.migrations.push({
    id: "000001_initialize_notes",
    fromVersion: "1.0.0",
    toVersion: "1.2.3",
    imageName: "notes-app",
    transactional: true,
    reversible: true,
  });
  migration.signature.payloadDigest = manifestPayloadDigest(migration);
  assert.throws(() => validatePluginManifest(migration), expectCode("migration_invalid"));
});
