import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  createHash,
  sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { manifestPayloadDigest, manifestSignaturePayload } from "../src/manifest-validator.mjs";
import { MemoryPluginImportRepository } from "../src/memory-import-repository.mjs";
import { MemoryPluginLifecycleRepository } from "../src/memory-lifecycle-repository.mjs";
import {
  PluginImportError,
  PluginImportService,
  PluginSourceRouter,
  bundlePayloadDigest,
  bundleSignaturePayload,
  versionSatisfies,
  validatePluginImportPolicy,
} from "../src/plugin-import-service.mjs";
import { PluginLifecycleService } from "../src/plugin-lifecycle-service.mjs";

const policy = JSON.parse(await readFile(new URL("../../../deploy/plugins/import-policy.v1.json", import.meta.url), "utf8"));
const now = new Date("2026-08-11T00:00:00.000Z");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

test('offline source allowlist does not require online registry sources', () => {
  const offline = { ...policy, allowedSources: ['offline-bundle'] };
  assert.deepEqual(validatePluginImportPolicy(offline).allowedSources, ['offline-bundle']);
  assert.throws(() => validatePluginImportPolicy({ ...policy, allowedSources: ['unknown'] }));
});

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function signedValue(payload) {
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
}

function jsonArtifact(name, kind, mediaType, document, subjects = []) {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return {
    descriptor: { name, kind, digest: digest(bytes), sizeBytes: bytes.length, mediaType, subjects },
    bytes,
  };
}

function buildPackage({
  manifestMutation,
  descriptorMutation,
  includeSbom = true,
  scanAgeHours = 1,
  databaseAgeHours = 1,
  findings = { critical: 0, high: 0, medium: 1, low: 2, unknown: 0 },
  corruptArtifact,
} = {}) {
  const imageBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: `sha256:${"c".repeat(64)}`, size: 2 },
    layers: [],
  }), "utf8");
  const imageDigest = digest(imageBytes);
  const manifest = {
    apiVersion: "teamaibox.io/plugin/v1",
    id: "example.team-notes",
    type: "ApplicationPlugin",
    version: "1.2.3",
    official: false,
    publisher: { id: "example.publisher", displayName: "Example Publisher" },
    architectures: ["linux/arm64/v8"],
    images: [{
      name: "notes-app",
      role: "application",
      variants: [{
        architecture: "linux/arm64/v8",
        reference: "registry.example.test/team/notes",
        digest: imageDigest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
      }],
    }],
    entryPoints: { web: { path: "/plugins/example.team-notes", integration: "iframe" } },
    apis: [{ name: "platform.files", versionRange: ">=1.0.0 <2.0.0", access: "delegated-user" }],
    ui: {
      displayNameKey: "notes.catalog.name",
      summaryKey: "notes.catalog.summary",
      icon: "notebook-tabs",
      category: "collaboration",
      launchPath: "/apps/example.team-notes",
    },
    localization: {
      supportedLocales: ["en"],
      fallbackLocale: "en",
      supportedDirections: ["ltr"],
      rtlReady: false,
    },
    themes: { supported: ["light", "dark"], usesSemanticTokens: true, livePreferenceEvents: true },
    permissions: {
      platformApiScopes: ["files:read", "files:write"],
      delegatedUserToken: true,
      network: { mode: "none", egressHosts: [] },
      objectNamespaces: ["notes.data"],
      devices: [],
    },
    resources: {
      cpu: { requestMillicores: 250, limitMillicores: 1000 },
      unifiedMemoryBytes: 134217728,
      ephemeralStorageBytes: 1073741824,
      persistentStorageBytes: 1073741824,
      network: { ingressBitsPerSecond: 100000000, egressBitsPerSecond: 100000000 },
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
      requiredCapabilities: ["object-references"],
      dependencies: [{ pluginId: "example.base-plugin", versionRange: ">=1.0.0 <2.0.0", optional: false }],
    },
    signature: {
      format: "teamaibox.canonical-json/v1",
      algorithm: "Ed25519",
      keyId: "example.publisher/release-2026",
      payloadDigest: `sha256:${"0".repeat(64)}`,
      value: Buffer.alloc(64).toString("base64"),
    },
  };
  manifestMutation?.(manifest);
  manifest.signature.payloadDigest = manifestPayloadDigest(manifest);
  manifest.signature.value = signedValue(manifestSignaturePayload(manifest));

  const image = {
    descriptor: {
      name: "image-notes-app",
      kind: "oci-image-manifest",
      digest: imageDigest,
      sizeBytes: imageBytes.length,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      architecture: "linux/arm64/v8",
      imageName: "notes-app",
    },
    bytes: imageBytes,
  };
  const rawImageDigest = imageDigest.slice("sha256:".length);
  const sbom = jsonArtifact("evidence-sbom", "sbom", "application/spdx+json", {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    documentNamespace: "https://plugins.example.test/spdx/team-notes/1.2.3",
    creationInfo: { created: "2026-08-10T23:00:00.000Z", creators: ["Tool: example-sbom-1.0"] },
    packages: [{ SPDXID: "SPDXRef-Package-notes", name: "team-notes", versionInfo: "1.2.3" }],
  }, [imageDigest]);
  const provenance = jsonArtifact("evidence-provenance", "provenance", "application/vnd.in-toto+json", {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "notes-app", digest: { sha256: rawImageDigest } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { builder: { id: "https://builder.example.test/plugin-release" }, buildType: "https://teamaibox.local/build/v1" },
  }, [imageDigest]);
  const vulnerability = jsonArtifact("evidence-vulnerability", "vulnerability-report", "application/vnd.teamaibox.vulnerability-report+json", {
    schemaVersion: 1,
    status: "passed",
    scanner: "example-scanner/1.0",
    scannedAt: new Date(now.getTime() - scanAgeHours * 3600000).toISOString(),
    databaseUpdatedAt: new Date(now.getTime() - databaseAgeHours * 3600000).toISOString(),
    findings,
  }, [imageDigest]);
  const items = [image, ...(includeSbom ? [sbom] : []), provenance, vulnerability];
  descriptorMutation?.(items.map((item) => item.descriptor));
  const bytes = new Map(items.map((item) => [item.descriptor.name, item.bytes]));
  if (corruptArtifact) bytes.set(corruptArtifact, Buffer.from("corrupted", "utf8"));
  let closed = false;
  const bundle = {
    packageVersion: "teamaibox.plugin-package/v1",
    manifest,
    artifacts: items.map((item) => item.descriptor),
    bundleSignature: {
      format: "teamaibox.bundle-index/v1",
      algorithm: "Ed25519",
      keyId: "example.publisher/release-2026",
      payloadDigest: `sha256:${"0".repeat(64)}`,
      value: Buffer.alloc(64).toString("base64"),
    },
    async openArtifact(name) { return bytes.get(name); },
    async close() { closed = true; },
  };
  Object.defineProperty(bundle, "wasClosed", { value: () => closed, enumerable: false });
  bundle.bundleSignature.payloadDigest = bundlePayloadDigest(bundle);
  bundle.bundleSignature.value = signedValue(bundleSignaturePayload(bundle));
  return bundle;
}

function testEnvironment(overrides = {}) {
  return {
    async capabilities() { return ["object-references", "nvidia-container-runtime"]; },
    async dependency(pluginId) {
      return pluginId === "example.base-plugin" ? { version: "1.5.0", enabled: true } : null;
    },
    async permissionDecision() { return { allowed: true }; },
    ...overrides,
  };
}

function makeService(bundle, { repository = new MemoryPluginImportRepository(), environment = testEnvironment(), policyOverride = policy, requests = [] } = {}) {
  const resolver = { async resolve(request) { requests.push(request); return bundle; } };
  return {
    repository,
    service: new PluginImportService({
      sourceRouter: new PluginSourceRouter({
        marketplace: resolver,
        "private-registry": resolver,
        "offline-bundle": resolver,
      }),
      trustStore: {
        async resolve(keyId) {
          return keyId === "example.publisher/release-2026"
            ? { status: "active", publisherId: "example.publisher", pluginIds: ["example.team-notes"], publicKey }
            : null;
        },
      },
      repository,
      environment,
      policy: structuredClone(policyOverride),
      clock: () => new Date(now),
    }),
  };
}

function expectCode(code, gate) {
  return (error) => error instanceof PluginImportError && error.code === code && (!gate || error.gate === gate);
}

test("marketplace, private registry, and signed offline bundle share all gates before verified persistence", async () => {
  for (const sourceKind of ["marketplace", "private-registry", "offline-bundle"]) {
    const bundle = buildPackage();
    const requests = [];
    const { service, repository } = makeService(bundle, { requests });
    const result = sourceKind === "marketplace"
      ? await service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" })
      : sourceKind === "private-registry"
        ? await service.importFromPrivateRegistry({ reference: "registry.example.test/team/notes:1.2.3" })
        : await service.importOfflineBundle({ bundleId: "upload-01", expectedBundleDigest: bundlePayloadDigest(bundle) });
    assert.equal(result.state, "verified");
    assert.equal(result.sourceKind, sourceKind);
    assert.equal(result.supplyChain.vulnerabilityStatus, "passed");
    assert.deepEqual((await repository.list()).map((item) => item.pluginId), ["example.team-notes"]);
    assert.equal(requests[0].sourceKind, sourceKind);
    assert.equal(bundle.wasClosed(), true);
    assert.equal(JSON.stringify(result).includes("registry.example.test"), false);
  }
});

test("verifies manifest and bundle Ed25519 signatures against publisher-scoped active trust", async () => {
  const manifest = buildPackage();
  manifest.manifest.signature.value = sign(null, Buffer.from("wrong"), privateKey).toString("base64");
  const first = makeService(manifest);
  await assert.rejects(first.service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("signature_verification_failed", "manifest-signature"));
  assert.deepEqual(await first.repository.list(), []);

  const bundle = buildPackage();
  bundle.bundleSignature.value = sign(null, Buffer.from("wrong"), privateKey).toString("base64");
  const second = makeService(bundle);
  await assert.rejects(second.service.importFromPrivateRegistry({ reference: "registry.example.test/team/notes:1.2.3" }), expectCode("signature_verification_failed", "bundle-signature"));
  assert.deepEqual(await second.repository.list(), []);
});

test("checks every artifact size and SHA-256 before parsing supply-chain evidence", async () => {
  const bundle = buildPackage({ corruptArtifact: "evidence-sbom" });
  const { service, repository } = makeService(bundle);
  await assert.rejects(service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("artifact_checksum_failed", "checksum"));
  assert.deepEqual(await repository.list(), []);
});

test("requires complete SPDX, SLSA, and fresh passing vulnerability evidence for all image subjects", async () => {
  const missing = buildPackage({ includeSbom: false });
  await assert.rejects(makeService(missing).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("supply_chain_evidence_missing", "sbom"));

  const stale = buildPackage({ scanAgeHours: 80 });
  await assert.rejects(makeService(stale).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("evidence_stale", "vulnerability"));

  const vulnerable = buildPackage({ findings: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 } });
  await assert.rejects(makeService(vulnerable).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("vulnerability_policy_failed", "vulnerability"));
});

test("rejects source or OCI architecture mismatch and wrong offline selection checksum", async () => {
  const architecture = buildPackage({ descriptorMutation: (items) => { items[0].architecture = "linux/amd64"; } });
  await assert.rejects(makeService(architecture).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("architecture_mismatch", "architecture"));

  const offline = buildPackage();
  await assert.rejects(makeService(offline).service.importOfflineBundle({ bundleId: "upload-01", expectedBundleDigest: `sha256:${"f".repeat(64)}` }), expectCode("bundle_checksum_failed", "source"));
});

test("validates platform, Plugin API, capabilities, dependency ranges, and permission policy", async () => {
  const platform = buildPackage({ manifestMutation: (manifest) => { manifest.compatibility.platform = ">=2.0.0 <3.0.0"; } });
  await assert.rejects(makeService(platform).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("platform_incompatible", "compatibility"));

  const capability = buildPackage({ manifestMutation: (manifest) => { manifest.compatibility.requiredCapabilities = ["missing-capability"]; } });
  await assert.rejects(makeService(capability).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("capability_missing", "compatibility"));

  const dependency = buildPackage();
  const disabledEnvironment = testEnvironment({ async dependency() { return { version: "1.5.0", enabled: false }; } });
  await assert.rejects(makeService(dependency, { environment: disabledEnvironment }).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("dependency_incompatible", "dependencies"));

  const permission = buildPackage({ manifestMutation: (manifest) => { manifest.permissions.platformApiScopes = ["admin:root"]; } });
  await assert.rejects(makeService(permission).service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("permission_policy_failed", "permissions"));
});

test("excessive permission counts fail closed before verified persistence", async () => {
  const bundle = buildPackage();
  const restricted = structuredClone(policy);
  restricted.permissions.maximumScopes = 1;
  const { service, repository } = makeService(bundle, { policyOverride: restricted });
  await assert.rejects(
    service.importOfflineBundle({ bundleId: "upload-permissions", expectedBundleDigest: bundlePayloadDigest(bundle) }),
    expectCode("permission_policy_failed", "permissions"),
  );
  assert.deepEqual(await repository.list(), []);
  assert.equal(bundle.wasClosed(), true);
});

test("signed offline bundle verifies retained supply-chain evidence before atomic installation", async () => {
  const bundle = buildPackage();
  const imports = new MemoryPluginImportRepository();
  const importer = makeService(bundle, { repository: imports }).service;
  const verified = await importer.importOfflineBundle({
    bundleId: "upload-installable",
    expectedBundleDigest: bundlePayloadDigest(bundle),
  });
  assert.equal(verified.sourceKind, "offline-bundle");
  assert.equal(verified.manifestSignerKeyId, "example.publisher/release-2026");
  assert.equal(verified.bundleSignerKeyId, "example.publisher/release-2026");
  assert.equal(verified.supplyChain.vulnerabilityStatus, "passed");
  assert.match(verified.supplyChain.sbomDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(verified.supplyChain.provenanceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(verified.supplyChain.vulnerabilityReportDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(verified.artifacts.map(({ kind }) => kind).sort(), [
    "oci-image-manifest", "provenance", "sbom", "vulnerability-report",
  ]);

  const repository = new MemoryPluginLifecycleRepository();
  const events = [];
  const lifecycle = new PluginLifecycleService({
    verifiedImports: imports,
    repository,
    nodeAgent: {
      async stage(input) { events.push(["stage", input.version]); },
      async start(input) { events.push(["start", input.version]); },
      async waitHealthy() { return { healthy: true, consecutive: 3, observations: 3 }; },
      async promote(input) { events.push(["promote", input.version]); },
      async retire() {}, async stop() {}, async removeStaged() {}, async removeRuntime() {},
    },
    migrationRunner: {
      async begin(input) {
        events.push(["migration", input.dataNamespace]);
        return { async apply() {}, async commit() {}, async rollback() {} };
      },
    },
    sandboxPolicy: { async compile() { return { security: { readOnlyRoot: true } }; } },
    clock: () => new Date(now),
  });
  const installed = await lifecycle.install({
    context: { identityId: "admin-offline", permissions: ["plugin:manage"] },
    pluginId: "example.team-notes",
    version: "1.2.3",
    operationKey: "offline-install-0001",
  });
  assert.equal(installed.lifecycleState, "enabled");
  assert.equal(installed.currentVersion, "1.2.3");
  assert.deepEqual(events, [
    ["stage", "1.2.3"],
    ["migration", "plugin.example.team-notes"],
    ["start", "1.2.3"],
    ["promote", "1.2.3"],
  ]);
  assert.equal((await imports.get("example.team-notes", "1.2.3")).state, "verified");
});

test("verified import is idempotent but a different payload cannot replace the same plugin version", async () => {
  const repository = new MemoryPluginImportRepository();
  const firstBundle = buildPackage();
  const first = makeService(firstBundle, { repository }).service;
  const initial = await first.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" });
  const repeated = await first.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" });
  assert.deepEqual(repeated, initial);

  const changedBundle = buildPackage({ manifestMutation: (manifest) => { manifest.resources.unifiedMemoryBytes += 16777216; } });
  const changed = makeService(changedBundle, { repository }).service;
  await assert.rejects(changed.importFromMarketplace({ pluginId: "example.team-notes", version: "1.2.3" }), expectCode("plugin_version_conflict", "repository"));
  assert.equal((await repository.list()).length, 1);
});

test("SemVer compatibility range evaluation is deterministic for boundaries, caret, and tilde", () => {
  assert.equal(versionSatisfies("1.2.3", ">=1.0.0 <2.0.0"), true);
  assert.equal(versionSatisfies("2.0.0", ">=1.0.0 <2.0.0"), false);
  assert.equal(versionSatisfies("1.9.0", "^1.2.0"), true);
  assert.equal(versionSatisfies("2.0.0", "^1.2.0"), false);
  assert.equal(versionSatisfies("1.2.9", "~1.2.0"), true);
  assert.equal(versionSatisfies("1.3.0", "~1.2.0"), false);
});
