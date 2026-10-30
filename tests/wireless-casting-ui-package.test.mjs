import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildBundle, validateBuildRecord } from "../tools/package_wireless_casting_ui.mjs";
import { manifestSignaturePayload } from "../services/plugin-runtime/src/manifest-validator.mjs";
import { bundleSignaturePayload } from "../services/plugin-runtime/src/plugin-import-service.mjs";

const template = JSON.parse(await readFile(new URL("../apps/wireless-casting-plugin/manifest.release-template.json", import.meta.url)));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const bytes = value => Buffer.from(JSON.stringify(value));
const hash = value => "sha256:" + createHash("sha256").update(value).digest("hex");
// Deliberately synthetic inputs, confined to unit tests; never a release artifact.
function fixture() {
  const sbomBytes = bytes({ SPDXID: "SPDXRef-DOCUMENT", packages: [{ name: "unit-test-only" }] });
  const scanBytes = bytes({ descriptor: { name: "grype", version: "test", db: { status: {
    valid: true, built: "2026-09-07T00:00:00Z" } } }, matches: [] });
  return { template, imageBytes: bytes({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: "sha256:" + "1".repeat(64) }, layers: [] }), repository: "localhost:15016/teamaibox/wireless-casting-plugin",
    sbomBytes, scanBytes, keyId: "teamaibox.official/unit-test-only", privateKey, clock: new Date("2026-09-07T01:00:00Z"),
    build: { status: "passed", architecture: "linux/arm64/v8", scannedAt: "2026-09-07T00:00:00Z",
      imageConfigDigest: "sha256:" + "1".repeat(64), sources: [], runId: "unit-test-only",
      artifacts: [{ path: "test/ui.spdx.json", sha256: hash(sbomBytes) }, { path: "test/ui.grype.json", sha256: hash(scanBytes) }] } };
}
test("manifest and complete package signatures verify, without serializing the signing key", () => {
  const { bundle } = buildBundle(fixture());
  assert(verify(null, Buffer.from(manifestSignaturePayload(bundle.manifest)), publicKey, Buffer.from(bundle.manifest.signature.value, "base64")));
  assert(verify(null, Buffer.from(bundleSignaturePayload({ ...bundle, artifacts: bundle.artifacts.map(a => a.descriptor) })), publicKey,
    Buffer.from(bundle.bundleSignature.value, "base64")));
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE KEY/);
});
test("package refuses changed image, changed SBOM, stale database and real high findings", () => {
  for (const mutate of [
    v => v.build.imageConfigDigest = "sha256:" + "2".repeat(64),
    v => v.sbomBytes = bytes({ SPDXID: "SPDXRef-DOCUMENT", packages: [{ name: "changed" }] }),
    v => v.clock = new Date("2026-09-11T00:00:00Z"),
    v => { const scan = JSON.parse(v.scanBytes); scan.matches = [{ vulnerability: { severity: "High" } }]; v.scanBytes = bytes(scan); },
    v => v.build.status = "failed",
  ]) { const input = fixture(); mutate(input); assert.throws(() => buildBundle(input)); }
});

test("preparation rejects modified build records and unbounded paths", () => {
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
  const record = { status: "passed", sources: [{ path: "unit/source" }], artifacts: [] };
  const bound = value => ({ ...value, evidenceDigest: hash(Buffer.from(canonical(value))) });
  validateBuildRecord(bound(record));
  assert.throws(() => validateBuildRecord({ ...bound(record), status: "failed" }));
  assert.throws(() => validateBuildRecord(bound({ ...record, sources: [{ path: "../outside" }] })));
});
