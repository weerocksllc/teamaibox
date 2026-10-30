import { createHmac } from "node:crypto";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{22,86}$/;

export function canonicalManagedNodeGatewayIdentity({ method, pathname, timestamp, nonce, subjectNodeId, certificateFingerprint }) {
  return ["teamaibox-node-gateway-v1", method, pathname, timestamp, nonce, subjectNodeId, certificateFingerprint].join("\n");
}

export function signManagedNodeGatewayIdentity({ key, method, pathname, timestamp, nonce, subjectNodeId, certificateFingerprint }) {
  if (!Buffer.isBuffer(key) || key.byteLength < 32 || !/^[A-Z]+$/.test(method ?? "") || typeof pathname !== "string" || !pathname.startsWith("/")
      || !UUID.test(subjectNodeId ?? "") || !SHA256.test(certificateFingerprint ?? "") || !NONCE.test(nonce ?? "")
      || !Number.isFinite(Date.parse(timestamp ?? ""))) throw new TypeError("managed node gateway identity declaration is invalid");
  const canonical = canonicalManagedNodeGatewayIdentity({ method, pathname, timestamp, nonce, subjectNodeId: subjectNodeId.toLowerCase(), certificateFingerprint });
  return createHmac("sha256", key).update(canonical).digest("base64url");
}
