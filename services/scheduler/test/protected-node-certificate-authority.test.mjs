import assert from "node:assert/strict";
import test from "node:test";

import { ProtectedNodeCertificateAuthority } from "../src/protected-node-certificate-authority.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";
const KEY = `sha256:${"d".repeat(64)}`;
const CERT = `sha256:${"c".repeat(64)}`;
const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nZmFrZQ==\n-----END CERTIFICATE REQUEST-----\n";
const PEM = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";

test("protected CA adapter constrains issuance and never handles a CA private key", async () => {
  const calls = [];
  const adapter = new ProtectedNodeCertificateAuthority({
    clock: () => new Date("2026-08-11T08:00:00Z"),
    signer: {
      async issue(value) { calls.push(value); return { certificatePem: PEM, caChainPem: PEM, fingerprintSha256: CERT, publicKeyFingerprint: KEY, subjectNodeId: NODE, usages: ["clientAuth", "serverAuth"], notAfter: "2027-08-11T08:00:00Z" }; },
      async revoke(value) { calls.push(value); return { revoked: true, certificateFingerprint: value.certificateFingerprint,
        ...(value.operationId ? { operationId: value.operationId, idempotencyKey: value.idempotencyKey, replayed: false } : {}) }; },
    },
  });
  const issued = await adapter.issueNodeCertificate({ csrPem: CSR, subjectNodeId: NODE, nodeKey: "spark-node-02", expectedPublicKeyFingerprint: KEY, usages: ["clientAuth", "serverAuth"] });
  assert.equal(issued.fingerprintSha256, CERT);
  assert.equal(calls[0].subjectUri, `spiffe://teamaibox.local/node/${NODE}`);
  assert.deepEqual(calls[0].dnsNames, ["spark-node-02"]);
  assert.equal(calls[0].profile, "teamaibox-managed-node-v1");
  assert.equal(JSON.stringify(calls).includes("privateKey"), false);
  const revoked = await adapter.revokeNodeCertificate({ nodeId: NODE, certificateFingerprint: CERT, reason: "node_removed" });
  assert.equal(revoked.revoked, true);
  const once = await adapter.revokeNodeCertificateOnce({
    operationId: "018f6f18-24d7-7c21-9b62-8c0174199599",
    idempotencyKey: `sha256:${"e".repeat(64)}`,
    nodeId: NODE,
    certificateFingerprint: CERT,
    reason: "certificate_replaced",
  });
  assert.equal(once.revoked, true);
  assert.equal(calls.at(-1).operationId, once.operationId);
});

test("protected CA adapter rejects signer substitution and unsupported profiles", async () => {
  const adapter = new ProtectedNodeCertificateAuthority({ signer: { async issue() { return { certificatePem: PEM }; }, async revoke() { return { revoked: false }; } } });
  await assert.rejects(adapter.issueNodeCertificate({ csrPem: CSR, subjectNodeId: NODE, nodeKey: "spark-node-02", expectedPublicKeyFingerprint: KEY, usages: ["serverAuth", "clientAuth"] }), /request is invalid/);
  await assert.rejects(adapter.revokeNodeCertificate({ nodeId: NODE, certificateFingerprint: CERT, reason: "unknown" }), /revocation is invalid/);
  await assert.rejects(adapter.revokeNodeCertificateOnce({ operationId: "wrong", idempotencyKey: CERT,
    nodeId: NODE, certificateFingerprint: CERT, reason: "certificate_replaced" }), /idempotent revocation is invalid/);
});
