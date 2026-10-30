const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PEM_CSR = /^-----BEGIN CERTIFICATE REQUEST-----\n[\s\S]{1,16000}\n-----END CERTIFICATE REQUEST-----\n?$/;
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n?$/;
const REASONS = new Set(["enrollment_commit_failed", "node_removed", "certificate_replaced", "administrator_revoked"]);

function validIssued(value, expected) {
  return value && PEM_CERTIFICATE.test(value.certificatePem ?? "")
    && PEM_CERTIFICATE.test(value.caChainPem ?? "")
    && SHA256.test(value.fingerprintSha256 ?? "")
    && value.publicKeyFingerprint === expected.expectedPublicKeyFingerprint
    && value.subjectNodeId === expected.subjectNodeId
    && Array.isArray(value.usages)
    && value.usages.length === 2
    && value.usages[0] === "clientAuth"
    && value.usages[1] === "serverAuth"
    && value.notAfter instanceof Date
    && Number.isFinite(value.notAfter.getTime());
}

/**
 * Scheduler-side adapter for the protected appliance CA. The signer owns the
 * CA private key in its encrypted service volume; this adapter never accepts,
 * returns, logs, or persists that key and constrains every signing request to
 * the managed-node profile.
 */
export class ProtectedNodeCertificateAuthority {
  #signer;
  #clock;
  #validitySeconds;

  constructor({ signer, clock = () => new Date(), validitySeconds = 31_536_000 }) {
    if (typeof signer?.issue !== "function" || typeof signer?.revoke !== "function"
      || typeof clock !== "function" || !Number.isSafeInteger(validitySeconds)
      || validitySeconds < 86_400 || validitySeconds > 31_536_000) {
      throw new TypeError("Protected node certificate authority configuration is invalid");
    }
    this.#signer = signer;
    this.#clock = clock;
    this.#validitySeconds = validitySeconds;
  }

  async issueNodeCertificate({ csrPem, subjectNodeId, nodeKey, expectedPublicKeyFingerprint, usages }) {
    if (!PEM_CSR.test(csrPem ?? "") || !UUID.test(subjectNodeId ?? "")
      || !KEY.test(nodeKey ?? "")
      || !SHA256.test(expectedPublicKeyFingerprint ?? "")
      || !Array.isArray(usages) || usages.length !== 2
      || usages[0] !== "clientAuth" || usages[1] !== "serverAuth") {
      throw new TypeError("Managed node certificate request is invalid");
    }
    const issuedAt = this.#clock();
    const request = Object.freeze({
      profile: "teamaibox-managed-node-v1",
      csrPem,
      subjectNodeId,
      subjectUri: `spiffe://teamaibox.local/node/${subjectNodeId}`,
      dnsNames: Object.freeze([nodeKey]),
      expectedPublicKeyFingerprint,
      usages: Object.freeze(["clientAuth", "serverAuth"]),
      issuedAt: issuedAt.toISOString(),
      validitySeconds: this.#validitySeconds,
    });
    const value = await this.#signer.issue(request);
    const normalized = value ? { ...value, notAfter: new Date(value.notAfter) } : null;
    if (!validIssued(normalized, request) || normalized.notAfter <= issuedAt
      || normalized.notAfter.getTime() > issuedAt.getTime() + (this.#validitySeconds + 300) * 1000) {
      throw new TypeError("Protected signer returned invalid managed node evidence");
    }
    return Object.freeze({
      certificatePem: normalized.certificatePem,
      caChainPem: normalized.caChainPem,
      fingerprintSha256: normalized.fingerprintSha256,
      notAfter: normalized.notAfter,
    });
  }

  async revokeNodeCertificate({ nodeId, certificateFingerprint, reason }) {
    if (!UUID.test(nodeId ?? "") || !SHA256.test(certificateFingerprint ?? "") || !REASONS.has(reason)) {
      throw new TypeError("Managed node certificate revocation is invalid");
    }
    const revokedAt = this.#clock();
    const value = await this.#signer.revoke(Object.freeze({
      profile: "teamaibox-managed-node-v1",
      subjectNodeId: nodeId,
      certificateFingerprint,
      reason,
      revokedAt: revokedAt.toISOString(),
    }));
    if (value?.revoked !== true || value.certificateFingerprint !== certificateFingerprint) {
      throw new TypeError("Protected signer returned invalid revocation evidence");
    }
    return Object.freeze({ revoked: true, certificateFingerprint, revokedAt: revokedAt.toISOString() });
  }

  async revokeNodeCertificateOnce({ operationId, idempotencyKey, nodeId, certificateFingerprint, reason }) {
    if (!UUID.test(operationId ?? "") || !SHA256.test(idempotencyKey ?? "")
        || !UUID.test(nodeId ?? "") || !SHA256.test(certificateFingerprint ?? "") || !REASONS.has(reason)) {
      throw new TypeError("Managed node certificate idempotent revocation is invalid");
    }
    const revokedAt = this.#clock();
    const value = await this.#signer.revoke(Object.freeze({
      profile: "teamaibox-managed-node-v1",
      operationId,
      idempotencyKey,
      subjectNodeId: nodeId,
      certificateFingerprint,
      reason,
      revokedAt: revokedAt.toISOString(),
    }));
    if (value?.revoked !== true || value.operationId !== operationId
        || value.idempotencyKey !== idempotencyKey || value.certificateFingerprint !== certificateFingerprint) {
      throw new TypeError("Protected signer returned invalid idempotent revocation evidence");
    }
    return Object.freeze({ revoked: true, operationId, idempotencyKey, certificateFingerprint,
      revokedAt: revokedAt.toISOString(), replayed: value.replayed === true });
  }
}
