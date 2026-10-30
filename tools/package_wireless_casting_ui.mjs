#!/usr/bin/env node
// Package the real ARM64 UI, using actual image/SBOM/scan bytes. No fixture attestations.
import { createHash, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { manifestPayloadDigest, manifestSignaturePayload, validatePluginManifest } from "../services/plugin-runtime/src/manifest-validator.mjs";
import { bundlePayloadDigest, bundleSignaturePayload } from "../services/plugin-runtime/src/plugin-import-service.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const need = (value, message) => { if (!value) throw new Error(message); };
const root = resolve(new URL("..", import.meta.url).pathname);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);

export function validateBuildRecord(build) {
  const { evidenceDigest, ...record } = build;
  need(evidenceDigest === hash(Buffer.from(canonical(record))), "build evidence digest mismatch");
  need(build.status === "passed" && build.sources?.length > 0, "source-bound successful build required");
  for (const item of [...build.sources, ...build.artifacts]) {
    need(typeof item.path === "string" && !item.path.startsWith("/") && !item.path.split("/").includes(".."), "invalid build artifact path");
  }
}

export function buildBundle({ template, imageBytes, repository, sbomBytes, scanBytes, build,
  keyId, privateKey, signPayload = payload => sign(null, payload, privateKey), clock = new Date() }) {
  need(build.status === "passed" && build.architecture === "linux/arm64/v8", "UI build did not pass");
  const imageDigest = hash(imageBytes), image = JSON.parse(imageBytes);
  need(image.schemaVersion === 2 && image.config?.digest && Array.isArray(image.layers), "expected a single-platform OCI manifest");
  need(image.config.digest === build.imageConfigDigest, "registry image is not the scanned build");
  need(/^localhost:15016\/teamaibox\/wireless-casting-plugin$/.test(repository), "unexpected appliance registry");
  const sbom = JSON.parse(sbomBytes), scan = JSON.parse(scanBytes);
  need(sbom.SPDXID === "SPDXRef-DOCUMENT" && sbom.packages?.length > 0, "actual SPDX required");
  need(scan.descriptor?.name === "grype" && scan.descriptor?.db?.status?.valid === true, "actual valid Grype scan required");
  const counts = Object.fromEntries(["critical", "high", "medium", "low", "unknown"].map(key => [key, 0]));
  for (const match of scan.matches) {
    const severity = match.vulnerability.severity.toLowerCase();
    counts[severity in counts ? severity : "unknown"]++;
  }
  need(counts.critical === 0 && counts.high === 0, "existing plugin import severity policy exceeded");
  const databaseUpdatedAt = scan.descriptor.db.status.built;
  for (const date of [databaseUpdatedAt, build.scannedAt]) {
    const age = clock.getTime() - new Date(date).getTime();
    need(Number.isFinite(age) && age >= 0 && age <= 72 * 3600000, "stale scanner evidence");
  }
  for (const [suffix, bytes] of [["ui.spdx.json", sbomBytes], ["ui.grype.json", scanBytes]]) {
    need(build.artifacts?.some(item => item.path.endsWith("/" + suffix) && item.sha256 === hash(bytes)), "scan artifact binding mismatch");
  }
  const manifest = structuredClone(template);
  manifest.images[0].variants[0] = { architecture: "linux/arm64/v8", reference: repository,
    digest: imageDigest, mediaType: image.mediaType };
  manifest.signature.keyId = keyId;
  manifest.signature.payloadDigest = manifestPayloadDigest(manifest);
  manifest.signature.value = signPayload(Buffer.from(manifestSignaturePayload(manifest))).toString("base64");
  validatePluginManifest(manifest);
  const provenance = { _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: repository, digest: { sha256: imageDigest.slice(7) } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { builder: { id: "teamaibox.local/docker-build-arm64" },
      buildType: "teamaibox.source-bound-ui-build/v1", runId: build.runId,
      sources: build.sources, imageConfigDigest: image.config.digest,
      startedAt: build.startedAt, completedAt: build.completedAt,
      assurance: "local build record; not an independent SLSA level certification" } };
  const vulnerability = { schemaVersion: 1, status: "passed", scanner: `grype/${scan.descriptor.version}`,
    scannedAt: build.scannedAt, databaseUpdatedAt, findings: counts, rawReportDigest: hash(scanBytes) };
  const blobs = new Map([["image.json", imageBytes], ["ui.spdx.json", sbomBytes],
    ["provenance.json", Buffer.from(JSON.stringify(provenance))],
    ["vulnerability.json", Buffer.from(JSON.stringify(vulnerability))]]);
  const kinds = [["image.json", "oci-image-manifest", image.mediaType],
    ["ui.spdx.json", "sbom", "application/spdx+json"],
    ["provenance.json", "provenance", "application/vnd.in-toto+json"],
    ["vulnerability.json", "vulnerability-report", "application/vnd.teamaibox.vulnerability-report+json"]];
  const artifacts = kinds.map(([name, kind, mediaType]) => ({ name, kind, mediaType,
    sizeBytes: blobs.get(name).length, digest: hash(blobs.get(name)),
    ...(kind === "oci-image-manifest" ? { architecture: "linux/arm64/v8", imageName: manifest.images[0].name } : { subjects: [imageDigest] }) }));
  const bundle = { packageVersion: "teamaibox.plugin-package/v1", manifest, artifacts,
    bundleSignature: { format: "teamaibox.bundle-index/v1", algorithm: "Ed25519", keyId,
      payloadDigest: `sha256:${"0".repeat(64)}`, value: "" } };
  bundle.bundleSignature.payloadDigest = bundlePayloadDigest(bundle);
  bundle.bundleSignature.value = signPayload(Buffer.from(bundleSignaturePayload(bundle))).toString("base64");
  return { bundle: { ...bundle, artifacts: artifacts.map(descriptor => ({ descriptor, path: descriptor.name })) }, blobs };
}

async function main() {
  const [buildPath, imagePath, outputPath, packageIdentity, publicationVersion] = process.argv.slice(2);
  need(buildPath && imagePath && outputPath && [5, 6, 7].includes(process.argv.length), "usage: build-evidence registry-manifest output-directory [package-identity [version]]");
  const build = JSON.parse(await readFile(buildPath));
  need(/^wireless-casting-ui-release-20\d{6}-a[1-9]\d*$/.test(build.runId), "invalid build identity");
  validateBuildRecord(build);
  for (const source of build.sources) need(hash(await readFile(join(root, source.path))) === source.sha256, "source changed after build");
  const template = JSON.parse(await readFile(join(root, "apps/wireless-casting-plugin/manifest.release-template.json")));
  if (publicationVersion !== undefined) {
    need(/^0\.1\.[1-9]\d*$/.test(publicationVersion), "invalid publication version");
    template.version = publicationVersion;
  }
  const artifact = suffix => join(root, build.artifacts.find(item => item.path.endsWith("/" + suffix)).path);
  need(process.env.TEAMAIBOX_PLUGIN_PUBLISHER_FILE, "configure a persistent publisher before packaging");
  const publisher = JSON.parse(await readFile(process.env.TEAMAIBOX_PLUGIN_PUBLISHER_FILE));
  need(publisher.publisherId === template.publisher.id && publisher.pluginIds?.includes(template.id)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{2,191}$/.test(publisher.keyId)
    && typeof publisher.publicKeyPem === "string" && Array.isArray(publisher.signCommand)
    && publisher.signCommand.length > 0 && publisher.signCommand.every(s => typeof s === "string" && s.length > 0),
  "invalid persistent publisher profile");
  const signPayload = payload => {
    const result = spawnSync(publisher.signCommand[0], publisher.signCommand.slice(1),
      { input: payload, timeout: 20000, maxBuffer: 16384 });
    need(result.status === 0, "publisher signing failed");
    const signature = Buffer.from(result.stdout.toString().trim(), "base64");
    need(signature.length === 64 && verify(null, payload, publisher.publicKeyPem, signature), "publisher signature mismatch");
    return signature;
  };
  const packageId = packageIdentity ?? build.runId;
  need(/^wireless-casting-ui-(?:release|preparation)-20\d{6}-a[1-9]\d*$/.test(packageId), "invalid package identity");
  const keyId = publisher.keyId;
  const result = buildBundle({ template, imageBytes: await readFile(imagePath),
    repository: "localhost:15016/teamaibox/wireless-casting-plugin", sbomBytes: await readFile(artifact("ui.spdx.json")),
    scanBytes: await readFile(artifact("ui.grype.json")), build, keyId, signPayload });
  await mkdir(outputPath, { recursive: false });
  for (const [name, bytes] of result.blobs) await writeFile(join(outputPath, name), bytes, { flag: "wx" });
  await writeFile(join(outputPath, "bundle.json"), JSON.stringify(result.bundle), { flag: "wx" });
  await writeFile(join(outputPath, "trust.json"), JSON.stringify({ keyId, publisherId: template.publisher.id,
    pluginIds: [template.id], status: "active", publicKeyPem: publisher.publicKeyPem }), { flag: "wx" });
  process.stdout.write(JSON.stringify({ bundleId: packageId, pluginId: template.id,
    expectedBundleDigest: result.bundle.bundleSignature.payloadDigest, keyId }) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
}
