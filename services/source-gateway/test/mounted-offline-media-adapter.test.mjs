import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MountedOfflineMediaAdapter } from "../src/mounted-offline-media-adapter.mjs";
import { OfflineMediaOpenPgpVerifier } from "../src/offline-media-openpgp-verifier.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c017419958b";
const MOUNT = "018f6f18-24d7-7c21-9b62-8c017419959b";
const FS = "018f6f18-24d7-7c21-9b62-8c0174199501";
const KEY = "A".repeat(40);
function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

test("mounted media adapter discovers direct read-only roots and hashes real files without following links", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "teamaibox-offline-")); t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(temporary, { recursive: true, force: true }); });
  const root = await realpath(temporary), mount = path.join(root, MOUNT); await mkdir(path.join(mount, "pip"), { recursive: true });
  const artifact = Buffer.from("verified wheel bytes");
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, mediaKey: "demo", signature: { detachedPath: "manifest.json.asc", keyFingerprint: KEY }, artifacts: [] }));
  await writeFile(path.join(mount, "manifest.json"), manifest); await writeFile(path.join(mount, "manifest.json.asc"), "signature");
  await writeFile(path.join(mount, "pip", "demo.whl"), artifact); await writeFile(path.join(mount, "pip", "demo.whl.asc"), "signature");
  const signatureCalls = [];
  const adapter = new MountedOfflineMediaAdapter({ root, allowTestRoot: true,
    inventory: { async listReadOnlyMedia() { return [{ mountId: MOUNT, filesystemUuid: FS, readOnly: true, mountMode: "read-only", deviceIdentitySha256: `sha256:${"1".repeat(64)}`, filesystemType: "ext4", transport: "usb", volumeLabel: "OFFLINE", capacityBytes: 1000 }]; } },
    signatureVerifier: { async verifyFiles(value) { signatureCalls.push(value); return { valid: true, fingerprint: KEY }; } } });
  const found = await adapter.listAttached({ nodeId: NODE });
  assert.equal(found[0].manifestSha256, sha(manifest));
  assert.equal(found[0].mediaHandle, `offline-media.${NODE}.${MOUNT}`);
  assert.deepEqual(await adapter.readManifest({ mediaHandle: found[0].mediaHandle }), manifest);
  const verifiedManifest = await adapter.verifyManifest({ mediaHandle: found[0].mediaHandle, manifestBytes: manifest, detachedSignaturePath: "manifest.json.asc", expectedKeyFingerprint: KEY });
  assert.equal(verifiedManifest.status, "verified");
  const verifiedArtifact = await adapter.verifyArtifact({ mediaHandle: found[0].mediaHandle, relativePath: "pip/demo.whl", expectedSha256: sha(artifact), expectedBytes: artifact.length, detachedSignaturePath: "pip/demo.whl.asc", expectedKeyFingerprint: KEY });
  assert.equal(verifiedArtifact.integrity, "verified");
  assert.equal(verifiedArtifact.signatureStatus, "verified");
  assert.equal(signatureCalls.length, 2);
  await assert.rejects(adapter.verifyArtifact({ mediaHandle: found[0].mediaHandle, relativePath: "../secret", expectedSha256: sha(artifact), expectedBytes: artifact.length, detachedSignaturePath: null, expectedKeyFingerprint: null }), /path is invalid/);
});

test("offline media OpenPGP verifier runs one fixed non-networked command with read-only inputs", async () => {
  const calls = [], executor = { async run(value) { calls.push(value); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: `[GNUPG:] VALIDSIG ${KEY} 2026 0 0 0 0 0 0 0` }; } };
  const verifier = new OfflineMediaOpenPgpVerifier({ executor }); const root = `/run/teamaibox/offline-media/${MOUNT}`;
  const result = await verifier.verifyFiles({ payloadPath: `${root}/manifest.json`, signaturePath: `${root}/manifest.json.asc`, expectedFingerprint: KEY, allowedRoot: root });
  assert.equal(result.valid, true);
  assert.equal(calls[0].network, false);
  assert.equal(calls[0].readOnlyRoot, true);
  assert.deepEqual(calls[0].arguments.slice(-3), ["--verify", `${root}/manifest.json.asc`, `${root}/manifest.json`]);
});
