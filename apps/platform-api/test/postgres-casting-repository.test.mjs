import assert from "node:assert/strict";
import { test } from "node:test";

import { PostgresCastingRepository } from "../src/casting/postgres-casting-repository.mjs";

const SESSION = "50000000-0000-4000-8000-000000000001";
const GROUP = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000001";
const VIEWER = "20000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-04T08:00:00.000Z");

function sessionRow(overrides = {}) {
  return { id: SESSION, appliance_node_id: GROUP, initiator_identity_id: OWNER,
    session_state: "requested", state_revision: "1", output_sinks: ["browser"],
    browser_audience: "selected_users", audience_revision: "1", pairing_failed_attempts: 0,
    pairing_blocked_until: null, paired_at: null, started_at: null, terminal_at: null,
    terminal_reason_code: null, created_at: NOW, updated_at: NOW,
    expires_at: new Date(NOW.getTime() + 600_000), ...overrides };
}

class RecordingDatabase {
  calls = [];
  #handler;
  constructor(handler) { this.#handler = handler; }
  async query(sql, parameters = []) {
    const slots = [...new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])))].sort((a,b)=>a-b);
    assert.deepEqual(slots, parameters.map((_, i) => i+1), "Every SQL parameter must be typed by a used placeholder");
    this.calls.push({ sql, parameters });
    return { rows: await this.#handler(sql, parameters, this.calls.length) };
  }
  async transaction(callback) { return callback(this); }
}

test("PostgreSQL casting creation persists only lifecycle, audience, invitation, and event facts", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("INSERT INTO platform.cast_sessions")) return [sessionRow()];
    if (sql.includes("INSERT INTO platform.cast_viewer_invitations")) return [{ id: "60000000-0000-4000-8000-000000000001",
      session_id: SESSION, audience_revision: "1", invitee_identity_id: VIEWER,
      invited_by_identity_id: OWNER, invitation_state: "pending", revision: "1", issued_at: NOW,
      expires_at: new Date(NOW.getTime() + 300_000), resolved_at: null, resolution_reason_code: null }];
    return [];
  });
  const repository = new PostgresCastingRepository({ database });
  const created = await repository.createSession({ session: { sessionId: SESSION, applianceNodeId: GROUP,
    initiatorIdentityId: OWNER, outputSinks: ["browser"], browserAudience: "selected_users",
    createdAt: NOW, expiresAt: new Date(NOW.getTime() + 600_000) }, targets: [{
    targetId: "70000000-0000-4000-8000-000000000001", targetKind: "user", targetIdentityId: VIEWER,
    targetTeamId: null, createdByIdentityId: OWNER, createdAt: NOW,
  }], invitations: [{ invitationId: "60000000-0000-4000-8000-000000000001", sessionId: SESSION,
    audienceRevision: 1, inviteeIdentityId: VIEWER, invitedByIdentityId: OWNER, issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 300_000) }] });
  assert.equal(created.sessionId, SESSION);
  const serialized = JSON.stringify(database.calls);
  assert.doesNotMatch(serialized, /receiverName|mediaCredential|sourceDevice|browserInstance|pairingPin|decoded|frame/i);
  assert.ok(database.calls.some((call) => call.sql.includes("platform.cast_audience_targets")));
  assert.ok(database.calls.some((call) => call.sql.includes("platform.cast_viewer_invitations")));
  assert.ok(database.calls.some((call) => call.sql.includes("platform.cast_session_events")));
});

test("PostgreSQL share revocation uses the migration's atomic owner-only downgrade", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("SELECT viewer_identity_id")) return [{ viewer_identity_id: VIEWER }];
    if (sql.includes("downgrade_cast_audience_to_owner")) return [{ new_audience_revision: "2",
      revoked_target_count: 1, revoked_invitation_count: 1, revoked_viewer_count: 1 }];
    if (sql.includes("SELECT * FROM platform.cast_sessions")) return [sessionRow({ browser_audience: "owner_only",
      audience_revision: "2" })];
    return [];
  });
  const repository = new PostgresCastingRepository({ database });
  const result = await repository.downgradeAudienceToOwner({ sessionId: SESSION,
    initiatorIdentityId: OWNER, expectedAudienceRevision: 1, at: NOW });
  assert.equal(result.session.browserAudience, "owner_only");
  assert.deepEqual(result.revokedViewerIdentityIds, [VIEWER]);
  const call = database.calls.find((item) => item.sql.includes("downgrade_cast_audience_to_owner"));
  assert.deepEqual(call.parameters, [SESSION, OWNER, 1]);
});

test("PostgreSQL state transitions are optimistic and append a bounded safe event", async () => {
  const database = new RecordingDatabase((sql) => {
    if (sql.includes("UPDATE platform.cast_sessions SET")) return [sessionRow({ session_state: "starting", state_revision: "2" })];
    return [];
  });
  const repository = new PostgresCastingRepository({ database });
  const updated = await repository.transitionSession({ sessionId: SESSION, expectedStateRevision: 1,
    toState: "starting", actorIdentityId: OWNER, eventType: "session.state_changed", at: NOW });
  assert.equal(updated.state, "starting");
  assert.equal(updated.stateRevision, 2);
  assert.ok(database.calls.some((call) => call.sql.includes("platform.cast_session_events")));
});
