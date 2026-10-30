import assert from "node:assert/strict";
import test from "node:test";

import { DelegatedPluginOperationDispatcher } from "../src/plugins/delegated-operation-dispatcher.mjs";

const identityId = "00000000-0000-4000-8000-000000001401";

function fixture({ role = "member" } = {}) {
  const calls = [];
  const dispatcher = new DelegatedPluginOperationDispatcher({
    database: { async query(sql, parameters) { calls.push(["query", parameters]); return { rows: role ? [{ role_key: role }] : [] }; } },
    teamDriveService: {
      async rootByScope(context, kind, key) { calls.push(["root", context, kind, key]); return { id: "00000000-0000-4000-8000-000000001402" }; },
      async list(context, rootId, options) { calls.push(["list", context, rootId, options]); return [{ id: "entry-1", rootId,
        parentId: null, kind: "file", name: "note.txt", revision: 1, updatedAt: "2026-08-14T00:00:00Z" }]; },
    },
  });
  return { dispatcher, calls };
}

test("files.list uses the live delegated identity and exact team role", async () => {
  const { dispatcher, calls } = fixture({ role: "team_admin" });
  const result = await dispatcher.invoke({ delegated: { identityId, permission: "file:read", resource: { kind: "team", key: "team.default" } },
    operation: "files.list", body: { path: "/notes", pageSize: 50 } });
  assert.equal(result.data.length, 1);
  assert.equal(calls.find(([kind]) => kind === "root")[1].teamRoles["team.default"], "manager");
});

test("unknown operation, write authority, malformed body, and revoked team fail closed", async () => {
  for (const input of [
    { delegated: { identityId, permission: "file:write", resource: { kind: "team", key: "team.default" } }, operation: "files.list", body: { path: "/notes", pageSize: 50 } },
    { delegated: { identityId, permission: "file:read", resource: { kind: "team", key: "team.default" } }, operation: "files.delete", body: { path: "/notes", pageSize: 50 } },
    { delegated: { identityId, permission: "file:read", resource: { kind: "team", key: "team.default" } }, operation: "files.list", body: { path: "/", pageSize: 50 } },
  ]) await assert.rejects(fixture().dispatcher.invoke(input));
  await assert.rejects(fixture({ role: null }).dispatcher.invoke({ delegated: { identityId, permission: "file:read", resource: { kind: "team", key: "team.default" } },
    operation: "files.list", body: { path: "/notes", pageSize: 50 } }), (error) => error.code === "plugin_delegation_scope_revoked");
});
