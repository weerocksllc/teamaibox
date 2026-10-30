import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProtectedOfficeMaintenanceSigner } from "../src/protected-office-maintenance-signer.mjs";
import { ProductionProtectedMaintenanceSignatureVerifier } from "../../scheduler/src/production-protected-maintenance-signature-verifier.mjs";

const NOW = "2026-09-05T03:00:00.000Z";
const WORKERS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
];

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teamaibox-protected-signer-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = join(root, "signer.key");
  const keyringFile = join(root, "keyring.json");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(privateKeyFile, 0o600);
  const publicKeyDigest = `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
  await writeFile(keyringFile, JSON.stringify({ schemaVersion: 1, keys: [{
    keyId: "protected-office-main-v1", algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), publicKeyDigest,
    status: "active", notBefore: "2026-09-05T02:00:00.000Z", notAfter: "2026-09-05T04:00:00.000Z",
  }] }));
  return { root, privateKeyFile, keyringFile };
}

function unsigned() {
  return {
    transactionId: "00000000-0000-4000-8000-000000000101",
    workerIds: [...WORKERS].reverse(),
    allowedOperations: ["protected-set.maintenance"],
    maintenanceGeneration: 7,
    issuedAt: NOW,
    expiresAt: "2026-09-05T03:10:00.000Z",
  };
}

test("signs only the exact short-lived protected Worker set and passes the production verifier", async (t) => {
  const value = await fixture(t);
  const signer = new ProtectedOfficeMaintenanceSigner({
    privateKeyFile: value.privateKeyFile, allowTestRoot: true,
  });
  const context = await signer.sign(unsigned());
  assert.deepEqual(context.workerIds, [...WORKERS].sort());
  assert.equal(context.signature.algorithm, "Ed25519");
  assert.match(context.signature.payloadDigest, /^sha256:[a-f0-9]{64}$/);

  const verifier = new ProductionProtectedMaintenanceSignatureVerifier({
    trustedKeyringFile: value.keyringFile, allowTestRoot: true,
  });
  const result = await verifier.verify({
    context, operation: "protected-set.maintenance",
    workers: WORKERS.map((workerId) => ({
      workerId, placementClass: "protected-resident", maintenanceGeneration: 7,
    })),
    now: new Date(NOW),
  });
  assert.equal(result.authorized, true);
  assert.equal(result.signatureVerified, true);
});

test("rejects symbolic, group-readable, non-Ed25519 and malformed maintenance material", async (t) => {
  const value = await fixture(t);
  const link = join(value.root, "link.key");
  await symlink(value.privateKeyFile, link);
  await assert.rejects(new ProtectedOfficeMaintenanceSigner({
    privateKeyFile: link, allowTestRoot: true,
  }).sign(unsigned()), /symbolic link/);

  await chmod(value.privateKeyFile, 0o640);
  await assert.rejects(new ProtectedOfficeMaintenanceSigner({
    privateKeyFile: value.privateKeyFile, allowTestRoot: true,
  }).sign(unsigned()), /protected bounded/);

  await chmod(value.privateKeyFile, 0o600);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(value.privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await assert.rejects(new ProtectedOfficeMaintenanceSigner({
    privateKeyFile: value.privateKeyFile, allowTestRoot: true,
  }).sign(unsigned()), /must be Ed25519/);
  await assert.rejects(new ProtectedOfficeMaintenanceSigner({
    privateKeyFile: value.privateKeyFile, allowTestRoot: true,
  }).sign({ ...unsigned(), allowedOperations: ["protected.stop"] }), /context is invalid/);
});
