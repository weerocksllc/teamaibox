import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryCastingEphemeralStore } from "../src/casting/memory-casting-ephemeral-store.mjs";
import { MemoryCastingRepository } from "../src/casting/memory-casting-repository.mjs";

const SESSION = "10000000-0000-4000-8000-000000000001";
const GROUP = "10000000-0000-4000-8000-000000000002";
const OWNER = "20000000-0000-4000-8000-000000000001";
const VIEWER = "20000000-0000-4000-8000-000000000002";
const INVITATION = "30000000-0000-4000-8000-000000000001";

function pendingInvitation(expiresAt) {
  return {
    invitationId: INVITATION,
    inviteeIdentityId: VIEWER,
    invitedByIdentityId: OWNER,
    issuedAt: new Date("2026-10-16T08:00:00.000Z"),
    expiresAt,
  };
}

async function repositoryWithInvitation({ invitationExpiresAt, sessionExpiresAt }) {
  const repository = new MemoryCastingRepository();
  await repository.createSession({
    session: {
      sessionId: SESSION,
      applianceNodeId: GROUP,
      initiatorIdentityId: OWNER,
      outputSinks: ["browser"],
      browserAudience: "selected_users",
      createdAt: new Date("2026-10-16T08:00:00.000Z"),
      updatedAt: new Date("2026-10-16T08:00:00.000Z"),
      expiresAt: sessionExpiresAt,
    },
    targets: [{
      targetId: "40000000-0000-4000-8000-000000000001",
      targetKind: "user",
      targetIdentityId: VIEWER,
      targetTeamId: null,
      createdByIdentityId: OWNER,
      createdAt: new Date("2026-10-16T08:00:00.000Z"),
    }],
    invitations: [pendingInvitation(invitationExpiresAt)],
  });
  return repository;
}

test("terminal session cleanup revokes an abandoned invitation without retaining media secrets", async () => {
  const repository = await repositoryWithInvitation({
    invitationExpiresAt: new Date("2026-10-16T08:15:00.000Z"),
    sessionExpiresAt: new Date("2026-10-16T09:00:00.000Z"),
  });
  await repository.transitionSession({
    sessionId: SESSION,
    expectedStateRevision: 1,
    toState: "stopped",
    actorIdentityId: OWNER,
    reasonCode: "cast_stopped_by_initiator",
    at: new Date("2026-10-16T08:01:00.000Z"),
  });

  const invitation = await repository.getInvitation(INVITATION);
  assert.equal(invitation.state, "revoked");
  assert.equal(invitation.reasonCode, "cast_stopped_by_initiator");
  assert.equal((await repository.listInvitationsForIdentity(
    VIEWER,
    new Date("2026-10-16T08:01:01.000Z"),
  )).length, 0);

  const durable = JSON.stringify({
    session: await repository.getSession(SESSION),
    invitation,
    events: await repository.listEvents(SESSION),
  });
  for (const forbidden of ["pairingPin", "mediaCredential", "accessToken", "sourceDeviceLabel", "Team-AI-"]) {
    assert.equal(durable.includes(forbidden), false, forbidden);
  }
});

test("invitation TTL removes an abandoned invitation from the recipient inbox", async () => {
  const repository = await repositoryWithInvitation({
    invitationExpiresAt: new Date("2026-10-16T08:00:10.000Z"),
    sessionExpiresAt: new Date("2026-10-16T09:00:00.000Z"),
  });
  await repository.expireDue(new Date("2026-10-16T08:00:11.000Z"));
  const invitation = await repository.getInvitation(INVITATION);
  assert.equal(invitation.state, "expired");
  assert.equal(invitation.reasonCode, "cast_invitation_expired");
  assert.equal((await repository.listInvitationsForIdentity(
    VIEWER,
    new Date("2026-10-16T08:00:11.000Z"),
  )).length, 0);
});

test("stop, expiry and close erase process-local PIN, source label and viewer credential authority", () => {
  let now = new Date("2026-10-16T08:00:00.000Z");
  const store = new MemoryCastingEphemeralStore({
    clock: () => new Date(now),
    randomIntFactory: () => 4321,
    randomBytesFactory: (length) => Buffer.alloc(length, 7),
  });
  const first = store.createSession({ sessionId: SESSION, expiresAt: "2026-10-16T08:10:00.000Z" });
  store.verifyAndPair({ sessionId: SESSION, pin: first.pin,
    sourceConnectionId: "source-connection-0001", sourceDeviceLabel: "private-phone-name" });
  const credential = store.issueViewerCredential({ sessionId: SESSION, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-0001", expiresAt: "2026-10-16T08:05:00.000Z" });
  assert.equal(store.destroySession(SESSION), true);
  assert.equal(store.describe(SESSION), null);
  assert.equal(store.verifyViewerCredential({ sessionId: SESSION, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-0001", mediaCredential: credential.mediaCredential }), false);

  store.createSession({ sessionId: SESSION, expiresAt: "2026-10-16T08:10:00.000Z" });
  now = new Date("2026-10-16T08:10:01.000Z");
  assert.equal(store.describe(SESSION), null);

  now = new Date("2026-10-16T08:20:00.000Z");
  store.createSession({ sessionId: SESSION, expiresAt: "2026-10-16T08:30:00.000Z" });
  store.close();
  assert.equal(store.describe(SESSION), null);
});
