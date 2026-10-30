import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDelegatedAccessControl } from "../src/postgres-delegated-access-control.mjs";

const identityId = "00000000-0000-7000-8000-000000001101";
const sessionId = "00000000-0000-7000-8000-000000001102";

test("PostgreSQL delegated access revalidates the live UUIDv7 local-user session", async () => {
  const calls = [];
  const access = new PostgresDelegatedAccessControl({ database: { async query(sql, parameters) {
    calls.push([sql, parameters]);
    return { rows: [{ identity_id: identityId, identity_kind: "local_user", status: "active" }] };
  } } });
  const resolved = await access.resolveSession({ identityId, sessionId }, new Date("2026-08-14T00:00:00Z"));
  assert.equal(resolved.identityId, identityId);
  assert.equal(resolved.sessionId, sessionId);
  assert.match(calls[0][0], /session\.password_version = identity\.password_version/);
  assert.match(calls[0][0], /session\.idle_expires_at/);
});

test("delegated authorization is exact to permission, resource, session, and unexpired role binding", async () => {
  const calls = [];
  const access = new PostgresDelegatedAccessControl({ database: { async query(sql, parameters) {
    calls.push([sql, parameters]); return { rows: [{ allowed: true }] };
  } } });
  assert.equal(await access.authorize({ identityId, sessionId, permission: "file:read",
    resource: { kind: "team", key: "team.default" }, now: new Date("2026-08-14T00:00:00Z") }), true);
  assert.deepEqual(calls[0][1].slice(0, 5), [sessionId, identityId, "file:read", "team", "team.default"]);
  assert.match(calls[0][0], /role_permission\.permission_key/);
  assert.match(calls[0][0], /binding\.expires_at/);
  assert.equal(await access.authorize({ identityId: "invalid", sessionId, permission: "file:read",
    resource: { kind: "team", key: "team.default" }, now: new Date() }), false);
});
