import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresCredentialRepository } from "../src/identity/postgres-credential-repository.mjs";

const ID = "018f6f18-24d7-7c21-9b62-8c0174199701";
const SUBJECT = "018f6f18-24d7-7c21-9b62-8c0174199702";
const NOW = new Date("2026-08-25T00:00:00.000Z");
const row = {
  id: ID, subject_identity_id: SUBJECT, credential_kind: "developer", display_name: "CLI",
  token_hint: "taib_sk_abcdefgh", token_hash: Buffer.alloc(32, 1),
  scopes: [{ permissionKey: "ai:invoke", resourceKind: "appliance", resourceKey: "*" }],
  created_by_identity_id: SUBJECT, created_at: NOW, expires_at: new Date("2026-08-26T00:00:00.000Z"),
  last_used_at: null, revoked_at: null, revoke_reason: null,
};

test("PostgreSQL credential repository maps principals and persists only token digests", async () => {
  const calls = [];
  const database = { async query(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql.includes("FROM iam.identities identity")) return { rows: [{ id: SUBJECT, identity_kind: "local_user", status: "active",
      role_bindings: [{ roleKey: "developer", scopeKind: "appliance", scopeKey: "*", grantedAt: NOW, expiresAt: null }], service_grants: [] }] };
    if (sql.startsWith("INSERT INTO iam.api_credentials")) return { rows: [row] };
    if (sql.includes("WHERE token_hash=$1") || sql.includes("WHERE id=$1") || sql.includes("WHERE subject_identity_id=$1")) return { rows: [row] };
    if (sql.startsWith("UPDATE iam.api_credentials")) return { rows: [{ id: ID }] };
    throw new Error("unexpected query");
  } };
  const repository = new PostgresCredentialRepository({ database });
  const principal = await repository.loadPrincipalAccess(SUBJECT);
  assert.equal(principal.roleBindings[0].roleKey, "developer");
  const inserted = await repository.insertCredential({ subjectIdentityId: SUBJECT, kind: "developer", displayName: "CLI",
    hint: "taib_sk_abcdefgh", tokenHash: "01".repeat(32), scopes: row.scopes,
    createdByIdentityId: SUBJECT, createdAt: NOW, expiresAt: row.expires_at, lastUsedAt: null, revokedAt: null, revokeReason: null });
  assert.equal(inserted.tokenHash, "01".repeat(32));
  assert.equal(Buffer.isBuffer(calls.find((value) => value.sql.startsWith("INSERT INTO iam.api_credentials")).parameters[4]), true);
  assert.equal((await repository.findCredentialByHash("01".repeat(32))).id, ID);
  assert.equal((await repository.findCredentialById(ID)).id, ID);
  assert.equal((await repository.listCredentialsForSubject(SUBJECT)).length, 1);
  assert.equal(await repository.touchCredential(ID, NOW), true);
  assert.equal(await repository.revokeCredential(ID, NOW, "device_lost"), true);
});

test("PostgreSQL credential hash uniqueness maps to bounded retry semantics", async () => {
  const database = { async query() { const error = new Error("duplicate"); error.code = "23505"; throw error; } };
  const repository = new PostgresCredentialRepository({ database });
  await assert.rejects(repository.insertCredential({ subjectIdentityId: SUBJECT, kind: "developer", displayName: "CLI",
    hint: "taib_sk_abcdefgh", tokenHash: "01".repeat(32), scopes: row.scopes,
    createdByIdentityId: SUBJECT, createdAt: NOW, expiresAt: row.expires_at }), { code: "credential_collision" });
});
