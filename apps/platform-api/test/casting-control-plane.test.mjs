import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  castingMediaPrivacyPolicyV1,
  CastingSessionService,
} from "../src/casting/casting-session-service.mjs";
import { MemoryCastingEphemeralStore } from "../src/casting/memory-casting-ephemeral-store.mjs";
import { MemoryCastingRepository } from "../src/casting/memory-casting-repository.mjs";
import { AuthenticatedCastingMediaAdmission } from "../src/casting/authenticated-media-admission.mjs";
import {
  matchesTrustedMediaCallbackRoute,
  trustedMediaTransportIdentity,
  TrustedMediaCallbackHttpApi,
  validateTrustedMediaCallbackContract,
} from "../src/casting/trusted-media-callback-api.mjs";

const GROUP = "10000000-0000-4000-8000-000000000001";
const OWNER = "20000000-0000-4000-8000-000000000001";
const VIEWER = "20000000-0000-4000-8000-000000000002";
const MANAGER = "20000000-0000-4000-8000-000000000003";
const TEAM = "30000000-0000-4000-8000-000000000001";
const TRUSTED_MEDIA_IDENTITY = "60000000-0000-4000-8000-000000000001";
const TRUSTED_MEDIA_FINGERPRINT = `sha256:${"ab".repeat(32)}`;
const MEDIA_ACCESS_TOKEN = `${"a".repeat(16)}.${"b".repeat(32)}.${"c".repeat(16)}`;

test("browser-only creation rejects every explicit legacy selector before admission or persistence", async () => {
  for (const outputSinks of [null, [], ["hdmi"], ["hdmi", "browser"], ["browser", "browser"], ["unknown"], "browser", [{}]]) {
    const f = fixture();
    await assert.rejects(f.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
      idempotencyKey: "legacy-rejected", input: { outputSinks, browserAudience: "owner_only", ttlSeconds: 600 } }),
      { code: "cast_output_invalid" });
    assert.deepEqual(f.runtimeEvents, []);
    assert.deepEqual(f.admission.calls, []);
    assert.equal(await f.repository.findActiveSession(GROUP), null);
  }
});

test("omitted selector defaults to browser and rejected legacy update preserves the active session", async () => {
  const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
  const current = await f.service.startSession({ context: owner, idempotencyKey: "browser-default",
    input: { browserAudience: "owner_only", ttlSeconds: 600 } });
  assert.deepEqual(current.outputSinks, ["browser"]);
  const before = await f.repository.getSession(current.id), count = f.runtimeEvents.length;
  await assert.rejects(f.service.updateAudience({ context: owner, sessionId: current.id,
    input: { outputSinks: ["hdmi"], browserAudience: null } }), { code: "cast_output_invalid" });
  assert.deepEqual(await f.repository.getSession(current.id), before);
  assert.equal(f.runtimeEvents.length, count);
  f.authorization.get(OWNER).permissions = ["cast:use"];
  await f.service.reconcileAuthorization(current.id);
  assert.equal((await f.repository.getSession(current.id)).state, "stopped");
  assert.equal(f.runtimeEvents.some(event => event.type === "update"), false);
});

function context(identityId, permissions, teamMemberships = []) {
  return { identityId, permissions: [...permissions], teamMemberships };
}

async function callbackContract({ runtimeBound = true } = {}) {
  const value = JSON.parse(await readFile(new URL(
    "../../../deploy/casting/trusted-media-callback-contract.v1.json", import.meta.url,
  ), "utf8"));
  if (runtimeBound) {
    value.status = "runtime-bound";
    value.serviceIdentity.certificateFingerprint = TRUSTED_MEDIA_FINGERPRINT;
    value.activationGate = { bound: true, blockers: [] };
    value.claimBoundary.runtimeBound = true;
  }
  return value;
}

function callbackIdentity(overrides = {}) {
  return { mutualTls: true, certificateVerified: true,
    subjectServiceIdentityId: TRUSTED_MEDIA_IDENTITY,
    certificateFingerprint: TRUSTED_MEDIA_FINGERPRINT, ...overrides };
}

function callbackHeaders(issuedAt = "2026-09-04T08:00:00.000Z", callbackId = randomUUID()) {
  return { "x-teamaibox-callback-id": callbackId, "x-teamaibox-callback-issued-at": issuedAt };
}

function readyAdmission(overrides = {}) {
  const status = {
    mode: "runtime",
    state: "ready",
    receiverReady: true,
    sessionStartAllowed: true,
    receiverAdvertisementAllowed: true,
    outputs: { hdmi: { state: "available" }, browser: { state: "available" } },
    gates: [],
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    status() { return structuredClone(status); },
    assertSessionStartAllowed(value) { calls.push(value); },
  };
}

function fixture({ maximumStartsPerWindow = 3, admission = readyAdmission(), stopRetryMilliseconds = 1_000,
  setTimeoutFactory, clearTimeoutFactory } = {}) {
  let now = new Date("2026-09-04T08:00:00.000Z");
  const repository = new MemoryCastingRepository();
  const ephemeralStore = new MemoryCastingEphemeralStore({ clock: () => new Date(now),
    randomIntFactory: () => 1234 });
  const authorization = new Map([
    [OWNER, { identityId: OWNER, permissions: ["cast:use", "cast:share", "cast:view", "cast:manage"], teamMemberships: [] }],
    [VIEWER, { identityId: VIEWER, permissions: ["cast:view"], teamMemberships: [{ teamId: TEAM, teamKey: "team.default" }] }],
    [MANAGER, { identityId: MANAGER, permissions: ["cast:manage"], teamMemberships: [] }],
  ]);
  const identities = new Map([
    [OWNER, { identityId: OWNER, displayName: "Owner", username: "owner", status: "active" }],
    [VIEWER, { identityId: VIEWER, displayName: "Viewer", username: "viewer", status: "active" }],
    [MANAGER, { identityId: MANAGER, displayName: "Manager", username: "manager", status: "active" }],
  ]);
  const runtimeEvents = [];
  const runtime = {
    async startReceiver(value) { runtimeEvents.push({ type: "start", ...value }); },
    async updateReceiver(value) { runtimeEvents.push({ type: "update", ...value }); },
    async stopReceiver(value) { runtimeEvents.push({ type: "stop", ...value }); },
    async issueViewerConnection(value) {
      runtimeEvents.push({ type: "viewer-connection", ...value });
      return { sessionId: value.sessionId, viewerIdentityId: value.viewerIdentityId,
        grantId: value.grantId, url: "wss://casting.test/livekit", accessToken: MEDIA_ACCESS_TOKEN,
        expiresAt: value.expiresAt };
    },
    async disconnectViewer(value) { runtimeEvents.push({ type: "disconnect", ...value }); },
    async health() { return { healthy: true }; },
  };
  const directory = {
    async authorization(id) { const value = authorization.get(id); return value ? structuredClone(value) : null; },
    async identity(id) { return structuredClone(identities.get(id) ?? null); },
    async identities(ids) { return ids.map((id) => structuredClone(identities.get(id))).filter(Boolean); },
    async team(id) { return id === TEAM ? { teamId: TEAM, teamKey: "team.default", displayName: "Team",
      status: "active", memberIdentityIds: [VIEWER] } : null; },
  };
  const audits = [];
  const service = new CastingSessionService({ repository, ephemeralStore, runtime, directory, admission,
    applianceNodeId: GROUP, audit: async (event) => audits.push(structuredClone(event)),
    clock: () => new Date(now), idFactory: randomUUID, maximumStartsPerWindow, stopRetryMilliseconds,
    setTimeoutFactory, clearTimeoutFactory });
  return { service, repository, ephemeralStore, runtime, directory, admission, runtimeEvents, authorization, audits,
    now: () => new Date(now),
    advance(ms) { now = new Date(now.getTime() + ms); } };
}

test("established authenticated ingress survives entry credential expiry but still enforces live permissions", async () => {
  const f=fixture(), owner={...context(OWNER,["cast:use","cast:view"]),sessionId:randomUUID()};
  const session=await f.service.startSession({context:owner,idempotencyKey:"ingress-lifetime",
    input:{outputSinks:["browser"],browserAudience:"owner_only",ttlSeconds:1800}});
  const browserInstanceId="browser-instance-ingress-lifetime";
  const joined=await f.service.join({context:owner,sessionId:session.id,browserInstanceId});
  const issue=f.runtime.issueViewerConnection;let connection;
  f.runtime.issueViewerConnection=async value=>{connection=await issue(value);return {...connection,
    expiresAt:new Date(f.now().getTime()+30_000).toISOString()};};
  f.runtime.consumeViewerConnection=async()=>({...connection,participantIdentity:"cast-"+"a".repeat(32)});
  const ingress=new AuthenticatedCastingMediaAdmission({service:f.service,runtime:f.runtime,
    authenticateRequest:async()=>owner,publicOrigin:"https://casting.test",clock:()=>f.now().getTime()});
  try {
    const issued=await ingress.issue({context:owner,sessionId:session.id,browserInstanceId,
      mediaCredential:joined.mediaCredential});
    const handle=new URL(issued.url).pathname.split("/").at(-1);
    await ingress.admit({request:{},handle,accessToken:issued.accessToken});
    f.advance(360_000);
    await assert.rejects(f.service.authorizeMediaConnection({sessionId:session.id,viewerIdentityId:OWNER,
      browserInstanceId,mediaCredential:joined.mediaCredential}),{code:"cast_media_authorization_denied"});
    assert.deepEqual(await ingress.reauthorize({request:{},connectionId:handle}),{authorized:true});
    assert.equal((await f.repository.getOpenGrant({sessionId:session.id,viewerIdentityId:OWNER})).state,"joined");
    f.authorization.get(OWNER).permissions=["cast:use"];
    await assert.rejects(ingress.reauthorize({request:{},connectionId:handle}),{code:"cast_media_authorization_denied"});
    assert.equal(ingress.status().connectionCount,0);
    assert.equal(await f.repository.getOpenGrant({sessionId:session.id,viewerIdentityId:OWNER}),null);
  } finally {await ingress.close();f.service.close();}
});

test("admitted entries cannot keep a grant joined after the last actual browser leaves", async () => {
  const f=fixture(),owner=context(OWNER,["cast:use","cast:view"]);
  try {
    const session=await f.service.startSession({context:owner,idempotencyKey:"admitted-entry-cleanup",
      input:{outputSinks:["browser"],browserAudience:"owner_only",ttlSeconds:600}});
    for (const browserInstanceId of ["browser-instance-survivor","browser-instance-closed-without-http"]) {
      const joined=await f.service.join({context:owner,sessionId:session.id,browserInstanceId});
      assert.deepEqual(f.service.confirmMediaConnection({sessionId:session.id,viewerIdentityId:OWNER,
        browserInstanceId,mediaCredential:joined.mediaCredential}),{admitted:true});
    }
    assert.equal(f.ephemeralStore.hasViewerCredentials({sessionId:session.id,viewerIdentityId:OWNER}),false);
    f.runtime.disconnectViewer=async()=>({remainingBrowserConnections:0});
    await f.service.leave({context:owner,sessionId:session.id,browserInstanceId:"browser-instance-survivor"});
    assert.equal(await f.repository.getOpenGrant({sessionId:session.id,viewerIdentityId:OWNER}),null);
  } finally {f.service.close();}
});

test("an old admission confirmation cannot consume a replacement pending entry", async () => {
  const f=fixture(),owner=context(OWNER,["cast:use","cast:view"]);
  try {
    const session=await f.service.startSession({context:owner,idempotencyKey:"replacement-pending-entry",
      input:{outputSinks:["browser"],browserAudience:"owner_only",ttlSeconds:600}});
    const browserInstanceId="browser-instance-replacement";
    const old=await f.service.join({context:owner,sessionId:session.id,browserInstanceId});
    const fresh=await f.service.join({context:owner,sessionId:session.id,browserInstanceId});
    assert.throws(()=>f.service.confirmMediaConnection({sessionId:session.id,viewerIdentityId:OWNER,
      browserInstanceId,mediaCredential:old.mediaCredential}),{code:"cast_media_authorization_denied"});
    assert.equal(f.ephemeralStore.hasViewerCredentials({sessionId:session.id,viewerIdentityId:OWNER}),true);
    f.service.confirmMediaConnection({sessionId:session.id,viewerIdentityId:OWNER,browserInstanceId,mediaCredential:fresh.mediaCredential});
    assert.equal(f.ephemeralStore.hasViewerCredentials({sessionId:session.id,viewerIdentityId:OWNER}),false);
  } finally {f.service.close();}
});

test("connected authorization rejects a replaced grant and still expires with the receiver", async () => {
  const f=fixture(),owner=context(OWNER,["cast:use","cast:view"]);
  try {
    const session=await f.service.startSession({context:owner,idempotencyKey:"connected-grant-binding",
      input:{outputSinks:["browser"],browserAudience:"owner_only",ttlSeconds:600}});
    const first=await f.service.join({context:owner,sessionId:session.id,browserInstanceId:"browser-instance-binding-one"});
    await f.service.leave({context:owner,sessionId:session.id});
    const second=await f.service.join({context:owner,sessionId:session.id,browserInstanceId:"browser-instance-binding-two"});
    await assert.rejects(f.service.reauthorizeConnectedMedia({sessionId:session.id,viewerIdentityId:OWNER,
      grantId:first.grantId}),{code:"cast_media_authorization_denied"});
    assert.equal((await f.repository.getOpenGrant({sessionId:session.id,viewerIdentityId:OWNER})).grantId,second.grantId);
    assert.equal((await f.service.reauthorizeConnectedMedia({sessionId:session.id,viewerIdentityId:OWNER,
      grantId:second.grantId})).grantId,second.grantId);
    f.advance(600_000);
    await assert.rejects(f.service.reauthorizeConnectedMedia({sessionId:session.id,viewerIdentityId:OWNER,
      grantId:second.grantId}));
  } finally {f.service.close();}
});

async function waitForSessionState(repository, sessionId, expected, timeoutMilliseconds = 500) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if ((await repository.getSession(sessionId))?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`casting session did not reach ${expected}`);
}

test("browser-scoped leave preserves other connected or joining pages and last leave ends the grant", async () => {
  for (const remaining of [0, 1]) {
    const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
    try {
      const session = await f.service.startSession({ context: owner, idempotencyKey: "browser-leave-" + remaining,
        input: { browserAudience: "owner_only", ttlSeconds: 600 } });
      const firstBrowser = "browser-instance-leaving-one", secondBrowser = "browser-instance-retained-two";
      const first = await f.service.join({ context: owner, sessionId: session.id, browserInstanceId: firstBrowser });
      const second = await f.service.join({ context: owner, sessionId: session.id, browserInstanceId: secondBrowser });
      const removals = [];
      f.runtime.disconnectViewer = async value => { removals.push(value); return { remainingBrowserConnections: remaining }; };
      await f.service.leave({ context: owner, sessionId: session.id, browserInstanceId: firstBrowser });
      assert.equal(removals[0].browserInstanceId, firstBrowser);
      assert.equal((await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER })).grantId, second.grantId);
      assert.equal(f.ephemeralStore.verifyViewerCredential({ sessionId: session.id, viewerIdentityId: OWNER,
        browserInstanceId: firstBrowser, mediaCredential: first.mediaCredential }), false);
      assert.equal(f.ephemeralStore.verifyViewerCredential({ sessionId: session.id, viewerIdentityId: OWNER,
        browserInstanceId: secondBrowser, mediaCredential: second.mediaCredential }), true);
      // Established connections stay authoritative after entry credentials expire.
      if (remaining) {
        f.advance(301_000);
        await f.service.leave({ context: owner, sessionId: session.id, browserInstanceId: firstBrowser });
        assert.ok(await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER }));
      }
      f.runtime.disconnectViewer = async () => ({ remainingBrowserConnections: 0 });
      await f.service.leave({ context: owner, sessionId: session.id, browserInstanceId: secondBrowser });
      assert.equal(await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER }), null);
    } finally { f.service.close(); }
  }
});

test("scoped leave rejects invalid browser or unconfirmed runtime cleanup without ending another page's grant", async () => {
  const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
  try {
    const session = await f.service.startSession({ context: owner, idempotencyKey: "browser-leave-invalid",
      input: { browserAudience: "owner_only", ttlSeconds: 600 } });
    const browserInstanceId = "browser-instance-retained-two";
    const joined = await f.service.join({ context: owner, sessionId: session.id, browserInstanceId });
    const before = f.runtimeEvents.length;
    await assert.rejects(f.service.leave({ context: owner, sessionId: session.id, browserInstanceId: null }),
      { code: "cast_viewer_context_invalid" });
    assert.equal(f.runtimeEvents.length, before);
    for (const response of [undefined, {}, { remainingBrowserConnections: -1 }, { remainingBrowserConnections: true }]) {
      f.runtime.disconnectViewer = async () => response;
      await assert.rejects(f.service.leave({ context: owner, sessionId: session.id,
        browserInstanceId: "browser-instance-missing-one" }), { code: "cast_media_runtime_unavailable" });
      assert.equal((await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER })).grantId, joined.grantId);
    }
  } finally { f.service.close(); }
});

test('native sender disconnect is independent of durable receiver lifetime and does not revoke viewers', async () => {
  const f=fixture(), owner=context(OWNER,['cast:use','cast:view']);
  const session=await f.service.startSession({context:owner,idempotencyKey:'source-status-1',input:{outputSinks:['browser'],browserAudience:'owner_only',ttlSeconds:600}});
  const source=randomUUID();await f.service.pairSource({sessionId:session.id,pin:session.receiver.pin,sourceConnectionId:source});
  await f.service.markStreaming({sessionId:session.id,sourceConnectionId:source});
  let sourceStateRevision=1;
  for(const sourceState of ['connected','disconnected','connected']) {
    sourceStateRevision+=1;
    f.runtime.health=async()=>({healthy:true,outputs:{browser:{healthy:true}},progress:{sourceState,sourceStateRevision,private:'never-exposed'}});
    const current=await f.service.getSession({context:owner,sessionId:session.id});
    assert.equal(current.sourceState,sourceState);assert.equal(current.state,'streaming');
    assert.equal(current.sourceStateRevision,sourceStateRevision);
    assert.equal(current.receiver.name,session.receiver.name);assert.equal(JSON.stringify(current).includes('never-exposed'),false);
  }
  f.runtime.health=async()=>{throw Error('network');};
  assert.equal((await f.service.getSession({context:owner,sessionId:session.id})).sourceState,'unknown');
  assert.equal((await f.service.getSession({context:owner,sessionId:session.id})).sourceStateRevision,1);
  await f.service.stopSession({context:owner,sessionId:session.id});
});

test("casting keeps receiver PIN and viewer media credentials process-local while enforcing an explicit join", async () => {
  const { service, repository, audits, admission, runtimeEvents } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:share", "cast:view", "cast:manage"]);
  const viewer = context(VIEWER, ["cast:view"], [{ teamId: TEAM, teamKey: "team.default" }]);
  const started = await service.startSession({ context: owner, idempotencyKey: "cast-start-1", input: {
    outputSinks: ["browser"], browserAudience: "selected_users", viewerUserIds: [VIEWER], ttlSeconds: 600,
  } });
  assert.equal(started.state, "pairing");
  assert.match(started.receiver.name, /^Team-AI-[0-9A-F]{10}$/);
  assert.equal(started.receiver.pin, "1234");
  assert.deepEqual(admission.calls, [{
    outputSinks: ["browser"],
    mediaPrivacyPolicy: castingMediaPrivacyPolicyV1,
  }]);
  assert.equal(Object.isFrozen(admission.calls[0].outputSinks), true);
  const runtimeStart = runtimeEvents.find((event) => event.type === "start");
  assert.equal(runtimeStart.pairingPin, started.receiver.pin);
  assert.deepEqual(runtimeStart.mediaPrivacyPolicy, castingMediaPrivacyPolicyV1);
  assert.equal(Object.isFrozen(runtimeStart.mediaPrivacyPolicy), true);
  const invitation = (await service.listInvitations({ context: viewer }))[0];
  await service.acceptInvitation({ context: viewer, invitationId: invitation.id });
  const joined = await service.join({ context: viewer, sessionId: started.id, invitationId: invitation.id,
    browserInstanceId: "browser-instance-0001" });
  assert.equal(joined.muted, false);
  assert.match(joined.mediaCredential, /^[A-Za-z0-9_-]{40,}$/);
  const media = await service.createMediaConnection({ context: viewer, sessionId: started.id,
    browserInstanceId: "browser-instance-0001", mediaCredential: joined.mediaCredential });
  assert.deepEqual(media, { sessionId: started.id, viewerIdentityId: VIEWER, grantId: joined.grantId,
    url: "wss://casting.test/livekit", accessToken: MEDIA_ACCESS_TOKEN,
    expiresAt: joined.expiresAt, muted: false });
  assert.deepEqual(runtimeEvents.find((event) => event.type === "viewer-connection"), {
    type: "viewer-connection", sessionId: started.id, viewerIdentityId: VIEWER,
    grantId: joined.grantId, audienceRevision: started.audienceRevision,
    browserInstanceId: "browser-instance-0001", expiresAt: joined.expiresAt, muted: false,
    maximumViewers: null, publisherEncodeRenditions: 1,
  });
  assert.deepEqual((await service.listViewers({ context: owner, sessionId: started.id }))
    .map((item) => item.displayName), ["Viewer"]);

  const durable = JSON.stringify({ session: await repository.getSession(started.id),
    targets: await repository.getAudienceTargets(started.id), events: await repository.listEvents(started.id) });
  assert.doesNotMatch(durable, /1234|mediaCredential|receiverName|sourceDevice|browser-instance/i);
  assert.doesNotMatch(JSON.stringify(audits), /1234|mediaCredential|receiverName|sourceDevice|browser-instance/i);
  assert.equal(JSON.stringify(audits).includes(MEDIA_ACCESS_TOKEN), false);
});

test("established viewing survives five-minute join credential expiry without reconnecting", async () => {
  const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
  const session = await f.service.startSession({ context: owner, idempotencyKey: "long-view",
    input: { browserAudience: "owner_only", ttlSeconds: 1800 } });
  const joined = await f.service.join({ context: owner, sessionId: session.id, browserInstanceId: "browser-long-view" });
  assert.equal(new Date(joined.expiresAt) - f.now(), 5 * 60_000);
  const grant = await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER });
  assert.equal(grant.expiresAt.toISOString(), session.expiresAt);
  await f.service.createMediaConnection({ context: owner, sessionId: session.id,
    browserInstanceId: "browser-long-view", mediaCredential: joined.mediaCredential });
  f.advance(6 * 60_000);
  await f.service.expireDue();
  assert.equal((await f.service.listViewers({ context: owner, sessionId: session.id })).length, 1);
  assert.equal((await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER })).state, "joined");
  assert.equal(f.runtimeEvents.filter(event => event.type === "disconnect").length, 0);
  await assert.rejects(f.service.createMediaConnection({ context: owner, sessionId: session.id,
    browserInstanceId: "browser-long-view", mediaCredential: joined.mediaCredential }), { code: "cast_media_authorization_denied" });
  assert.equal((await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER })).state, "joined");
  const fresh = await f.service.join({ context: owner, sessionId: session.id, browserInstanceId: "browser-long-view" });
  assert.equal(fresh.grantId, joined.grantId);
  assert.notEqual(fresh.mediaCredential, joined.mediaCredential);
  assert.equal(new Date(fresh.expiresAt) - f.now(), 5 * 60_000);
  await f.service.createMediaConnection({ context: owner, sessionId: session.id,
    browserInstanceId: "browser-long-view", mediaCredential: fresh.mediaCredential });
  await f.service.stopSession({ context: owner, sessionId: session.id });
});

test("long-lived viewing still ends on permission revocation or explicit leave", async () => {
  for (const reason of ["permission", "leave"]) {
    const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
    const session = await f.service.startSession({ context: owner, idempotencyKey: "long-revoke-" + reason,
      input: { browserAudience: "owner_only", ttlSeconds: 1800 } });
    await f.service.join({ context: owner, sessionId: session.id, browserInstanceId: "browser-long-revoke" });
    f.advance(6 * 60_000);
    if (reason === "permission") {
      f.authorization.get(OWNER).permissions = ["cast:use"];
      assert.deepEqual(await f.service.reconcileViewerAuthorization(session.id, OWNER), { disconnected: true });
    } else await f.service.leave({ context: owner, sessionId: session.id });
    assert.equal(await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER }), null);
    assert.equal(f.runtimeEvents.filter(event => event.type === "disconnect").length, 1);
    await f.service.stopSession({ context: owner, sessionId: session.id });
  }
});

test("viewing grant and newly issued credentials never outlive receiver expiry", async () => {
  const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
  const session = await f.service.startSession({ context: owner, idempotencyKey: "long-expiry",
    input: { browserAudience: "owner_only", ttlSeconds: 600 } });
  f.advance(9 * 60_000);
  const joined = await f.service.join({ context: owner, sessionId: session.id, browserInstanceId: "browser-near-end" });
  assert.equal(joined.expiresAt, session.expiresAt);
  f.advance(61_000);
  await f.service.expireDue();
  assert.equal((await f.repository.getSession(session.id)).state, "expired");
  assert.equal(await f.repository.getOpenGrant({ sessionId: session.id, viewerIdentityId: OWNER }), null);
});

test("casting revokes the viewer grant when the media service returns an unsafe connection URL", async () => {
  const current = fixture();
  const owner = context(OWNER, ["cast:use", "cast:share", "cast:view", "cast:manage"]);
  const viewer = context(VIEWER, ["cast:view"], [{ teamId: TEAM, teamKey: "team.default" }]);
  const started = await current.service.startSession({ context: owner, idempotencyKey: "unsafe-media-url-1", input: {
    outputSinks: ["browser"], browserAudience: "selected_users", viewerUserIds: [VIEWER], ttlSeconds: 600,
  } });
  const invitation = (await current.service.listInvitations({ context: viewer }))[0];
  await current.service.acceptInvitation({ context: viewer, invitationId: invitation.id });
  const joined = await current.service.join({ context: viewer, sessionId: started.id,
    invitationId: invitation.id, browserInstanceId: "browser-instance-unsafe-url" });
  current.runtime.issueViewerConnection = async (value) => ({
    sessionId: value.sessionId,
    viewerIdentityId: value.viewerIdentityId,
    grantId: value.grantId,
    url: "ws://casting.test/livekit?credential=unsafe",
    accessToken: MEDIA_ACCESS_TOKEN,
    expiresAt: value.expiresAt,
  });

  await assert.rejects(current.service.createMediaConnection({ context: viewer, sessionId: started.id,
    browserInstanceId: "browser-instance-unsafe-url", mediaCredential: joined.mediaCredential }),
  (error) => error.code === "cast_media_connection_invalid");
  assert.equal(await current.repository.getOpenGrant({ sessionId: started.id, viewerIdentityId: VIEWER }), null);
  assert.equal(current.ephemeralStore.verifyViewerCredential({ sessionId: started.id,
    viewerIdentityId: VIEWER, browserInstanceId: "browser-instance-unsafe-url",
    mediaCredential: joined.mediaCredential }), false);
});

test("casting validates sink/audience invariants, one active session, rate limits starts, and stops idempotently", async () => {
  const { service, repository } = fixture({ maximumStartsPerWindow: 1 });
  const owner = context(OWNER, ["cast:use", "cast:share", "cast:view", "cast:manage"]);
  await assert.rejects(service.startSession({ context: owner, idempotencyKey: "invalid-1", input: {
    outputSinks: ["browser"], browserAudience: "invalid",
  } }), (error) => error.code === "cast_audience_invalid");
  const started = await service.startSession({ context: owner, idempotencyKey: "valid-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } });
  const replay = await service.startSession({ context: owner, idempotencyKey: "valid-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } });
  assert.equal(replay.id, started.id);
  await assert.rejects(service.startSession({ context: owner, idempotencyKey: "valid-2",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } }), (error) => error.code === "cast_start_rate_limited");
  const stopped = await service.stopSession({ context: owner, sessionId: started.id });
  const repeated = await service.stopSession({ context: owner, sessionId: started.id });
  assert.equal(stopped.state, "stopped");
  assert.equal(repeated.state, "stopped");
  assert.equal((await repository.getSession(started.id)).terminalReasonCode, "cast_stopped_by_initiator");
});

test("casting denies advertisement by default and when a requested output is not explicitly admitted", async () => {
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const disabled = fixture({ admission: null });
  await assert.rejects(disabled.service.startSession({ context: owner, idempotencyKey: "default-deny-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } }),
  (error) => error.code === "cast_capability_unavailable"
    && error.details?.gateCodes?.includes("casting_runtime_admission_not_configured"));
  assert.equal(await disabled.repository.findActiveSession(GROUP), null);
  assert.deepEqual(disabled.runtimeEvents, []);

  const admission = readyAdmission({ outputs: {
    browser: { state: "unavailable" },
  } });
  const unavailable = fixture({ admission });
  await assert.rejects(unavailable.service.startSession({ context: owner, idempotencyKey: "output-deny-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } }),
  (error) => error.code === "cast_capability_unavailable");
  assert.equal(admission.calls.length, 1);
  assert.equal(await unavailable.repository.findActiveSession(GROUP), null);
  assert.deepEqual(unavailable.runtimeEvents, []);
});

test("casting rejects output and audience permission failures before admission or receiver startup", async () => {
  const first = fixture();
  await assert.rejects(first.service.startSession({
    context: context(OWNER, ["cast:use"]),
    idempotencyKey: "missing-view-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 },
  }), (error) => error.code === "cast_permission_required");
  assert.equal(first.admission.calls.length, 0);
  assert.deepEqual(first.runtimeEvents, []);

  const second = fixture();
  await assert.rejects(second.service.startSession({
    context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "missing-share-1",
    input: { outputSinks: ["browser"], browserAudience: "selected_users",
      viewerUserIds: [VIEWER], ttlSeconds: 600 },
  }), (error) => error.code === "cast_permission_required");
  assert.equal(second.admission.calls.length, 0);
  assert.deepEqual(second.runtimeEvents, []);
});

test("casting preserves the immutable no-recording policy across audience changes", async () => {
  const { service, runtimeEvents, admission } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view", "cast:share"]);
  const started = await service.startSession({ context: owner, idempotencyKey: "privacy-update-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  await service.updateAudience({ context: owner, sessionId: started.id, input: {
    outputSinks: ["browser"], browserAudience: "selected_users", viewerUserIds: [VIEWER],
  } });
  assert.deepEqual(admission.calls.map((call) => call.outputSinks), [["browser"], ["browser"]]);
  const runtimeUpdate = runtimeEvents.find((event) => event.type === "update");
  assert.deepEqual(runtimeUpdate.mediaPrivacyPolicy, castingMediaPrivacyPolicyV1);
  assert.equal(Object.isFrozen(runtimeUpdate.mediaPrivacyPolicy), true);
});

test("a partial receiver startup failure triggers exact best-effort withdrawal and clears ephemeral secrets", async () => {
  const current = fixture();
  current.runtime.startReceiver = async (value) => {
    current.runtimeEvents.push({ type: "start", ...value });
    throw new Error("runtime start failed after partial setup");
  };
  await assert.rejects(current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "partial-start-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } }),
  /runtime start failed after partial setup/);
  const start = current.runtimeEvents.find((event) => event.type === "start");
  assert.ok(start);
  assert.ok(current.runtimeEvents.some((event) => event.type === "stop"
    && event.sessionId === start.sessionId && event.reasonCode === "cast_receiver_start_failed"));
  assert.equal(current.ephemeralStore.describe(start.sessionId), null);
  assert.equal((await current.repository.getSession(start.sessionId)).state, "failed");
  assert.equal(await current.repository.findActiveSession(GROUP), null);
});

test("a partially advertised receiver keeps the single-session lock until failed startup withdrawal is confirmed", async () => {
  const scheduled = [];
  const current = fixture({ stopRetryMilliseconds: 10,
    setTimeoutFactory(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFactory(timer) { timer.cleared = true; },
  });
  current.runtime.startReceiver = async (value) => {
    current.runtimeEvents.push({ type: "start", ...value });
    throw new Error("runtime start failed after advertising");
  };
  let stopAttempts = 0;
  current.runtime.stopReceiver = async (value) => {
    current.runtimeEvents.push({ type: "stop", ...value });
    stopAttempts += 1;
    if (stopAttempts === 1) throw new Error("receiver withdrawal temporarily failed");
  };
  await assert.rejects(current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "partial-start-retry-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } }),
  (error) => error.code === "cast_receiver_stop_pending" && error.retryable === true);
  const sessionId = current.runtimeEvents.find((event) => event.type === "start").sessionId;
  assert.equal((await current.repository.getSession(sessionId)).state, "requested");
  assert.equal((await current.repository.findActiveSession(GROUP)).sessionId, sessionId);
  assert.equal(current.ephemeralStore.describe(sessionId), null);
  assert.equal(scheduled.length, 1);
  await assert.rejects(current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "partial-start-blocked-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } }),
  (error) => error.code === "cast_session_busy");
  scheduled[0].callback();
  await waitForSessionState(current.repository, sessionId, "failed");
  assert.equal(stopAttempts, 2);
  assert.equal(await current.repository.findActiveSession(GROUP), null);
  current.service.close();
});

test("cast:share revocation atomically downgrades to owner-only and removes other viewers", async () => {
  const { service, repository, authorization, runtimeEvents } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:share", "cast:view", "cast:manage"]);
  const viewer = context(VIEWER, ["cast:view"], [{ teamId: TEAM, teamKey: "team.default" }]);
  const started = await service.startSession({ context: owner, idempotencyKey: "share-revoke-1", input: {
    outputSinks: ["browser"], browserAudience: "selected_users", viewerUserIds: [VIEWER], ttlSeconds: 600,
  } });
  const invitation = (await service.listInvitations({ context: viewer }))[0];
  await service.acceptInvitation({ context: viewer, invitationId: invitation.id });
  await service.join({ context: viewer, sessionId: started.id, invitationId: invitation.id,
    browserInstanceId: "browser-instance-0002" });
  authorization.get(OWNER).permissions = ["cast:use", "cast:view", "cast:manage"];
  const reconciled = await service.reconcileAuthorization(started.id);
  assert.equal(reconciled.browserAudience, "owner_only");
  assert.equal((await repository.listJoinedViewers(started.id, new Date("2026-09-04T08:00:01Z"))).length, 0);
  assert.ok(runtimeEvents.some((event) => event.type === "disconnect" && event.viewerIdentityId === VIEWER
    && event.reasonCode === "cast_share_revoked"));
  await assert.rejects(service.join({ context: viewer, sessionId: started.id, invitationId: invitation.id,
    browserInstanceId: "browser-instance-0003" }), (error) => error.code === "cast_audience_denied");
});

test("cast:manage can inspect health and force-stop without receiving receiver or media details", async () => {
  const { service } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const manager = context(MANAGER, ["cast:manage"]);
  const started = await service.startSession({ context: owner, idempotencyKey: "manage-stop-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  const health = await service.health({ context: manager, sessionId: started.id });
  assert.equal(health.object, "cast.session.health");
  assert.equal(health.receiverHealthy, true);
  assert.equal("receiver" in health, false);
  assert.equal("mediaCredential" in health, false);
  const stopped = await service.forceStop({ context: manager, sessionId: started.id });
  assert.equal(stopped.state, "stopped");
  assert.equal("receiver" in stopped, false);
});

test("unavailable media health does not hide the owner's session or manager stop control", async () => {
  const { service, runtime } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const manager = context(MANAGER, ["cast:manage"]);
  runtime.health = async () => { throw new Error("private media diagnostic"); };
  const started = await service.startSession({ context: owner, idempotencyKey: "health-outage-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  const view = await service.getSession({ context: owner, sessionId: started.id });
  assert.equal(view.id, started.id);
  assert.deepEqual(view.outputHealth, { receiverHealthy: false, outputs: { browser: "unknown" } });
  const health = await service.health({ context: manager, sessionId: started.id });
  assert.deepEqual(health.outputHealth, view.outputHealth);
  assert.equal("receiver" in health, false);
  assert.equal(JSON.stringify(health).includes("private media diagnostic"), false);
  await assert.rejects(service.getSession({ context: context(VIEWER, ["cast:view"]), sessionId: started.id }),
    (error) => error.code === "cast_session_not_found");
  const stopped = await service.forceStop({ context: manager, sessionId: started.id });
  assert.equal(stopped.state, "stopped");
});

test("explicit receiver exit ends the stale session, removes PIN and allows a fresh receiver", async () => {
  const { service, runtime, repository, runtimeEvents } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const input = { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 };
  const started = await service.startSession({ context: owner, idempotencyKey: "receiver-exit-1", input });
  runtime.health = async () => ({ healthy: false, receiverState: "failed", failureCode: "video_rate",
    outputs: { browser: { healthy: false }, hdmi: { healthy: false } } });
  const view = await service.getSession({ context: owner, sessionId: started.id });
  assert.equal(view.state, "failed");
  assert.equal(view.terminalReasonCode, "cast_receiver_terminated");
  assert.equal("receiver" in view, false);
  assert.equal((await repository.getSession(started.id)).state, "failed");
  assert.ok(runtimeEvents.some(e => e.type === "stop" && e.sessionId === started.id));
  runtime.health = async () => ({ healthy: false, outputs: { browser: { healthy: false } } });
  const next = await service.startSession({ context: owner, idempotencyKey: "receiver-exit-2", input });
  assert.equal(next.state, "pairing");
  assert.notEqual(next.id, started.id);
});

test("waiting for the first frame does not terminate a receiver", async () => {
  const { service, runtime, runtimeEvents } = fixture();
  runtime.health = async () => ({ healthy: false, outputs: { browser: { healthy: false } } });
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const started = await service.startSession({ context: owner, idempotencyKey: "waiting-frame",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  assert.equal((await service.getSession({ context: owner, sessionId: started.id })).state, "pairing");
  assert.equal(runtimeEvents.filter(e => e.type === "stop").length, 0);
});

test("pairing PIN failures are bounded in memory and source device facts never enter repository events", async () => {
  const { service, repository } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const started = await service.startSession({ context: owner, idempotencyKey: "pair-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await service.pairSource({ sessionId: started.id, pin: "0000", sourceConnectionId: "source-connection-0001",
      sourceDeviceLabel: "Alice iPhone" });
  }
  const record = await repository.getSession(started.id);
  assert.equal(record.pairingFailedAttempts, 5);
  assert.ok(record.pairingBlockedUntil);
  const events = JSON.stringify(await repository.listEvents(started.id));
  assert.equal(events.includes('"0000"'), false);
  assert.equal(events.includes("Alice iPhone"), false);
  assert.equal(events.includes("source-connection"), false);
});

test("streaming cannot start until the active source completes PIN pairing", async () => {
  const { service } = fixture();
  const started = await service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "pair-before-stream-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  await assert.rejects(service.markStreaming({ sessionId: started.id,
    sourceConnectionId: "source-connection-0002" }),
  (error) => error.code === "cast_source_not_paired");
  await service.pairSource({ sessionId: started.id, pin: "1234",
    sourceConnectionId: "source-connection-0002", sourceDeviceLabel: "Test iPhone" });
  await assert.rejects(service.markStreaming({ sessionId: started.id,
    sourceConnectionId: "different-source-0002" }),
  (error) => error.code === "cast_source_not_paired");
  assert.equal((await service.markStreaming({ sessionId: started.id,
    sourceConnectionId: "source-connection-0002" })).state, "streaming");
});

test("trusted media callback contract remains activation-blocked until an exact certificate is bound", async () => {
  const template = await callbackContract({ runtimeBound: false });
  assert.equal(validateTrustedMediaCallbackContract(template).runtimeBound, false);
  assert.throws(() => validateTrustedMediaCallbackContract(template, { requireRuntimeBinding: true }),
    /runtime certificate is not bound/);
  const materialized = await callbackContract();
  const result = validateTrustedMediaCallbackContract(materialized, { requireRuntimeBinding: true });
  assert.equal(result.runtimeBound, true);
  const expanded = structuredClone(materialized);
  expanded.exposure.sharedBrowserListenerAllowed = true;
  assert.throws(() => validateTrustedMediaCallbackContract(expanded), /private listener boundary/);
  const overclaimed = structuredClone(materialized);
  overclaimed.claimBoundary.task22_7Complete = true;
  assert.throws(() => validateTrustedMediaCallbackContract(overclaimed), /claim boundary/);
});

test("trusted media callback transport identity comes only from one authorized TLS peer SAN", () => {
  const fingerprint = "AB:".repeat(31) + "AB";
  const identity = trustedMediaTransportIdentity({
    headers: { "x-client-cert-verified": "true" },
    socket: { encrypted: true, authorized: true, getPeerCertificate() {
      return { subjectaltname: `URI:spiffe://teamaibox.local/service/trusted-media/${TRUSTED_MEDIA_IDENTITY}`,
        fingerprint256: fingerprint };
    } },
  });
  assert.deepEqual(identity, callbackIdentity());
  assert.throws(() => trustedMediaTransportIdentity({
    headers: { "x-client-cert-verified": "true" }, socket: { encrypted: false, authorized: false },
  }), (error) => error.code === "cast_callback_mtls_required");
  assert.throws(() => trustedMediaTransportIdentity({ socket: { encrypted: true, authorized: true,
    getPeerCertificate() { return { subjectaltname:
      `URI:spiffe://teamaibox.local/service/trusted-media/${TRUSTED_MEDIA_IDENTITY}, URI:spiffe://teamaibox.local/service/trusted-media/${TRUSTED_MEDIA_IDENTITY}`,
    fingerprint256: fingerprint }; } } }), (error) => error.code === "cast_callback_certificate_rejected");
});

test("authenticated callbacks pair one source, reject replay, bind streaming, and recheck viewer authorization", async () => {
  const current = fixture();
  const owner = context(OWNER, ["cast:use", "cast:share", "cast:view", "cast:manage"]);
  const viewer = context(VIEWER, ["cast:view"], [{ teamId: TEAM, teamKey: "team.default" }]);
  const started = await current.service.startSession({ context: owner, idempotencyKey: "callback-slice-1", input: {
    outputSinks: ["browser"], browserAudience: "selected_users", viewerUserIds: [VIEWER], ttlSeconds: 600,
  } });
  const invitation = (await current.service.listInvitations({ context: viewer }))[0];
  await current.service.acceptInvitation({ context: viewer, invitationId: invitation.id });
  const joined = await current.service.join({ context: viewer, sessionId: started.id, invitationId: invitation.id,
    browserInstanceId: "browser-instance-callback" });
  const api = new TrustedMediaCallbackHttpApi({ service: current.service,
    contract: await callbackContract(), clock: current.now });
  const transportIdentity = callbackIdentity();

  const pairPath = `/internal/v1/casting/sessions/${started.id}/source/pair`;
  const replayHeaders = callbackHeaders();
  assert.equal(matchesTrustedMediaCallbackRoute("POST", pairPath), true);
  const paired = await api.handle({ method: "POST", pathname: pairPath, transportIdentity,
    headers: replayHeaders, body: { pin: "1234", source_connection_id: "source-connection-callback",
      source_device_label: "Test sender" } });
  assert.deepEqual(paired.body, { paired: true, repeated: false, blocked: false,
    state: "paired", failed_attempts: 0, blocked_until: null });
  await assert.rejects(api.handle({ method: "POST", pathname: pairPath, transportIdentity,
    headers: replayHeaders, body: { pin: "1234", source_connection_id: "source-connection-callback" } }),
  (error) => error.code === "cast_callback_replayed");
  const repeated = await api.handle({ method: "POST", pathname: pairPath, transportIdentity,
    headers: callbackHeaders(), body: { pin: "1234", source_connection_id: "source-connection-callback" } });
  assert.equal(repeated.body.repeated, true);

  const streamPath = `/internal/v1/casting/sessions/${started.id}/source/streaming`;
  await assert.rejects(api.handle({ method: "POST", pathname: streamPath, transportIdentity,
    headers: callbackHeaders(), body: { source_connection_id: "different-source-callback" } }),
  (error) => error.code === "cast_source_not_paired");
  const streaming = await api.handle({ method: "POST", pathname: streamPath, transportIdentity,
    headers: callbackHeaders(), body: { source_connection_id: "source-connection-callback" } });
  assert.equal(streaming.body.state, "streaming");

  const authorizePath = `/internal/v1/casting/sessions/${started.id}/viewers/authorize`;
  const authorizeBody = { viewer_identity_id: VIEWER, browser_instance_id: "browser-instance-callback",
    media_credential: joined.mediaCredential };
  await assert.rejects(api.handle({ method: "POST", pathname: authorizePath,
    transportIdentity: callbackIdentity({ certificateFingerprint: `sha256:${"cd".repeat(32)}` }),
    headers: callbackHeaders(), body: authorizeBody }),
  (error) => error.code === "cast_callback_mtls_required");
  const allowed = await api.handle({ method: "POST", pathname: authorizePath, transportIdentity,
    headers: callbackHeaders(), body: authorizeBody });
  assert.equal(allowed.body.authorized, true);
  assert.equal(allowed.body.muted, false);
  assert.equal(allowed.body.maximum_viewers, null);
  assert.equal(allowed.body.publisher_encode_renditions, 1);

  await assert.rejects(api.handle({ method: "POST", pathname: authorizePath, transportIdentity,
    headers: callbackHeaders(), body: { ...authorizeBody, browser_instance_id: "copied-browser-context" } }),
  (error) => error.code === "cast_media_authorization_denied");
  assert.equal(current.ephemeralStore.verifyViewerCredential({ sessionId: started.id,
    viewerIdentityId: VIEWER, browserInstanceId: "browser-instance-callback",
    mediaCredential: joined.mediaCredential }), true);

  current.authorization.get(VIEWER).permissions = [];
  await assert.rejects(api.handle({ method: "POST", pathname: authorizePath, transportIdentity,
    headers: callbackHeaders(), body: authorizeBody }),
  (error) => error.code === "cast_media_authorization_denied");
  assert.equal(current.ephemeralStore.verifyViewerCredential({ sessionId: started.id,
    viewerIdentityId: VIEWER, browserInstanceId: "browser-instance-callback",
    mediaCredential: joined.mediaCredential }), false);
  assert.equal(await current.repository.getOpenGrant({ sessionId: started.id, viewerIdentityId: VIEWER }), null);
  assert.ok(current.runtimeEvents.some((event) => event.type === "disconnect"
    && event.viewerIdentityId === VIEWER && event.reasonCode === "cast_view_authorization_revoked"));
  assert.doesNotMatch(JSON.stringify(current.audits), /1234|media_credential|browser-instance-callback/i);
  api.close(); current.service.close();
});

test("trusted media callback timestamps and bodies fail closed without consuming caller-provided secrets", async () => {
  const calls = [];
  const service = {
    async pairSource(value) { calls.push(value); return { paired: true, repeated: false, state: "paired" }; },
    async markStreaming(value) { calls.push(value); return { sessionId: value.sessionId, state: "streaming", stateRevision: 4 }; },
    async authorizeMediaConnection(value) { calls.push(value); return { authorized: true,
      sessionId: value.sessionId, viewerIdentityId: VIEWER, grantId: randomUUID(), audienceRevision: 1,
      expiresAt: "2026-09-04T08:01:00.000Z", muted: false, maximumViewers: 8, publisherEncodeRenditions: 1 }; },
  };
  const api = new TrustedMediaCallbackHttpApi({ service, contract: await callbackContract(),
    clock: () => new Date("2026-09-04T08:00:00.000Z") });
  const path = "/internal/v1/casting/sessions/50000000-0000-4000-8000-000000000001/source/pair";
  await assert.rejects(api.handle({ method: "POST", pathname: path, transportIdentity: callbackIdentity(),
    headers: callbackHeaders("2026-09-04T07:59:00.000Z"),
    body: { pin: "1234", source_connection_id: "source-connection-stale" } }),
  (error) => error.code === "cast_callback_stale");
  await assert.rejects(api.handle({ method: "POST", pathname: path, transportIdentity: callbackIdentity(),
    headers: callbackHeaders(), body: { pin: "1234", source_connection_id: "source-connection-extra",
      unexpected: true } }), (error) => error.code === "cast_callback_invalid");
  assert.deepEqual(calls, []);
  api.close();
});

test("viewer authority revocation destroys the credential and closes the grant even when runtime disconnect needs recovery", async () => {
  const current = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const started = await current.service.startSession({ context: owner, idempotencyKey: "callback-revoke-failure-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  const joined = await current.service.join({ context: owner, sessionId: started.id,
    browserInstanceId: "browser-instance-revoke-failure" });
  current.authorization.get(OWNER).permissions = ["cast:use"];
  current.runtime.disconnectViewer = async () => { throw new Error("synthetic SFU disconnect failure"); };
  await assert.rejects(current.service.authorizeMediaConnection({ sessionId: started.id, viewerIdentityId: OWNER,
    browserInstanceId: "browser-instance-revoke-failure", mediaCredential: joined.mediaCredential }),
  (error) => error.code === "cast_media_revocation_incomplete" && error.retryable === true);
  assert.equal(current.ephemeralStore.verifyViewerCredential({ sessionId: started.id, viewerIdentityId: OWNER,
    browserInstanceId: "browser-instance-revoke-failure", mediaCredential: joined.mediaCredential }), false);
  assert.equal(await current.repository.getOpenGrant({ sessionId: started.id, viewerIdentityId: OWNER }), null);
  assert.ok(current.audits.some((event) => event.action === "security.cast_media_revocation_incomplete"));
  current.service.close();
});

test("session TTL stops the runtime and destroys all process-local pairing and viewer state", async () => {
  const { service, repository, ephemeralStore, runtimeEvents, advance } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const started = await service.startSession({ context: owner, idempotencyKey: "expiry-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } });
  await service.join({ context: owner, sessionId: started.id, browserInstanceId: "browser-instance-expiry" });
  advance(60_001);
  assert.deepEqual(await service.expireDue(), { expiredCount: 1 });
  assert.equal((await repository.getSession(started.id)).state, "expired");
  assert.equal(ephemeralStore.describe(started.id), null);
  assert.ok(runtimeEvents.some((event) => event.type === "stop" && event.sessionId === started.id
    && event.reasonCode === "cast_session_expired"));
});

test("owner, manager, and sign-out stop failures keep the single-session lock until a bounded retry confirms withdrawal", async () => {
  for (const mode of ["owner", "manager", "sign-out"]) {
    const current = fixture({ stopRetryMilliseconds: 10 });
    const started = await current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
      idempotencyKey: `retry-${mode}-1`, input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
    let attempts = 0;
    current.runtime.stopReceiver = async (value) => {
      current.runtimeEvents.push({ type: "stop", ...value });
      attempts += 1;
      if (attempts === 1) throw new Error("receiver withdrawal failed");
    };
    const action = mode === "owner"
      ? current.service.stopSession({ context: context(OWNER, ["cast:use", "cast:view"]), sessionId: started.id })
      : mode === "manager"
        ? current.service.forceStop({ context: context(MANAGER, ["cast:manage"]), sessionId: started.id })
        : current.service.handleInitiatorSignOut(OWNER);
    await assert.rejects(action, (error) => error.code === "cast_receiver_stop_pending" && error.retryable === true);
    assert.equal((await current.repository.getSession(started.id)).state, "stopping");
    assert.equal((await current.repository.findActiveSession(GROUP)).sessionId, started.id);
    assert.equal(current.ephemeralStore.describe(started.id), null);
    await assert.rejects(current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
      idempotencyKey: `blocked-${mode}-1`, input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } }),
    (error) => error.code === "cast_session_busy");
    await waitForSessionState(current.repository, started.id, "stopped");
    assert.equal(await current.repository.findActiveSession(GROUP), null);
    assert.equal(attempts, 2);
    current.service.close();
  }
});

test("TTL cleanup never releases the session lock until receiver withdrawal succeeds", async () => {
  const current = fixture({ stopRetryMilliseconds: 10 });
  const started = await current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "expiry-retry-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } });
  let attempts = 0;
  current.runtime.stopReceiver = async (value) => {
    current.runtimeEvents.push({ type: "stop", ...value });
    attempts += 1;
    if (attempts === 1) throw new Error("receiver still advertised");
  };
  current.advance(60_001);
  assert.deepEqual(await current.service.expireDue(), { expiredCount: 0 });
  assert.equal((await current.repository.getSession(started.id)).state, "pairing");
  assert.equal((await current.repository.findActiveSession(GROUP)).sessionId, started.id);
  assert.equal(current.ephemeralStore.describe(started.id), null);
  await waitForSessionState(current.repository, started.id, "expired");
  assert.equal(await current.repository.findActiveSession(GROUP), null);
  assert.equal(attempts, 2);
  current.service.close();
});

test("the one-shot TTL callback retries when the durable expiry query is temporarily unavailable", async () => {
  const scheduled = [];
  const current = fixture({ stopRetryMilliseconds: 10,
    setTimeoutFactory(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFactory(timer) { timer.cleared = true; },
  });
  const started = await current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "expiry-repository-retry-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } });
  const originalExpireDue = current.repository.expireDue.bind(current.repository);
  let expireCalls = 0;
  current.repository.expireDue = async (now) => {
    expireCalls += 1;
    if (expireCalls === 1) throw new Error("temporary expiry transaction failure");
    return originalExpireDue(now);
  };
  current.advance(60_001);
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  while (scheduled.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(expireCalls, 1);
  assert.equal((await current.repository.getSession(started.id)).state, "pairing");
  assert.equal(scheduled[1].delay, 10);
  scheduled[1].callback();
  await waitForSessionState(current.repository, started.id, "expired");
  assert.equal(expireCalls, 2);
  assert.ok(current.runtimeEvents.some((event) => event.type === "stop"
    && event.sessionId === started.id && event.reasonCode === "cast_session_expired"));
  assert.equal(await current.repository.findActiveSession(GROUP), null);
  current.service.close();
});

test("an early TTL callback after a wall-clock rollback is rescheduled for the remaining lifetime", async () => {
  const scheduled = [];
  const current = fixture({ stopRetryMilliseconds: 10,
    setTimeoutFactory(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFactory(timer) { timer.cleared = true; },
  });
  const started = await current.service.startSession({ context: context(OWNER, ["cast:use", "cast:view"]),
    idempotencyKey: "expiry-clock-rollback-1", input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 60 } });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60_000);
  scheduled[0].callback();
  while (scheduled.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await current.repository.getSession(started.id)).state, "pairing");
  assert.equal(scheduled[1].delay, 60_000);
  current.advance(60_001);
  scheduled[1].callback();
  await waitForSessionState(current.repository, started.id, "expired");
  assert.equal(await current.repository.findActiveSession(GROUP), null);
  current.service.close();
});

test("ephemeral viewer credentials are bound to one identity and browser context and are revoked on destroy", () => {
  let now = new Date("2026-09-04T08:00:00Z");
  const store = new MemoryCastingEphemeralStore({ clock: () => new Date(now), randomIntFactory: () => 6543 });
  const sessionId = "50000000-0000-4000-8000-000000000099";
  store.createSession({ sessionId, expiresAt: new Date(now.getTime() + 60_000) });
  const credential = store.issueViewerCredential({ sessionId, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-bound", expiresAt: new Date(now.getTime() + 30_000) });
  assert.equal(store.verifyViewerCredential({ sessionId, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-bound", mediaCredential: credential.mediaCredential }), true);
  assert.equal(store.verifyViewerCredential({ sessionId, viewerIdentityId: VIEWER,
    browserInstanceId: "different-browser-000", mediaCredential: credential.mediaCredential }), false);
  store.destroySession(sessionId);
  assert.equal(store.verifyViewerCredential({ sessionId, viewerIdentityId: VIEWER,
    browserInstanceId: "browser-instance-bound", mediaCredential: credential.mediaCredential }), false);
  now = new Date(now.getTime() + 60_000);
});

test("concurrent same-viewer browsers retain independent entry secrets and revoke together", async () => {
  const f = fixture(), owner = context(OWNER, ["cast:use", "cast:view"]);
  const session = await f.service.startSession({context: owner, idempotencyKey: "concurrent-browser-entry",
    input: {outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600}});
  // Establish the shared user authority before racing independent browser
  // entry secrets; this is the actual multi-window failure reproduced live.
  await f.service.join({context: owner, sessionId: session.id, browserInstanceId: "browser-instance-initial"});
  const browsers = Array.from({length: 8}, (_, i) => `browser-instance-parallel-${i}`);
  const joins = await Promise.all(browsers.map(browserInstanceId =>
    f.service.join({context: owner, sessionId: session.id, browserInstanceId})));
  const connections = await Promise.all(joins.map((join, i) => f.service.createMediaConnection({
    context: owner, sessionId: session.id, browserInstanceId: browsers[i], mediaCredential: join.mediaCredential})));
  assert.equal(connections.length, 8);
  assert.equal(new Set(connections.map(c => c.grantId)).size, 1);
  const replacement = await f.service.join({context: owner, sessionId: session.id, browserInstanceId: browsers[0]});
  assert.equal(f.ephemeralStore.verifyViewerCredential({sessionId: session.id, viewerIdentityId: OWNER,
    browserInstanceId: browsers[0], mediaCredential: joins[0].mediaCredential}), false);
  assert.equal(f.ephemeralStore.verifyViewerCredential({sessionId: session.id, viewerIdentityId: OWNER,
    browserInstanceId: browsers[0], mediaCredential: replacement.mediaCredential}), true);
  for (let i = 1; i < 8; i++) assert.equal(f.ephemeralStore.verifyViewerCredential({sessionId: session.id,
    viewerIdentityId: OWNER, browserInstanceId: browsers[i], mediaCredential: joins[i].mediaCredential}), true);
  await f.service.leave({context: owner, sessionId: session.id});
  for (let i = 1; i < 8; i++) assert.equal(f.ephemeralStore.verifyViewerCredential({sessionId: session.id,
    viewerIdentityId: OWNER, browserInstanceId: browsers[i], mediaCredential: joins[i].mediaCredential}), false);
  f.service.close();
});

test("ephemeral receiver creation fails closed on malformed name or PIN entropy", () => {
  const sessionId = "50000000-0000-4000-8000-000000000098";
  const expiresAt = new Date("2026-09-04T08:01:00Z");
  const badName = new MemoryCastingEphemeralStore({
    clock: () => new Date("2026-09-04T08:00:00Z"),
    randomBytesFactory: (length) => Buffer.alloc(length === 5 ? 4 : length),
  });
  assert.throws(() => badName.createSession({ sessionId, expiresAt }), /receiver-name entropy is invalid/);
  assert.equal(badName.describe(sessionId), null);

  const badPin = new MemoryCastingEphemeralStore({
    clock: () => new Date("2026-09-04T08:00:00Z"),
    randomBytesFactory: (length) => Buffer.alloc(length),
    randomIntFactory: () => 1_000_000,
  });
  assert.throws(() => badPin.createSession({ sessionId, expiresAt }), /pairing PIN entropy is invalid/);
  assert.equal(badPin.describe(sessionId), null);
});

test("initiator sign-out stops its active session and viewer authorization revocation disconnects only that viewer", async () => {
  const { service, repository, authorization, runtimeEvents } = fixture();
  const owner = context(OWNER, ["cast:use", "cast:share", "cast:view"]);
  const viewer = context(VIEWER, ["cast:view"], [{ teamId: TEAM, teamKey: "team.default" }]);
  const started = await service.startSession({ context: owner, idempotencyKey: "revocation-1", input: {
    outputSinks: ["browser"], browserAudience: "selected_users", viewerUserIds: [VIEWER], ttlSeconds: 600,
  } });
  const invitation = (await service.listInvitations({ context: viewer }))[0];
  await service.acceptInvitation({ context: viewer, invitationId: invitation.id });
  await service.join({ context: viewer, sessionId: started.id, invitationId: invitation.id,
    browserInstanceId: "browser-instance-revoke" });
  authorization.get(VIEWER).permissions = [];
  assert.deepEqual(await service.reconcileViewerAuthorization(started.id, VIEWER), { disconnected: true });
  assert.equal((await repository.getSession(started.id)).state, "pairing");
  assert.ok(runtimeEvents.some((event) => event.type === "disconnect" && event.viewerIdentityId === VIEWER));
  await service.handleInitiatorSignOut(OWNER);
  assert.equal((await repository.getSession(started.id)).state, "stopped");
  assert.ok(runtimeEvents.some((event) => event.type === "stop" && event.reasonCode === "cast_initiator_signed_out"));
});

test("a team viewer's page query revokes its native grant before reporting lost membership", async () => {
  const f=fixture(),owner=context(OWNER,["cast:use","cast:view","cast:share"]);
  const viewer=context(VIEWER,["cast:view"],[{teamId:TEAM,teamKey:"team.default"}]);
  const started=await f.service.startSession({context:owner,idempotencyKey:"membership-page",input:{
    outputSinks:["browser"],browserAudience:"selected_team",viewerTeamId:TEAM,ttlSeconds:600}});
  const invitation=await f.service.createInvitation({context:owner,sessionId:started.id,inviteeIdentityId:VIEWER});
  await f.service.acceptInvitation({context:viewer,invitationId:invitation.id});
  const joined=await f.service.join({context:viewer,sessionId:started.id,invitationId:invitation.id,browserInstanceId:"team-viewer-browser"});
  f.authorization.get(VIEWER).teamMemberships=[];
  await assert.rejects(f.service.getSession({context:viewer,sessionId:started.id}),{code:"cast_session_not_found"});
  assert.equal(await f.repository.getOpenGrant({sessionId:started.id,viewerIdentityId:VIEWER}),null);
  assert.equal(f.ephemeralStore.verifyViewerCredential({sessionId:started.id,viewerIdentityId:VIEWER,
    browserInstanceId:"team-viewer-browser",mediaCredential:joined.mediaCredential}),false);
  assert.deepEqual(await f.service.listViewers({context:owner,sessionId:started.id}),[]);
  assert.equal((await f.repository.getSession(started.id)).state,"pairing");
  const disconnects=f.runtimeEvents.filter(e=>e.type==="disconnect");
  assert.equal(disconnects.length,1);assert.equal(disconnects[0].viewerIdentityId,VIEWER);
  await assert.rejects(f.service.getSession({context:viewer,sessionId:started.id}),{code:"cast_session_not_found"});
  assert.equal(f.runtimeEvents.filter(e=>e.type==="disconnect").length,1,'repeated denied reads have no new cleanup');
});

test("membership cleanup failure is truthful while native grant remains revoked", async () => {
  const f=fixture(),owner=context(OWNER,["cast:use","cast:view","cast:share"]);
  const viewer=context(VIEWER,["cast:view"],[{teamId:TEAM,teamKey:"team.default"}]);
  const started=await f.service.startSession({context:owner,idempotencyKey:"membership-cleanup-failure",input:{
    outputSinks:["browser"],browserAudience:"selected_team",viewerTeamId:TEAM,ttlSeconds:600}});
  const invitation=await f.service.createInvitation({context:owner,sessionId:started.id,inviteeIdentityId:VIEWER});
  await f.service.acceptInvitation({context:viewer,invitationId:invitation.id});
  await f.service.join({context:viewer,sessionId:started.id,invitationId:invitation.id,browserInstanceId:"team-viewer-browser"});
  f.authorization.get(VIEWER).teamMemberships=[];
  f.runtime.disconnectViewer=async()=>{throw Error('runtime unavailable');};
  await assert.rejects(f.service.getSession({context:viewer,sessionId:started.id}),{code:"cast_media_revocation_incomplete"});
  assert.equal(await f.repository.getOpenGrant({sessionId:started.id,viewerIdentityId:VIEWER}),null);
  assert.equal((await f.repository.getSession(started.id)).state,"pairing");
});

test("a scoped team administrator may share only to its current managed team", async () => {
  const { service, authorization } = fixture();
  authorization.get(OWNER).permissions = ["cast:use", "cast:view"];
  authorization.get(OWNER).teamMemberships = [{ teamId: TEAM, teamKey: "team.default", roleKey: "team_admin" }];
  const teamAdmin = context(OWNER, ["cast:use", "cast:view"], [
    { teamId: TEAM, teamKey: "team.default", roleKey: "team_admin" },
  ]);
  const started = await service.startSession({ context: teamAdmin, idempotencyKey: "team-share-1", input: {
    outputSinks: ["browser"], browserAudience: "selected_team", viewerTeamId: TEAM, ttlSeconds: 600,
  } });
  assert.equal(started.browserAudience, "selected_team");
});

test("a process restart fails closed by removing the old receiver before terminalizing its durable session", async () => {
  const first = fixture();
  const owner = context(OWNER, ["cast:use", "cast:view"]);
  const started = await first.service.startSession({ context: owner, idempotencyKey: "restart-1",
    input: { outputSinks: ["browser"], browserAudience: "owner_only", ttlSeconds: 600 } });
  const replacementEphemeral = new MemoryCastingEphemeralStore({ clock: first.now });
  const replacement = new CastingSessionService({ repository: first.repository, ephemeralStore: replacementEphemeral,
    runtime: first.runtime, directory: first.directory, admission: first.admission,
    applianceNodeId: GROUP, clock: first.now });
  assert.deepEqual(await replacement.reconcileStartup(), { recovered: true, sessionId: started.id });
  assert.equal((await first.repository.getSession(started.id)).state, "failed");
  assert.ok(first.runtimeEvents.some((event) => event.type === "stop"
    && event.reasonCode === "cast_control_plane_restarted"));
  first.service.close(); replacement.close();
});
