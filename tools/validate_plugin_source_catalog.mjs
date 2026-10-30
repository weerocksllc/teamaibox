#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { FilePluginSourceCatalog } from "../services/plugin-runtime/src/file-plugin-source-catalog.mjs";
import { MemoryPluginImportRepository } from "../services/plugin-runtime/src/memory-import-repository.mjs";
import { PluginImportService, PluginSourceRouter } from "../services/plugin-runtime/src/plugin-import-service.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RUN = /^plugin-catalog-validation-20[0-9]{6}-[a-z0-9][a-z0-9-]{1,31}$/;
class ValidationFailure extends Error {}
function need(value, message) { if (!value) throw new ValidationFailure(message); }
function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) { need(argv[index]?.startsWith("--") && argv[index + 1], "validation arguments are incomplete"); values[argv[index].slice(2)] = argv[index + 1]; }
  for (const key of ["run-id", "catalog", "metadata", "output"]) need(values[key], `validation ${key} is required`);
  need(RUN.test(values["run-id"]), "validation run ID is invalid");
  const result = { runId: values["run-id"], catalog: resolve(values.catalog), metadata: resolve(values.metadata), output: resolve(values.output) };
  for (const path of Object.values(result).slice(1)) { const scoped = relative(ROOT, path); need(scoped && scoped !== ".." && !scoped.startsWith("../"), "validation path escapes the repository"); }
  return result;
}
function importer(catalog, policy) {
  const repository = new MemoryPluginImportRepository();
  return new PluginImportService({
    sourceRouter: new PluginSourceRouter({ marketplace: catalog, "private-registry": catalog, "offline-bundle": catalog }),
    trustStore: { resolve: (keyId) => catalog.resolveTrust(keyId) }, repository,
    environment: { async capabilities() { return ["object-references"]; }, async dependency() { return null; }, async permissionDecision() { return { allowed: true }; } },
    policy,
  });
}

async function main() {
  const input = options(process.argv.slice(2));
  const [catalogBytes, metadataBytes, policyBytes] = await Promise.all([
    readFile(input.catalog), readFile(input.metadata), readFile(resolve(ROOT, "deploy/plugins/import-policy.v1.json")),
  ]);
  const metadata = JSON.parse(metadataBytes), policy = JSON.parse(policyBytes);
  need(metadata.status === "passed" && metadata.catalog?.digest === digest(catalogBytes), "catalog metadata binding changed");
  need(metadata.catalogRunId === metadata.runId, "protocol catalog run identity is missing");
  need(metadata.packages?.teamNotesV2?.reference === metadata.packages?.teamNotesV2?.locator,
    "private-registry protocol reference is missing");
  need(metadata.packages?.textTransformV1?.bundleId === metadata.packages?.textTransformV1?.locator
    && metadata.packages?.textTransformV1?.expectedBundleDigest === metadata.packages?.textTransformV1?.bundlePayloadDigest,
  "offline-bundle protocol identity is missing");
  for (const [key, expectedCode] of Object.entries({
    invalidSignature: "signature_verification_failed",
    invalidArchitecture: "architecture_mismatch",
    invalidPermission: "permission_policy_failed",
    migrationFailure: "plugin_lifecycle_failed",
  })) need(metadata.packages?.[key]?.expectedCode === expectedCode, `${key} protocol expectation is missing`);
  const catalog = new FilePluginSourceCatalog({ path: input.catalog });
  const cases = [
    { key: "marketplace-valid-application-v1", expected: "verified", run: (service) => service.importFromMarketplace({ pluginId: "example.team-notes", version: "1.0.0" }) },
    { key: "private-registry-valid-application-v2", expected: "verified", run: (service) => service.importFromPrivateRegistry({ reference: metadata.packages.teamNotesV2.locator }) },
    { key: "marketplace-valid-unhealthy-image-v3", expected: "verified", run: (service) => service.importFromMarketplace({ pluginId: "example.team-notes", version: "3.0.0" }) },
    { key: "offline-valid-compute-v1", expected: "verified", run: (service) => service.importOfflineBundle({ bundleId: metadata.packages.textTransformV1.locator, expectedBundleDigest: metadata.packages.textTransformV1.bundlePayloadDigest }) },
    { key: "signature-denied", expected: "signature_verification_failed", run: (service) => service.importFromMarketplace({ pluginId: "example.signature-invalid", version: "1.0.0" }) },
    { key: "architecture-denied", expected: "architecture_mismatch", run: (service) => service.importFromMarketplace({ pluginId: "example.architecture-invalid", version: "1.0.0" }) },
    { key: "permission-denied", expected: "permission_policy_failed", run: (service) => service.importFromMarketplace({ pluginId: "example.permission-invalid", version: "1.0.0" }) },
    { key: "migration-fixture-imports-before-lifecycle", expected: "verified", run: (service) => service.importFromMarketplace({ pluginId: "example.migration-failure", version: "1.0.0" }) },
  ];
  const results = [];
  for (const declaration of cases) {
    let observed = null;
    try { const result = await declaration.run(importer(catalog, policy)); observed = result?.state ?? "unexpected_success"; }
    catch (error) { observed = error?.code ?? error?.name ?? "unknown_error"; }
    results.push({ key: declaration.key, expected: declaration.expected, observed, passed: observed === declaration.expected });
  }
  need(results.every((item) => item.passed), "one or more plugin catalog gates did not match");
  const evidence = { schemaVersion: 1, runnerId: "teamaibox.plugin-source-catalog-validation.v1", runId: input.runId, status: "passed",
    catalog: { path: relative(ROOT, input.catalog), digest: digest(catalogBytes) }, metadata: { path: relative(ROOT, input.metadata), digest: digest(metadataBytes), runId: metadata.runId },
    results, privacy: { credentialsRetained: false, packageContentRetained: false, commandOutputRetained: false }, failure: null };
  evidence.evidenceDigest = digest(Buffer.from(JSON.stringify(evidence, null, 0), "utf8"));
  await mkdir(dirname(input.output), { recursive: true });
  await writeFile(input.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ runId: input.runId, status: "passed", caseCount: results.length, evidence: relative(ROOT, input.output) })}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? "plugin catalog validation failed"}\n`); process.exitCode = 1; });
