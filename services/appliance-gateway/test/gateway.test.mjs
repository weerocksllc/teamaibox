import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { signManagedNodeGatewayIdentity } from "../../../packages/authorization/src/managed-node-gateway-identity.mjs";
import { verifiedNodeIdentity } from "../server/main.mjs";

const NODE = "018f6f18-24d7-7c21-9b62-8c0174199502";

test("gateway signs a stable path-bound node identity envelope", () => {
  const input = {
    key: randomBytes(32), method: "POST", pathname: "/api/v1/appliance/heartbeat",
    timestamp: "2026-08-15T04:00:00.000Z", nonce: randomBytes(24).toString("base64url"), subjectNodeId: NODE,
    certificateFingerprint: `sha256:${"ab".repeat(32)}`,
  };
  assert.equal(signManagedNodeGatewayIdentity(input), signManagedNodeGatewayIdentity(input));
  assert.notEqual(signManagedNodeGatewayIdentity(input), signManagedNodeGatewayIdentity({ ...input, pathname: input.pathname + "/changed" }));
});

test("gateway accepts only an authorized SPIFFE node certificate", () => {
  const socket = { encrypted: true, authorized: true, getPeerCertificate() { return {
    subjectaltname: `DNS:localhost, URI:spiffe://teamaibox.local/node/${NODE}`,
    fingerprint256: "AB:".repeat(31) + "AB",
  }; } };
  assert.deepEqual(verifiedNodeIdentity(socket), { subjectNodeId: NODE, certificateFingerprint: `sha256:${"ab".repeat(32)}` });
  assert.equal(verifiedNodeIdentity({ ...socket, authorized: false }), null);
  assert.equal(verifiedNodeIdentity({ ...socket, getPeerCertificate() { return { subjectaltname: "DNS:wrong" }; } }), null);
});
