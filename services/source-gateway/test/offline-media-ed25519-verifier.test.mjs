import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OfflineMediaEd25519Verifier } from "../src/offline-media-ed25519-verifier.mjs";

test("Ed25519 offline media verifier binds payload, detached signature, keyring, and fingerprint", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teamaibox-offline-signature-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = join(root, "media"); await mkdir(mediaRoot);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").toUpperCase();
  const payload = Buffer.from('{"schemaVersion":1}\n');
  const payloadPath = join(mediaRoot, "manifest.json"), signaturePath = join(mediaRoot, "manifest.json.sig"), keyringPath = join(root, "keys.json");
  await writeFile(payloadPath, payload);
  await writeFile(signaturePath, JSON.stringify({ schemaVersion: 1, keyFingerprint: fingerprint, signatureBase64: sign(null, payload, privateKey).toString("base64") }));
  await writeFile(keyringPath, JSON.stringify({ schemaVersion: 1, keys: [{ fingerprint, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) }] }));
  const verifier = new OfflineMediaEd25519Verifier({ trustedKeyringFile: keyringPath, allowTestRoot: true });
  assert.deepEqual(await verifier.verifyFiles({ payloadPath, signaturePath, expectedFingerprint: fingerprint, allowedRoot: mediaRoot }), { valid: true, fingerprint });
  await writeFile(payloadPath, Buffer.from('{"schemaVersion":2}\n'));
  assert.deepEqual(await verifier.verifyFiles({ payloadPath, signaturePath, expectedFingerprint: fingerprint, allowedRoot: mediaRoot }), { valid: false, fingerprint });
});
