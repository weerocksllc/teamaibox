import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserPlaybackPolicyV1,
  CastingApiError,
  castingClientPolicyV1,
  castingSessionPerspectiveV1,
  createCastingApiV1,
  normalizeCastingAvailabilityV1,
  normalizeCastingInvitationV1,
  normalizeCastingJoinV1,
  normalizeCastingMediaConnectionV1,
  normalizeCastingSessionV1,
  normalizeCastingViewersV1,
  validateCastingDraftV1,
} from "../src/public/casting-client-v1.mjs";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const now = "2026-09-04T04:00:00.000Z";
const later = "2026-09-04T05:00:00.000Z";

function session(overrides = {}) {
  return {
    id: SESSION,
    object: "cast.session",
    state: "pairing",
    stateRevision: 3,
    audienceRevision: 1,
    outputSinks: ["browser"],
    browserAudience: "owner_only",
    expiresAt: later,
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
    terminalReasonCode: null,
    ...overrides,
  };
}

function disabledAvailability(overrides = {}) {
  return {
    schemaVersion: 1,
    object: "cast.availability",
    mode: "disabled",
    state: "unsupported",
    receiverReady: false,
    sessionStartAllowed: false,
    receiverAdvertisementAllowed: false,
    outputs: {
      browser: { state: "unavailable", reasonCode: "webrtc_plugin_missing" },
    },
    gates: [{ code: "airplay_supply_chain_human_decisions_pending", category: "legal", state: "blocked" }],
    limitations: { appleCertified: false, fairPlayDrmSupported: false, syntheticAcceptanceAllowed: false },
    successor: { atomicCutoverRequired: true },
    ...overrides,
  };
}

test("normalizes fail-closed availability and rejects disabled readiness claims", () => {
  const value = normalizeCastingAvailabilityV1(disabledAvailability());
  assert.equal(value.state, "unsupported");
  assert.equal(value.receiverReady, false);
  assert.equal(value.sessionStartAllowed, false);
  assert.equal(value.gates[0].state, "blocked");
  assert.throws(() => normalizeCastingAvailabilityV1(disabledAvailability({ receiverReady: true })),
    (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingAvailabilityV1(disabledAvailability({ gates: [] })),
    (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingAvailabilityV1(disabledAvailability({ sourceBindings: { secret: "leak" } })),
    (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingAvailabilityV1(disabledAvailability({
    mode: "runtime", state: "ready", receiverReady: true, sessionStartAllowed: true,
  })), (error) => error.code === "cast_response_invalid");
});

test("validates independent outputs and exact conditional audience invariants", () => {
  const hdmi = validateCastingDraftV1({ hdmi: true, browser: false, browserAudience: "selected_users",
    viewerUserIds: [VIEWER], viewerTeamId: TEAM, ttlSeconds: 1_800 }, ACTOR);
  assert.equal(hdmi.valid, false);
  assert.ok(hdmi.errors.includes("cast_output_invalid"));

  const users = validateCastingDraftV1({ hdmi: false, browser: true, browserAudience: "selected_users",
    viewerUserIds: [VIEWER], viewerTeamId: null, ttlSeconds: 900 }, ACTOR);
  assert.equal(users.valid, true);
  assert.deepEqual(users.body.output_sinks, ["browser"]);
  assert.deepEqual(users.body.viewer_user_ids, [VIEWER]);

  const team = validateCastingDraftV1({ browser: true, browserAudience: "selected_team",
    viewerUserIds: [], viewerTeamId: TEAM, ttlSeconds: 7_200 }, ACTOR);
  assert.equal(team.valid, true);
  assert.equal(team.body.viewer_team_id, TEAM);

  assert.ok(validateCastingDraftV1({ browser: false, ttlSeconds: 1_800 }, ACTOR).errors.includes("cast_output_invalid"));
  assert.ok(validateCastingDraftV1({ hdmi: false, browser: true, browserAudience: "selected_users",
    viewerUserIds: [], ttlSeconds: 1_800 }, ACTOR).errors.includes("cast_selected_users_required"));
  assert.ok(validateCastingDraftV1({ hdmi: false, browser: true, browserAudience: "selected_team",
    viewerUserIds: [], viewerTeamId: "not-a-team", ttlSeconds: 1_800 }, ACTOR).errors.includes("cast_selected_team_required"));
  assert.ok(validateCastingDraftV1({ hdmi: true, browser: false, ttlSeconds: 30 }, ACTOR).errors.includes("cast_ttl_invalid"));
});

test("derives authority only from the server view and never from platform role", () => {
  const initiator = normalizeCastingSessionV1(session({ viewerUserIds: [], viewerTeamId: null,
    receiver: { name: "Team-AI-7A3B9C01EF", pin: "4921", sourcePaired: false, sourceDeviceLabel: null },
    outputHealth: { receiverHealthy: true, outputs: { browser: "available" } } }));
  assert.equal(initiator.perspective, "initiator");
  assert.equal(castingSessionPerspectiveV1(session()), "viewer");

  const manager = normalizeCastingSessionV1(session({ object: "cast.session.health", viewerCount: 2,
    outputHealth: { receiverHealthy: true, outputs: { browser: "available" } } }));
  assert.equal(manager.perspective, "manager");
  assert.equal(Object.hasOwn(manager, "receiver"), false);
  assert.throws(() => normalizeCastingSessionV1({ ...manager, receiver: { name: "leak" } }),
    (error) => error instanceof CastingApiError && error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingSessionV1(session({ viewerUserIds: [], viewerTeamId: null,
    receiver: { name: "Team-AI-Owner", pin: "4921", sourcePaired: false, sourceDeviceLabel: null } })),
  (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingSessionV1(session({ viewerUserIds: [], viewerTeamId: null,
    receiver: { name: "Team-AI-7A3B9C01EF", pin: "12345", sourcePaired: false, sourceDeviceLabel: null } })),
  (error) => error.code === "cast_response_invalid");
});

test("terminal stop replies may omit former targets without accepting empty active audiences", () => {
  for (const audience of ["selected_users", "selected_team"]) {
    const omitted = { browserAudience: audience, viewerUserIds: [], viewerTeamId: null, outputHealth: null };
    for (const state of ["stopped", "expired", "failed"]) {
      const normalized = normalizeCastingSessionV1(session({ ...omitted, state,
        terminalAt: now, terminalReasonCode: "cast_stopped_by_initiator" }));
      assert.equal(normalized.state, state);
      assert.equal(Object.hasOwn(normalized, "receiver"), false);
    }
    assert.throws(() => normalizeCastingSessionV1(session(omitted)), error => error.code === "cast_response_invalid");
    assert.throws(() => normalizeCastingSessionV1(session({ ...omitted, state: "stopped" })),
      error => error.code === "cast_response_invalid");
  }
});

test("casting responses use exact perspective and nested allowlists instead of retaining unknown server fields", () => {
  const viewer = session();
  const owner = session({ viewerUserIds: [], viewerTeamId: null,
    receiver: { name: "Team-AI-7A3B9C01EF", pin: "4921", sourcePaired: false, sourceDeviceLabel: null },
    outputHealth: { receiverHealthy: true, outputs: { browser: "available" } } });
  const manager = session({ object: "cast.session.health", viewerCount: 0,
    outputHealth: { receiverHealthy: true, outputs: { browser: "available" } },
    receiverHealthy: true });
  for (const injected of [
    { ...viewer, mediaCredential: "secret" },
    { ...viewer, receiver: owner.receiver },
    { ...owner, mediaCredential: "secret" },
    { ...owner, receiver: { ...owner.receiver, mediaCredential: "secret" } },
    { ...owner, outputHealth: { ...owner.outputHealth, mediaCredential: "secret" } },
    { ...manager, sourceDeviceLabel: "Secret iPhone" },
  ]) {
    assert.throws(() => normalizeCastingSessionV1(injected),
      (error) => error instanceof CastingApiError && error.code === "cast_response_invalid");
  }
  assert.deepEqual(Object.keys(normalizeCastingSessionV1(viewer)).sort(),
    [...Object.keys(viewer), "perspective"].sort());
  assert.equal(normalizeCastingSessionV1(owner).receiver.name, "Team-AI-7A3B9C01EF");
  assert.equal(normalizeCastingSessionV1(manager).receiverHealthy, true);
});

test("invitation, viewer, and viewer-grant responses reject secret or unknown fields", () => {
  const invitation = { id: VIEWER, object: "cast.viewer_invitation", sessionId: SESSION, state: "pending",
    audienceRevision: 1, issuedAt: now, expiresAt: later, resolvedAt: null };
  assert.equal(normalizeCastingInvitationV1(invitation).sessionId, SESSION);
  assert.throws(() => normalizeCastingInvitationV1({ ...invitation, mediaCredential: "secret" }),
    (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingViewersV1({ object: "list", data: [{
    viewerIdentityId: VIEWER, displayName: "Viewer", joinedAt: now, expiresAt: later,
    sourceDeviceLabel: "Secret iPhone",
  }] }), (error) => error.code === "cast_response_invalid");
  const grant = { sessionId: SESSION, viewerIdentityId: VIEWER,
    grantId: "55555555-5555-4555-8555-555555555555", mediaCredential: "A".repeat(43),
    expiresAt: later, muted: true };
  assert.equal(normalizeCastingJoinV1(grant).mediaCredential.length, 43);
  assert.throws(() => normalizeCastingJoinV1({ ...grant, sourceDeviceLabel: "Secret iPhone" }),
    (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingJoinV1({ ...grant, mediaCredential: "A".repeat(44) }),
    (error) => error.code === "cast_response_invalid");
  const connection = { sessionId: SESSION, viewerIdentityId: VIEWER,
    grantId: "55555555-5555-4555-8555-555555555555", url: "wss://casting.test/livekit",
    accessToken: `${"a".repeat(16)}.${"b".repeat(32)}.${"c".repeat(16)}`,
    expiresAt: later, muted: true };
  assert.equal(normalizeCastingMediaConnectionV1(connection).url, "wss://casting.test/livekit");
  assert.throws(() => normalizeCastingMediaConnectionV1({ ...connection, url: "ws://casting.test/livekit" }),
    (error) => error.code === "cast_response_invalid");
  assert.throws(() => normalizeCastingMediaConnectionV1({ ...connection, sourceDeviceLabel: "leak" }),
    (error) => error.code === "cast_response_invalid");
});

test("browser playback rejects legacy dual output and respects the explicit join boundary", () => {
  assert.deepEqual(browserPlaybackPolicyV1(["browser"]), {
    available: true, explicitJoinRequired: true, initiallyMuted: false,
  });
  assert.deepEqual(browserPlaybackPolicyV1(["hdmi", "browser"]), {
    available: false, explicitJoinRequired: true, initiallyMuted: false,
  });
  assert.equal(castingClientPolicyV1.invitationAutoplay, false);
  assert.equal(castingClientPolicyV1.mediaCredentialPersistence, "memory-only");
  assert.equal(castingClientPolicyV1.mediaAccessTokenPersistence, "memory-only");
  assert.equal(castingClientPolicyV1.mediaReconnectPolicy, "fresh-explicit-join");
  assert.equal(castingClientPolicyV1.recordingAllowed, false);
  assert.equal(castingClientPolicyV1.userContentScreenshotsAllowed, false);
  assert.equal(castingClientPolicyV1.indexingAllowed, false);
  assert.equal(castingClientPolicyV1.objectStorePersistenceAllowed, false);
});

test("rejects duplicate viewers but accepts more than eight distinct viewers", () => {
  assert.throws(() => normalizeCastingViewersV1({ object: "list", data: [
    { viewerIdentityId: VIEWER, displayName: "Viewer", joinedAt: now, expiresAt: later },
    { viewerIdentityId: VIEWER, displayName: "Viewer", joinedAt: now, expiresAt: later },
  ] }), (error) => error.code === "cast_response_invalid");
  assert.equal(normalizeCastingViewersV1({ object: "list", data: Array.from({ length: 9 }, (_, index) => ({
    viewerIdentityId: `00000000-0000-4000-8000-00000000000${index}`, displayName: "Viewer", joinedAt: now, expiresAt: later,
  })) }).length, 9);
});

test("mutations carry same-origin CSRF and start idempotency while accept never joins", async () => {
  const calls = [];
  const invitation = { id: VIEWER, object: "cast.viewer_invitation", sessionId: SESSION, state: "accepted",
    audienceRevision: 1, issuedAt: now, expiresAt: later, resolvedAt: now };
  const api = createCastingApiV1({
    cookie: () => "__Host-teamaibox-csrf=csrf-token",
    randomUUID: () => "55555555-5555-4555-8555-555555555555",
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify(invitation), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await api.accept(VIEWER);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/v1/casting/invitations/${VIEWER}/accept`);
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers["x-csrf-token"], "csrf-token");
  assert.equal(calls.some((call) => call.path.endsWith("/join")), false);

  const owner = session({ viewerUserIds: [], viewerTeamId: null, receiver: {
    name: "Team-AI-7A3B9C01EF", pin: "4921", sourcePaired: false, sourceDeviceLabel: null,
  }, outputHealth: { receiverHealthy: true, outputs: { browser: "available" } } });
  const startCalls = [];
  const startApi = createCastingApiV1({ cookie: () => "__Host-teamaibox-csrf=csrf-token",
    randomUUID: () => "55555555-5555-4555-8555-555555555555",
    fetchImpl: async (path, options) => { startCalls.push({ path, options }); return new Response(JSON.stringify(owner)); } });
  await startApi.start({ output_sinks: ["browser"], browser_audience: "owner_only", viewer_user_ids: [], viewer_team_id: null, ttl_seconds: 1_800 });
  assert.equal(startCalls[0].options.headers["idempotency-key"], "cast-start:55555555-5555-4555-8555-555555555555");
});

test("every mutation normalizes its response before application state can consume it", async () => {
  const invitation = { id: VIEWER, object: "cast.viewer_invitation", sessionId: SESSION, state: "pending",
    audienceRevision: 1, issuedAt: now, expiresAt: later, resolvedAt: null };
  const responses = new Map([
    [`/api/v1/casting/sessions/${SESSION}/invitations`, { ...invitation, mediaCredential: "leak" }],
    [`/api/v1/casting/invitations/${VIEWER}/accept`, { ...invitation, state: "accepted", resolvedAt: now,
      mediaCredential: "leak" }],
    [`/api/v1/casting/invitations/${VIEWER}/decline`, { ...invitation, state: "declined", resolvedAt: now,
      mediaCredential: "leak" }],
    [`/api/v1/casting/sessions/${SESSION}/join`, { sessionId: SESSION, viewerIdentityId: VIEWER,
      grantId: "55555555-5555-4555-8555-555555555555", mediaCredential: "A".repeat(43),
      expiresAt: later, muted: true, sourceDeviceLabel: "leak" }],
    [`/api/v1/casting/sessions/${SESSION}/media-connection`, { sessionId: SESSION, viewerIdentityId: VIEWER,
      grantId: "55555555-5555-4555-8555-555555555555", url: "wss://casting.test/livekit",
      accessToken: `${"a".repeat(16)}.${"b".repeat(32)}.${"c".repeat(16)}`,
      expiresAt: later, muted: true, sourceDeviceLabel: "leak" }],
    [`/api/v1/casting/sessions/${SESSION}/leave`, { sessionId: SESSION, left: true, receiver: "leak" }],
    [`/api/v1/casting/sessions/${SESSION}/viewers/${VIEWER}/remove`, {
      sessionId: SESSION, viewerIdentityId: VIEWER, removed: true, receiver: "leak",
    }],
  ]);
  const api = createCastingApiV1({ cookie: () => "__Host-teamaibox-csrf=csrf-token",
    fetchImpl: async (path) => new Response(JSON.stringify(responses.get(path)), { status: 200 }) });
  for (const action of [
    () => api.invite(SESSION, VIEWER),
    () => api.accept(VIEWER),
    () => api.decline(VIEWER),
    () => api.join(SESSION, VIEWER, "browser-instance-0001"),
    () => api.mediaConnection(SESSION, "A".repeat(43), "browser-instance-0001"),
    () => api.leave(SESSION),
    () => api.removeViewer(SESSION, VIEWER),
  ]) {
    await assert.rejects(action(), (error) => error.code === "cast_response_invalid");
  }
});

test("leaving a viewing page sends its browser scope while legacy all-page leave remains compatible", async () => {
  const calls=[];
  const api=createCastingApiV1({cookie:()=>"__Host-teamaibox-csrf=csrf-token",
    fetchImpl:async(path,options)=>{calls.push({path,options});return new Response(JSON.stringify({sessionId:SESSION,left:true}));}});
  await api.leave(SESSION,"browser-instance-test-one");
  await api.leave(SESSION);
  assert.deepEqual(JSON.parse(calls[0].options.body),{browserInstanceId:"browser-instance-test-one"});
  assert.deepEqual(JSON.parse(calls[1].options.body),{});
  assert.equal(calls[0].options.headers["x-csrf-token"],"csrf-token");
});

test("availability is an authenticated same-origin read without CSRF", async () => {
  const calls = [];
  const api = createCastingApiV1({ fetchImpl: async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify(disabledAvailability()), { status: 200 });
  } });
  const value = await api.availability();
  assert.equal(value.mode, "disabled");
  assert.equal(calls[0].path, "/api/v1/casting/availability");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-csrf-token"), false);
});
