#!/usr/bin/env node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { manifestPayloadDigest, manifestSignaturePayload } from "../services/plugin-runtime/src/manifest-validator.mjs";
import { bundlePayloadDigest, bundleSignaturePayload } from "../services/plugin-runtime/src/plugin-import-service.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SHA = /^sha256:[a-f0-9]{64}$/;
const RUN = /^plugin-catalog-20[0-9]{6}-[a-z0-9][a-z0-9-]{1,31}$/;

class CatalogFailure extends Error {}
function need(value, message) { if (!value) throw new CatalogFailure(message); }
function hash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function canonical(value) { return Buffer.from(JSON.stringify(value), "utf8"); }
function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    need(argv[index]?.startsWith("--") && argv[index + 1], "catalog arguments are incomplete");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const key of ["run-id", "image-evidence", "output", "metadata"]) need(values[key], `catalog ${key} is required`);
  need(RUN.test(values["run-id"]), "catalog run ID is invalid");
  const result = { runId: values["run-id"], imageEvidence: resolve(values["image-evidence"]), output: resolve(values.output), metadata: resolve(values.metadata) };
  for (const path of [result.imageEvidence, result.output, result.metadata]) {
    const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "catalog path escapes the repository");
  }
  return result;
}

function descriptor(name, kind, mediaType, document, subjects = []) {
  const bytes = canonical(document);
  return { descriptor: { name, kind, digest: hash(bytes), sizeBytes: bytes.length, mediaType, subjects }, contentBase64: bytes.toString("base64") };
}

function unsignedManifest({ pluginId, pluginType, version, image, permissionScopes = null, migrationFailure = false }) {
  const application = pluginType === "ApplicationPlugin";
  const primaryImageName = application ? "team-notes-app" : "text-transform-worker";
  const manifest = {
    apiVersion: "teamaibox.io/plugin/v1", id: pluginId, type: pluginType, version, official: false,
    publisher: { id: "example.community", displayName: "Example Community", website: "https://plugins.example.test" },
    architectures: ["linux/arm64/v8"],
    images: [{ name: primaryImageName, role: application ? "application" : "worker",
      variants: [{ architecture: "linux/arm64/v8", reference: image.repository, digest: image.digest, mediaType: image.manifestMediaType }] }],
    entryPoints: application
      ? { web: { path: `/plugins/${pluginId}`, integration: "iframe" } }
      : { worker: { protocol: "teamaibox.worker-control/v1", capabilityRegistration: "scheduler-only" } },
    apis: [{ name: application ? "platform.files" : "worker-control", versionRange: ">=1.0.0 <2.0.0", access: application ? "delegated-user" : "scheduler" }],
    ui: { displayNameKey: `${application ? "team-notes" : "text-transform"}.catalog.name`, summaryKey: `${application ? "team-notes" : "text-transform"}.catalog.summary`,
      icon: application ? "notebook-tabs" : "case-upper", category: application ? "collaboration" : "infrastructure",
      ...(application ? { launchPath: `/apps/${pluginId}` } : {}), order: application ? 500 : 900 },
    localization: { supportedLocales: ["en"], fallbackLocale: "en", supportedDirections: ["ltr"], rtlReady: false },
    themes: { supported: application ? ["light", "dark"] : ["dark"], usesSemanticTokens: true, livePreferenceEvents: application },
    permissions: { platformApiScopes: permissionScopes ?? [application ? "files:read" : "compute:report"], delegatedUserToken: application,
      network: { mode: "none", egressHosts: [] }, objectNamespaces: [application ? "sample.notes" : "sample.transforms"], devices: [] },
    resources: { cpu: { requestMillicores: 100, limitMillicores: 500 }, unifiedMemoryBytes: 134217728,
      ephemeralStorageBytes: 67108864, persistentStorageBytes: application ? 536870912 : 0,
      network: { ingressBitsPerSecond: 100000000, egressBitsPerSecond: 100000000 } },
    health: { startup: { path: "/health/startup", intervalSeconds: 5, timeoutSeconds: 2, failureThreshold: 12 },
      readiness: { path: "/health/ready", intervalSeconds: 10, timeoutSeconds: 2, failureThreshold: 3 },
      liveness: { path: "/health/live", intervalSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 } },
    migrations: [], compatibility: { platform: ">=0.1.0 <1.0.0", pluginApi: ">=1.0.0 <2.0.0", runtime: "oci-linux-arm64-v1",
      requiredCapabilities: application ? ["object-references"] : [], dependencies: [] },
    signature: { format: "teamaibox.canonical-json/v1", algorithm: "Ed25519", keyId: "example.community/plugin-release-2026",
      payloadDigest: `sha256:${"0".repeat(64)}`, value: Buffer.alloc(64).toString("base64") },
  };
  if (migrationFailure) {
    manifest.images.push({ name: "schema-migration", role: "migration",
      variants: [{ architecture: "linux/arm64/v8", reference: image.repository, digest: image.digest, mediaType: image.manifestMediaType }] });
    manifest.migrations.push({ id: "000001_fail_closed", fromVersion: "0.0.0", toVersion: version,
      imageName: "schema-migration", transactional: true, reversible: true });
  }
  return manifest;
}

function packageBundle({ pluginId, pluginType, version, image, privateKey, invalidSignature = false,
  descriptorArchitecture = "linux/arm64/v8", permissionScopes = null, migrationFailure = false, clock }) {
  const manifest = unsignedManifest({ pluginId, pluginType, version, image, permissionScopes, migrationFailure });
  manifest.signature.payloadDigest = manifestPayloadDigest(manifest);
  manifest.signature.value = sign(null, Buffer.from(manifestSignaturePayload(manifest), "utf8"), privateKey).toString("base64");
  if (invalidSignature) manifest.signature.value = Buffer.alloc(64, 0x5a).toString("base64");
  const imageBytes = Buffer.from(image.manifestBase64, "base64");
  need(hash(imageBytes) === image.digest, `image evidence changed for ${image.key}`);
  const rawDigest = image.digest.slice(7);
  const artifacts = manifest.images.map((declaredImage, index) => ({ descriptor: {
    name: index === 0 ? `image-${pluginId.replaceAll(".", "-")}-${version}` : `image-${pluginId.replaceAll(".", "-")}-${version}-${declaredImage.name}`,
    kind: "oci-image-manifest", digest: image.digest, sizeBytes: imageBytes.length, mediaType: image.manifestMediaType,
    architecture: descriptorArchitecture, imageName: declaredImage.name }, contentBase64: imageBytes.toString("base64") }));
  artifacts.push(descriptor(`sbom-${pluginId}-${version}`, "sbom", "application/spdx+json", {
    spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", documentNamespace: `https://plugins.example.test/spdx/${pluginId}/${version}`,
    creationInfo: { created: new Date(clock.getTime() - 60_000).toISOString(), creators: ["Tool: teamaibox-fixture-sbom-1"] },
    packages: [{ SPDXID: "SPDXRef-Package-plugin", name: pluginId, versionInfo: version }],
  }, [image.digest]));
  artifacts.push(descriptor(`provenance-${pluginId}-${version}`, "provenance", "application/vnd.in-toto+json", {
    _type: "https://in-toto.io/Statement/v1", subject: [{ name: manifest.images[0].name, digest: { sha256: rawDigest } }],
    predicateType: "https://slsa.dev/provenance/v1", predicate: { builder: { id: "https://builder.teamaibox.test/plugin-fixture" }, buildType: "https://teamaibox.local/build/v1" },
  }, [image.digest]));
  artifacts.push(descriptor(`vulnerability-${pluginId}-${version}`, "vulnerability-report", "application/vnd.teamaibox.vulnerability-report+json", {
    schemaVersion: 1, status: "passed", scanner: "teamaibox-fixture-scanner/1", scannedAt: new Date(clock.getTime() - 60_000).toISOString(),
    databaseUpdatedAt: new Date(clock.getTime() - 60_000).toISOString(), findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
  }, [image.digest]));
  const bundle = { packageVersion: "teamaibox.plugin-package/v1", manifest, artifacts,
    bundleSignature: { format: "teamaibox.bundle-index/v1", algorithm: "Ed25519", keyId: "example.community/plugin-release-2026",
      payloadDigest: `sha256:${"0".repeat(64)}`, value: Buffer.alloc(64).toString("base64") } };
  const signingView = { ...bundle, artifacts: artifacts.map((item) => item.descriptor) };
  bundle.bundleSignature.payloadDigest = bundlePayloadDigest(signingView);
  bundle.bundleSignature.value = sign(null, Buffer.from(bundleSignaturePayload(signingView), "utf8"), privateKey).toString("base64");
  return bundle;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const evidenceBytes = await readFile(options.imageEvidence);
  const evidence = JSON.parse(evidenceBytes);
  need(evidence.status === "passed" && evidence.architecture === "linux/arm64/v8" && evidence.images?.length === 4, "plugin image evidence did not pass");
  const image = Object.fromEntries(evidence.images.map((item) => [item.key, item]));
  for (const key of ["team-notes-v1", "team-notes-v2", "team-notes-v3-unhealthy", "text-transform-v1"]) {
    need(image[key]?.architecture === "linux/arm64/v8" && SHA.test(image[key].digest), `plugin image ${key} is invalid`);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const clock = new Date();
  const specs = [
    { key: "teamNotesV1", sourceKind: "marketplace", locator: "example.team-notes@1.0.0", pluginId: "example.team-notes", pluginType: "ApplicationPlugin", version: "1.0.0", image: image["team-notes-v1"] },
    { key: "teamNotesV2", sourceKind: "private-registry", locator: image["team-notes-v2"].reference, pluginId: "example.team-notes", pluginType: "ApplicationPlugin", version: "2.0.0", image: image["team-notes-v2"] },
    { key: "teamNotesV3Unhealthy", sourceKind: "marketplace", locator: "example.team-notes@3.0.0", pluginId: "example.team-notes", pluginType: "ApplicationPlugin", version: "3.0.0", image: image["team-notes-v3-unhealthy"] },
    { key: "textTransformV1", sourceKind: "offline-bundle", locator: "text-transform-offline-v1", pluginId: "example.text-transform", pluginType: "ComputePlugin", version: "1.0.0", image: image["text-transform-v1"] },
    { key: "invalidSignature", sourceKind: "marketplace", locator: "example.signature-invalid@1.0.0", pluginId: "example.signature-invalid", pluginType: "ApplicationPlugin", version: "1.0.0", image: image["team-notes-v1"], invalidSignature: true, expectedCode: "signature_verification_failed" },
    { key: "invalidArchitecture", sourceKind: "marketplace", locator: "example.architecture-invalid@1.0.0", pluginId: "example.architecture-invalid", pluginType: "ApplicationPlugin", version: "1.0.0", image: image["team-notes-v1"], descriptorArchitecture: "linux/amd64", expectedCode: "architecture_mismatch" },
    { key: "invalidPermission", sourceKind: "marketplace", locator: "example.permission-invalid@1.0.0", pluginId: "example.permission-invalid", pluginType: "ApplicationPlugin", version: "1.0.0", image: image["team-notes-v1"], permissionScopes: ["admin:root"], expectedCode: "permission_policy_failed" },
    { key: "migrationFailure", sourceKind: "marketplace", locator: "example.migration-failure@1.0.0", pluginId: "example.migration-failure", pluginType: "ApplicationPlugin", version: "1.0.0", image: image["team-notes-v1"], migrationFailure: true, expectedCode: "plugin_lifecycle_failed" },
  ];
  const packages = specs.map((spec) => ({ sourceKind: spec.sourceKind, locator: spec.locator,
    bundle: packageBundle({ ...spec, privateKey, clock }) }));
  const catalog = { schemaVersion: 1, trust: [{ keyId: "example.community/plugin-release-2026", publisherId: "example.community", status: "active",
    publicKeyPem, validFrom: new Date(clock.getTime() - 86_400_000).toISOString(), validUntil: new Date(clock.getTime() + 7 * 86_400_000).toISOString(),
    pluginIds: specs.map((item) => item.pluginId).filter((value, index, values) => values.indexOf(value) === index).sort() }], packages };
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const metadata = { schemaVersion: 1, runnerId: "teamaibox.plugin-source-catalog.v1", runId: options.runId,
    catalogRunId: options.runId, status: "passed",
    imageEvidence: { path: relative(ROOT, options.imageEvidence), digest: hash(evidenceBytes), runId: evidence.runId },
    catalog: { path: relative(ROOT, options.output), digest: hash(catalogBytes), packageCount: packages.length },
    packages: Object.fromEntries(specs.map((spec, index) => [spec.key, { sourceKind: spec.sourceKind, locator: spec.locator,
      pluginId: spec.pluginId, pluginType: spec.pluginType, version: spec.version,
      bundlePayloadDigest: packages[index].bundle.bundleSignature.payloadDigest, imageDigest: spec.image.digest,
      ...(spec.sourceKind === "private-registry" ? { reference: spec.locator } : {}),
      ...(spec.sourceKind === "offline-bundle" ? {
        bundleId: spec.locator,
        expectedBundleDigest: packages[index].bundle.bundleSignature.payloadDigest,
      } : {}),
      ...(spec.expectedCode ? { expectedCode: spec.expectedCode } : {}) }])) };
  metadata.evidenceDigest = hash(Buffer.from(JSON.stringify(metadata, Object.keys(metadata).sort()), "utf8"));
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(dirname(options.metadata), { recursive: true });
  await writeFile(options.output, catalogBytes, { flag: "wx", mode: 0o644 });
  await writeFile(options.metadata, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  privateKey.export({ type: "pkcs8", format: "der" }).fill(0);
  process.stdout.write(`${JSON.stringify({ runId: options.runId, status: "passed", packageCount: packages.length, catalog: relative(ROOT, options.output), evidence: relative(ROOT, options.metadata) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "plugin catalog generation failed"}\n`); process.exitCode = 1; });
