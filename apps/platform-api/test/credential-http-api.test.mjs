import assert from "node:assert/strict";
import { test } from "node:test";

import { CredentialHttpApi } from "../src/identity/credential-http-api.mjs";

const ID = "018f6f18-24d7-7c21-9b62-8c0174199701";

test("credential HTTP API exposes developer and administrator service lifecycles without a general user key surface", async () => {
  const calls = [];
  const api = new CredentialHttpApi({ service: {
    async issueDeveloperCredential(value) { calls.push(["developer", value]); return { credential: { id: ID }, secret: "one-time" }; },
    async issueServiceCredential(value) { calls.push(["service", value]); return { credential: { id: ID }, secret: "one-time" }; },
    async listCredentials(value) { calls.push(["list", value]); return [{ id: ID }]; },
    async revokeCredential(value) { calls.push(["revoke", value]); return { credentialId: value.credentialId, revoked: true }; },
  } });
  const context = { identityId: ID, permissions: ["developer_credential:create"] };
  assert.equal(api.matches("GET", "/api/v1/developer/credentials"), true);
  assert.equal(api.matches("GET", "/api/v1/user/api-keys"), false);
  const issued = await api.handle({ method: "POST", pathname: "/api/v1/developer/credentials", context,
    body: { display_name: "CLI", expires_at: "2026-08-26T00:00:00.000Z",
      scopes: [{ permission_key: "ai:invoke", resource_kind: "appliance", resource_key: "*" }] } });
  assert.equal(issued.status, 201);
  assert.deepEqual(calls[0][1].scopes, [{ permissionKey: "ai:invoke", resourceKind: "appliance", resourceKey: "*" }]);
  const listed = await api.handle({ method: "GET", pathname: "/api/v1/admin/service-credentials", context,
    query: new URLSearchParams({ subject_identity_id: ID }) });
  assert.equal(listed.body.data.length, 1);
  const revoked = await api.handle({ method: "DELETE", pathname: `/api/v1/developer/credentials/${ID}`, context,
    body: { reason: "device_lost" } });
  assert.equal(revoked.body.revoked, true);
});
