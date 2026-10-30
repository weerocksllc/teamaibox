import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  encodeProtectedMaintenanceSignaturePayload,
  ProductionProtectedMaintenanceSignatureVerifier,
} from "../src/production-protected-maintenance-signature-verifier.mjs";
import { authorizeProtectedResidentOperation } from "../src/protected-resident-guard.mjs";

const NOW = "2026-09-05T03:00:00.000Z";
const TRANSACTION = "00000000-0000-4000-8000-000000000101";
const WORKERS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
];

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teamaibox-maintenance-keyring-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDigest = `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
  const keyringFile = join(root, "keys.json");
  await writeFile(keyringFile, JSON.stringify({ schemaVersion: 1, keys: [{
    keyId: "ops-main-1", algorithm: "Ed25519",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), publicKeyDigest,
    status: "active", notBefore: "2026-09-05T02:00:00.000Z", notAfter: "2026-09-05T04:00:00.000Z",
  }] }), { mode: 0o600 });
  const unsigned = {
    transactionId: TRANSACTION, workerIds: [...WORKERS].reverse(),
    allowedOperations: ["protected-set.maintenance"], maintenanceGeneration: 7,
    issuedAt: NOW, expiresAt: "2026-09-05T03:10:00.000Z",
  };
  const payload = encodeProtectedMaintenanceSignaturePayload({ context: unsigned, operation: "protected-set.maintenance" });
  return {
    root, keyringFile,
    context: { ...unsigned, signature: {
      algorithm: "Ed25519", keyId: "ops-main-1",
      payloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
      value: sign(null, payload, privateKey).toString("base64url"),
    } },
  };
}

function workers() {
  return WORKERS.map((workerId) => ({ workerId, placementClass: "protected-resident", maintenanceGeneration: 7 }));
}

test("production verifier binds exact transaction, operation, generation, workers and key validity", async (t) => {
  const value = await fixture(t);
  const verifier = new ProductionProtectedMaintenanceSignatureVerifier({
    trustedKeyringFile: value.keyringFile, allowTestRoot: true,
  });
  const decision = await verifier.verify({
    context: value.context, operation: "protected-set.maintenance", workers: workers(), now: new Date(NOW),
  });
  assert.equal(decision.authorized, true);
  assert.equal(decision.signatureVerified, true);
  assert.deepEqual(decision.workerIds, [...WORKERS].sort());
  assert.equal(decision.signature.publicKeyDigest.startsWith("sha256:"), true);

  const normalized = await authorizeProtectedResidentOperation({
    workers: workers(), operation: "protected-set.maintenance", maintenanceContext: value.context,
    maintenanceAuthorizer: verifier.authorize.bind(verifier), now: new Date(NOW),
  });
  assert.equal(normalized.transactionId, TRANSACTION);
});

test("production verifier denies drifted payloads, unknown keys, expiration and incomplete worker sets", async (t) => {
  const value = await fixture(t);
  const verifier = new ProductionProtectedMaintenanceSignatureVerifier({ trustedKeyringFile: value.keyringFile, allowTestRoot: true });
  for (const input of [
    { context: { ...value.context, maintenanceGeneration: 8 }, workers: workers(), now: new Date(NOW) },
    { context: { ...value.context, signature: { ...value.context.signature, keyId: "ops-other-1" } }, workers: workers(), now: new Date(NOW) },
    { context: value.context, workers: workers().slice(0, 1), now: new Date(NOW) },
    { context: value.context, workers: workers(), now: new Date("2026-09-05T03:11:00.000Z") },
  ]) {
    const decision = await verifier.verify({ ...input, operation: "protected-set.maintenance" });
    assert.equal(decision.authorized, false);
    assert.equal(decision.signatureVerified, false);
  }
});

test("production verifier rejects unsafe paths, symbolic-link keyrings and invalid key digests", async (t) => {
  assert.throws(() => new ProductionProtectedMaintenanceSignatureVerifier({ trustedKeyringFile: "/tmp/keys.json" }), /configuration/);
  const value = await fixture(t);
  const link = join(value.root, "link.json");
  await symlink(value.keyringFile, link);
  const linked = new ProductionProtectedMaintenanceSignatureVerifier({ trustedKeyringFile: link, allowTestRoot: true });
  await assert.rejects(linked.verify({
    context: value.context, operation: "protected-set.maintenance", workers: workers(), now: new Date(NOW),
  }), /symbolic link/);

  const document = JSON.parse(await (await import("node:fs/promises")).readFile(value.keyringFile, "utf8"));
  document.keys[0].publicKeyDigest = `sha256:${"0".repeat(64)}`;
  await writeFile(value.keyringFile, JSON.stringify(document));
  const invalid = new ProductionProtectedMaintenanceSignatureVerifier({ trustedKeyringFile: value.keyringFile, allowTestRoot: true });
  await assert.rejects(invalid.verify({
    context: value.context, operation: "protected-set.maintenance", workers: workers(), now: new Date(NOW),
  }), /digest drifted/);
});

