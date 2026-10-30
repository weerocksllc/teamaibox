import { createHash, randomUUID } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BROWSER_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SOURCE_CONNECTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const MEDIA_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const MEDIA_ACCESS_TOKEN = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}$/;
const TERMINAL = new Set(["stopped", "expired", "failed"]);
const STOPPABLE = new Set(["requested", "starting", "pairing", "paired", "streaming", "stopping"]);
const MEDIA_CONNECTABLE = new Set(["pairing", "paired", "streaming"]);
const AUDIENCES = new Set(["owner_only", "selected_users", "selected_team"]);
const REASON = /^[a-z][a-z0-9_.-]{2,127}$/;

export const castingMediaPrivacyPolicyV1 = Object.freeze({
  schemaVersion: 1,
  recordingAllowed: false,
  userContentScreenshotsAllowed: false,
  indexingAllowed: false,
  objectStorePersistenceAllowed: false,
  persistentMediaBuffersAllowed: false,
  sourceDeviceLabelPersistenceAllowed: false,
});

function fail(code, message, status = 400, retryable = false) {
  throw new PlatformError(code, message, { status, retryable });
}
function date(value) { return value instanceof Date ? new Date(value) : new Date(value); }
function iso(value) { return value == null ? null : date(value).toISOString(); }
function permissions(context) { return new Set(context?.permissions ?? []); }
function actor(context) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "")) fail("invalid_session", "Authentication is required", 401);
  return identityId.toLowerCase();
}
function requirePermission(context, permission) {
  const identityId = actor(context);
  if (!permissions(context).has(permission)) fail("cast_permission_required", `Missing permission: ${permission}`, 403);
  return identityId;
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function active(session) { return session && !TERMINAL.has(session.state); }
function teamIds(context) { return (context?.teamMemberships ?? []).map((item) => item.teamId).filter(Boolean); }

function outputPolicy(input, initiatorIdentityId) {
  // Omission is the browser-only default. An explicitly supplied legacy or
  // malformed selector must fail before admission, persistence or discovery.
  const requested = input?.outputSinks === undefined ? ["browser"] : input.outputSinks;
  if (!Array.isArray(requested) || requested.length !== 1 || requested[0] !== "browser") {
    fail("cast_output_invalid", "Casting is available only in the browser");
  }
  const outputSinks = ["browser"];
  const browserAudience = input.browserAudience ?? input.browser_audience ?? null;
  const viewerUserIds = input.viewerUserIds ?? input.viewer_user_ids ?? [];
  const viewerTeamId = input.viewerTeamId ?? input.viewer_team_id ?? null;
  if (!AUDIENCES.has(browserAudience)) fail("cast_audience_invalid", "A valid browser audience is required");
  if (!Array.isArray(viewerUserIds) || viewerUserIds.length > 50
    || viewerUserIds.some((id) => !UUID.test(id ?? ""))) fail("cast_audience_invalid", "Casting user audience is invalid");
  const users = [...new Set(viewerUserIds.map((id) => id.toLowerCase()))];
  if (users.length !== viewerUserIds.length || users.includes(initiatorIdentityId)) {
    fail("cast_audience_invalid", "Casting user targets must be unique and cannot include the initiator");
  }
  if (browserAudience === "owner_only" && (users.length || viewerTeamId !== null)) {
    fail("cast_audience_invalid", "Owner-only casting cannot have audience targets");
  }
  if (browserAudience === "selected_users" && (users.length < 1 || viewerTeamId !== null)) {
    fail("cast_audience_invalid", "Selected-user casting requires only user targets");
  }
  if (browserAudience === "selected_team" && (users.length || !UUID.test(viewerTeamId ?? ""))) {
    fail("cast_audience_invalid", "Selected-team casting requires exactly one team target");
  }
  return { outputSinks, browserAudience, viewerUserIds: users,
    viewerTeamId: browserAudience === "selected_team" ? viewerTeamId.toLowerCase() : null };
}

function sourceStatus(value) {
  // The durable session records receiver lifetime; the authenticated native
  // stream lifecycle independently reports whether a phone is still sending.
  const state = value?.progress?.sourceState;
  const revision = value?.progress?.sourceStateRevision;
  return Object.freeze({
    sourceState: ["waiting", "connected", "disconnected", "unknown"].includes(state) ? state : "unknown",
    sourceStateRevision: Number.isSafeInteger(revision) && revision >= 1 ? revision : 1,
  });
}

function safeHealth(value, outputSinks) {
  return Object.freeze({ receiverHealthy: value?.healthy === true,
    outputs: Object.freeze(Object.fromEntries(outputSinks.map((sink) => [sink,
      value?.outputs?.[sink]?.healthy === true ? "available"
        : value?.outputs?.[sink]?.healthy === false ? "unavailable" : "unknown"]))) });
}

function publicSession(session, { role, ephemeral = null, targets = [], viewerCount = null,
  outputHealth = null, sourceState, sourceStateRevision } = {}) {
  const common = {
    id: session.sessionId,
    object: role === "manager" ? "cast.session.health" : "cast.session",
    state: session.state,
    stateRevision: session.stateRevision,
    audienceRevision: session.audienceRevision,
    outputSinks: Object.freeze([...session.outputSinks]),
    browserAudience: session.browserAudience,
    expiresAt: iso(session.expiresAt),
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
    terminalAt: iso(session.terminalAt),
    terminalReasonCode: session.terminalReasonCode,
    ...(sourceState ? { sourceState, sourceStateRevision } : {}),
  };
  if (role === "manager") return Object.freeze({ ...common, viewerCount, outputHealth });
  const audience = role === "owner" ? {
    viewerUserIds: Object.freeze(targets.filter((item) => item.targetKind === "user").map((item) => item.targetIdentityId)),
    viewerTeamId: targets.find((item) => item.targetKind === "team")?.targetTeamId ?? null,
  } : {};
  return Object.freeze({ ...common, ...audience,
    ...(role === "owner" ? { outputHealth } : {}),
    ...(role === "owner" && ephemeral ? {
      receiver: Object.freeze({ name: ephemeral.receiverName, pin: ephemeral.pin,
        sourcePaired: ephemeral.sourcePaired, sourceDeviceLabel: ephemeral.sourceDeviceLabel }),
    } : {}),
  });
}

function requiredRepository(repository) {
  return ["createSession", "getSession", "findActiveSession", "getAudienceTargets", "transitionSession",
    "recordPairingFailure", "replaceAudience", "downgradeAudienceToOwner", "createInvitation",
    "getInvitation", "listInvitationsForIdentity", "resolveInvitation", "isIdentityInAudience",
    "createGrant", "getOpenGrant", "joinGrant", "endGrant", "listJoinedViewers", "expireDue"]
    .every((method) => typeof repository?.[method] === "function");
}

export class CastingSessionService {
  #repository; #ephemeral; #runtime; #directory; #admission; #audit; #clock; #idFactory;
  #applianceNodeId; #startWindowMilliseconds; #maximumStartsPerWindow; #stopRetryMilliseconds;
  #setTimeout; #clearTimeout;
  #starts = new Map(); #idempotency = new Map(); #expiryTimers = new Map();

  constructor({ repository, ephemeralStore, runtime, directory, admission = null, applianceNodeId,
    audit = async () => {}, clock = () => new Date(), idFactory = randomUUID,
    startWindowMilliseconds = 60_000, maximumStartsPerWindow = 3, stopRetryMilliseconds = 1_000,
    setTimeoutFactory = setTimeout, clearTimeoutFactory = clearTimeout } = {}) {
    if (!requiredRepository(repository) || !ephemeralStore?.createSession || !ephemeralStore?.destroySession
      || !ephemeralStore?.issueViewerCredential || !ephemeralStore?.verifyViewerCredential
      || !ephemeralStore?.verifyAndPair || !ephemeralStore?.verifySourceConnection
      || !ephemeralStore?.revokeViewer || !ephemeralStore?.revokeAllExcept || !ephemeralStore?.hasViewerCredentials
      || !ephemeralStore?.markViewerCredentialAdmitted
      || !runtime?.startReceiver || !runtime?.updateReceiver || !runtime?.stopReceiver
      || !runtime?.issueViewerConnection || !runtime?.disconnectViewer || !runtime?.health
      || !directory?.authorization || !directory?.identity || !directory?.identities || !directory?.team
      || (admission !== null && (typeof admission?.status !== "function"
        || typeof admission?.assertSessionStartAllowed !== "function"))
      || !UUID.test(applianceNodeId ?? "") || typeof audit !== "function" || typeof clock !== "function"
      || typeof idFactory !== "function" || !Number.isSafeInteger(startWindowMilliseconds) || startWindowMilliseconds < 1_000
      || !Number.isSafeInteger(maximumStartsPerWindow) || maximumStartsPerWindow < 1
      || !Number.isSafeInteger(stopRetryMilliseconds) || stopRetryMilliseconds < 10 || stopRetryMilliseconds > 60_000
      || typeof setTimeoutFactory !== "function" || typeof clearTimeoutFactory !== "function") {
      throw new TypeError("casting session service dependencies are incomplete");
    }
    this.#repository = repository; this.#ephemeral = ephemeralStore; this.#runtime = runtime;
    this.#admission = admission;
    this.#directory = directory; this.#audit = audit; this.#clock = clock; this.#idFactory = idFactory;
    this.#applianceNodeId = applianceNodeId; this.#startWindowMilliseconds = startWindowMilliseconds;
    this.#maximumStartsPerWindow = maximumStartsPerWindow; this.#stopRetryMilliseconds = stopRetryMilliseconds;
    this.#setTimeout = setTimeoutFactory; this.#clearTimeout = clearTimeoutFactory;
  }

  async startSession({ context, input, idempotencyKey }) {
    const identityId = requirePermission(context, "cast:use");
    if (!IDEMPOTENCY_KEY.test(idempotencyKey ?? "")) fail("cast_idempotency_required", "A valid Idempotency-Key is required");
    const policy = outputPolicy(input, identityId);
    if (policy.outputSinks.includes("browser")) requirePermission(context, "cast:view");
    if (["selected_users", "selected_team"].includes(policy.browserAudience)) {
      await this.#requireShareAuthority(context, policy);
    }
    await this.#validateTargets(policy);
    const now = this.#clock();
    const ttlSeconds = input?.ttlSeconds ?? input?.ttl_seconds ?? 1800;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 14_400) {
      fail("cast_ttl_invalid", "Casting session TTL must be between 60 seconds and four hours");
    }
    const key = `${identityId}:${idempotencyKey}`;
    const requestDigest = digest(JSON.stringify({ ...policy, ttlSeconds }));
    for (const [presentKey, value] of this.#idempotency) {
      if (value.expiresAt <= now) this.#idempotency.delete(presentKey);
    }
    const replay = this.#idempotency.get(key);
    if (replay) {
      if (replay.requestDigest !== requestDigest) fail("cast_idempotency_conflict", "Idempotency key was reused with different inputs", 409);
      const session = await this.#repository.getSession(replay.sessionId);
      if (session) return this.#ownerView(session);
    }
    await this.#assertOutputsAdmitted(policy.outputSinks);
    this.#enforceStartRate(identityId, now);
    await this.expireDue();
    const activeSession = await this.#repository.findActiveSession(this.#applianceNodeId);
    if (activeSession) fail("cast_session_busy", "This appliance already has an active casting session", 409);
    const sessionId = this.#idFactory();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const targets = this.#targets(policy, identityId, now);
    const inviteeIds = policy.browserAudience === "selected_users" ? policy.viewerUserIds : [];
    const invitations = inviteeIds.map((inviteeIdentityId) => this.#invitation({ sessionId, inviteeIdentityId,
      initiatorIdentityId: identityId, audienceRevision: 1, now, sessionExpiresAt: expiresAt }));
    let session = await this.#repository.createSession({
      session: { sessionId, applianceNodeId: this.#applianceNodeId, initiatorIdentityId: identityId,
        outputSinks: policy.outputSinks, browserAudience: policy.browserAudience,
        createdAt: now, updatedAt: now, expiresAt }, targets, invitations,
    });
    let receiver;
    let runtimeStartAttempted = false;
    try {
      receiver = this.#ephemeral.createSession({ sessionId, expiresAt });
      runtimeStartAttempted = true;
      await this.#runtime.startReceiver({ sessionId, receiverName: receiver.receiverName, pairingPin: receiver.pin,
        outputSinks: policy.outputSinks, browserStartsMuted: false,
        mediaPrivacyPolicy: castingMediaPrivacyPolicyV1, expiresAt });
      session = await this.#repository.transitionSession({ sessionId, expectedStateRevision: session.stateRevision,
        toState: "starting", actorIdentityId: identityId, at: now });
      session = await this.#repository.transitionSession({ sessionId, expectedStateRevision: session.stateRevision,
        toState: "pairing", actorIdentityId: identityId, at: now });
    } catch (error) {
      this.#ephemeral.destroySession(sessionId);
      if (runtimeStartAttempted) {
        const retry = { sessionId, actorIdentityId: identityId, reasonCode: "cast_receiver_start_failed",
          force: false, terminalState: "failed", eventType: "session.failed",
          successAuditAction: "security.cast_start_cleanup_completed" };
        try {
          await this.#runtime.stopReceiver({ sessionId, reasonCode: retry.reasonCode });
        } catch {
          this.#scheduleStopRetry(retry);
          await this.#auditSafe("security.cast_start_cleanup_pending", identityId,
            sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
          throw new PlatformError("cast_receiver_stop_pending",
            "Casting receiver startup failed and withdrawal is pending a fail-closed retry", {
              status: 503, retryable: true,
            });
        }
      }
      try {
        if (active(session)) await this.#repository.transitionSession({ sessionId, expectedStateRevision: session.stateRevision,
          toState: "failed", actorIdentityId: identityId, reasonCode: "cast_receiver_start_failed",
          eventType: "session.failed", at: this.#clock() });
      } catch {
        this.#scheduleStopRetry({ sessionId, actorIdentityId: identityId, reasonCode: "cast_receiver_start_failed",
          force: false, terminalState: "failed", eventType: "session.failed",
          successAuditAction: "security.cast_start_cleanup_completed" });
        await this.#auditSafe("security.cast_start_cleanup_pending", identityId,
          sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
        throw new PlatformError("cast_receiver_stop_pending",
          "Casting receiver startup cleanup is pending durable completion", { status: 503, retryable: true });
      }
      await this.#auditSafe("security.cast_start_failed", identityId, sessionId, "failed", "cast_receiver_start_failed");
      throw error;
    }
    this.#idempotency.set(key, { requestDigest, sessionId, expiresAt });
    this.#scheduleExpiry(sessionId, expiresAt, now);
    await this.#auditSafe("security.cast_started", identityId, sessionId);
    return this.#ownerView(session);
  }

  async currentSession({ context }) {
    const identityId = actor(context);
    const session = await this.#repository.findActiveSession(this.#applianceNodeId);
    if (!session) return null;
    await this.reconcileAuthorization(session.sessionId);
    const current = await this.#repository.getSession(session.sessionId);
    return this.#view(context, identityId, current);
  }

  async getSession({ context, sessionId }) {
    const identityId = actor(context);
    const session = await this.#session(sessionId);
    if (active(session)) await this.reconcileAuthorization(sessionId);
    return this.#view(context, identityId, await this.#session(sessionId));
  }

  async updateAudience({ context, sessionId, input }) {
    const identityId = requirePermission(context, "cast:use");
    let session = await this.#session(sessionId);
    this.#requireOwner(session, identityId);
    const policy = outputPolicy(input, identityId);
    if (policy.outputSinks.includes("browser")) requirePermission(context, "cast:view");
    if (["selected_users", "selected_team"].includes(policy.browserAudience)) {
      await this.#requireShareAuthority(context, policy);
    }
    await this.#validateTargets(policy);
    await this.#assertOutputsAdmitted(policy.outputSinks);
    const now = this.#clock();
    const targets = this.#targets(policy, identityId, now);
    const invitations = (policy.browserAudience === "selected_users" ? policy.viewerUserIds : [])
      .map((inviteeIdentityId) => this.#invitation({ sessionId, inviteeIdentityId, initiatorIdentityId: identityId,
        audienceRevision: session.audienceRevision + 1, now, sessionExpiresAt: session.expiresAt }));
    const previousViewers = await this.#repository.listJoinedViewers(sessionId, now);
    const previousAudienceRevision = session.audienceRevision;
    session = await this.#repository.replaceAudience({ sessionId, expectedAudienceRevision: session.audienceRevision,
      outputSinks: policy.outputSinks, browserAudience: policy.browserAudience, targets, invitations,
      actorIdentityId: identityId, at: now });
    if (session.audienceRevision === previousAudienceRevision) return this.#ownerView(session);
    try {
      await this.#runtime.updateReceiver({ sessionId, outputSinks: policy.outputSinks,
        browserStartsMuted: false,
        mediaPrivacyPolicy: castingMediaPrivacyPolicyV1 });
    } catch (error) {
      await this.#stop(session, identityId, "cast_output_update_failed", true);
      throw error;
    }
    this.#ephemeral.revokeAllExcept({ sessionId, viewerIdentityId: "00000000-0000-4000-8000-000000000000" });
    await Promise.all(previousViewers
      .map((item) => this.#runtime.disconnectViewer({ sessionId, viewerIdentityId: item.viewerIdentityId,
        reasonCode: "cast_audience_changed" })));
    await this.#auditSafe("security.cast_audience_changed", identityId, sessionId);
    return this.#ownerView(session);
  }

  async createInvitation({ context, sessionId, inviteeIdentityId }) {
    const identityId = requirePermission(context, "cast:use"); requirePermission(context, "cast:view");
    const session = await this.#session(sessionId); this.#requireOwner(session, identityId);
    const activeTargets = await this.#repository.getAudienceTargets(sessionId);
    await this.#requireShareAuthority(context, { browserAudience: session.browserAudience,
      viewerUserIds: activeTargets.filter((item) => item.targetKind === "user").map((item) => item.targetIdentityId),
      viewerTeamId: activeTargets.find((item) => item.targetKind === "team")?.targetTeamId ?? null });
    if (!UUID.test(inviteeIdentityId ?? "") || inviteeIdentityId === identityId) {
      fail("cast_invitee_invalid", "Casting invitee is invalid");
    }
    if (!await this.#repository.isIdentityInAudience({ sessionId, identityId: inviteeIdentityId,
      teamIds: (await this.#directory.authorization(inviteeIdentityId))?.teamMemberships?.map((item) => item.teamId) ?? [],
      now: this.#clock() })) fail("cast_invitee_not_in_audience", "Invitee is not in the current casting audience", 403);
    const now = this.#clock();
    const invitation = await this.#repository.createInvitation(this.#invitation({ sessionId, inviteeIdentityId,
      initiatorIdentityId: identityId, audienceRevision: session.audienceRevision, now,
      sessionExpiresAt: session.expiresAt }));
    await this.#auditSafe("security.cast_invitation_created", identityId, sessionId);
    return this.#publicInvitation(invitation);
  }

  async listInvitations({ context }) {
    const identityId = requirePermission(context, "cast:view");
    const values = await this.#repository.listInvitationsForIdentity(identityId, this.#clock());
    return Object.freeze(values.map((value) => this.#publicInvitation(value)));
  }

  async acceptInvitation({ context, invitationId }) {
    const identityId = requirePermission(context, "cast:view");
    const invitation = await this.#repository.getInvitation(invitationId);
    if (!invitation || invitation.inviteeIdentityId !== identityId) fail("cast_invitation_not_found", "Casting invitation was not found", 404);
    const authorization = await this.#directory.authorization(identityId);
    if (!await this.#repository.isIdentityInAudience({ sessionId: invitation.sessionId, identityId,
      teamIds: authorization?.teamMemberships?.map((item) => item.teamId) ?? [], now: this.#clock() })) {
      fail("cast_audience_revoked", "Casting audience access is no longer available", 403);
    }
    return this.#publicInvitation(await this.#repository.resolveInvitation({ invitationId, inviteeIdentityId: identityId,
      state: "accepted", at: this.#clock() }));
  }

  async declineInvitation({ context, invitationId }) {
    const identityId = requirePermission(context, "cast:view");
    return this.#publicInvitation(await this.#repository.resolveInvitation({ invitationId,
      inviteeIdentityId: identityId, state: "declined", at: this.#clock() }));
  }

  async join({ context, sessionId, invitationId = null, browserInstanceId }) {
    const identityId = requirePermission(context, "cast:view");
    const session = await this.#session(sessionId);
    const authorization = await this.#directory.authorization(identityId);
    const inAudience = await this.#repository.isIdentityInAudience({ sessionId, identityId,
      teamIds: authorization?.teamMemberships?.map((item) => item.teamId) ?? teamIds(context), now: this.#clock() });
    if (!inAudience) fail("cast_audience_denied", "Casting viewer is outside the current audience", 403);
    let invitation = null;
    if (identityId !== session.initiatorIdentityId) {
      invitation = await this.#repository.getInvitation(invitationId);
      if (!invitation || invitation.sessionId !== sessionId || invitation.inviteeIdentityId !== identityId
        || invitation.state !== "accepted" || invitation.audienceRevision !== session.audienceRevision) {
        fail("cast_invitation_required", "An accepted current invitation is required", 403);
      }
    }
    const now = this.#clock();
    let grant = await this.#repository.getOpenGrant({ sessionId, viewerIdentityId: identityId });
    if (grant && grant.expiresAt <= now) {
      await this.#repository.endGrant({ sessionId, viewerIdentityId: identityId, state: "expired",
        actorIdentityId: session.initiatorIdentityId, reasonCode: "cast_viewer_grant_expired", at: now });
      grant = null;
    }
    if (!grant) grant = await this.#repository.createGrant({ grantId: this.#idFactory(), sessionId,
      audienceRevision: session.audienceRevision, viewerIdentityId: identityId, invitationId: invitation?.invitationId ?? null,
      issuedByIdentityId: session.initiatorIdentityId, issuedAt: now,
      // Viewing lasts until the receiver session ends or authority is revoked.
      // The short-lived secret below only authorizes a NEW media connection;
      // expiring it must not terminate already-authorized WebRTC playback.
      expiresAt: new Date(session.expiresAt) });
    if (grant.state === "issued") grant = await this.#repository.joinGrant({ grantId: grant.grantId,
      expectedRevision: grant.revision, at: now });
    try {
      const credential = this.#ephemeral.issueViewerCredential({ sessionId, viewerIdentityId: identityId,
        browserInstanceId, expiresAt: new Date(Math.min(grant.expiresAt.getTime(), now.getTime() + 5 * 60_000)) });
      await this.#auditSafe("security.cast_viewer_joined", identityId, sessionId);
      return Object.freeze({ sessionId, viewerIdentityId: identityId, grantId: grant.grantId,
        mediaCredential: credential.mediaCredential, expiresAt: credential.expiresAt,
        muted: false });
    } catch (error) {
      await this.#repository.endGrant({ sessionId, viewerIdentityId: identityId, state: "revoked",
        actorIdentityId: session.initiatorIdentityId, reasonCode: "cast_media_credential_failed", at: this.#clock() });
      throw error;
    }
  }

  async leave({ context, sessionId, browserInstanceId }) {
    const identityId = requirePermission(context, "cast:view");
    if (browserInstanceId !== undefined && (typeof browserInstanceId !== "string" || !BROWSER_INSTANCE.test(browserInstanceId))) {
      fail("cast_viewer_context_invalid", "Casting viewer context is invalid");
    }
    const scope = browserInstanceId === undefined ? {} : { browserInstanceId };
    this.#ephemeral.revokeViewer({ sessionId, viewerIdentityId: identityId, ...scope });
    const removed = await this.#runtime.disconnectViewer({ sessionId, viewerIdentityId: identityId,
      ...scope, reasonCode: "cast_viewer_left" });
    if (browserInstanceId !== undefined) {
      if (!Number.isSafeInteger(removed?.remainingBrowserConnections) || removed.remainingBrowserConnections < 0) {
        fail("cast_media_runtime_unavailable", "Casting viewer cleanup could not be confirmed", 503);
      }
      // Another page may have joined but not yet opened its signalling
      // connection. Do not invalidate that page's shared viewing grant.
      if (removed.remainingBrowserConnections > 0
        || this.#ephemeral.hasViewerCredentials({ sessionId, viewerIdentityId: identityId })) {
        await this.#auditSafe("security.cast_viewer_left", identityId, sessionId);
        return Object.freeze({ sessionId, left: true });
      }
    }
    const grant = await this.#repository.endGrant({ sessionId, viewerIdentityId: identityId, state: "left",
      actorIdentityId: identityId, reasonCode: "cast_viewer_left", at: this.#clock() });
    await this.#auditSafe("security.cast_viewer_left", identityId, sessionId);
    return Object.freeze({ sessionId, left: Boolean(grant) });
  }

  async listViewers({ context, sessionId }) {
    const identityId = requirePermission(context, "cast:use");
    const session = await this.#session(sessionId); this.#requireOwner(session, identityId);
    const grants = await this.#repository.listJoinedViewers(sessionId, this.#clock());
    const identities = await this.#directory.identities(grants.map((item) => item.viewerIdentityId));
    const byId = new Map(identities.map((item) => [item.identityId, item]));
    return Object.freeze(grants.map((grant) => Object.freeze({ viewerIdentityId: grant.viewerIdentityId,
      displayName: byId.get(grant.viewerIdentityId)?.displayName ?? null, joinedAt: iso(grant.joinedAt),
      expiresAt: iso(grant.expiresAt) })));
  }

  async removeViewer({ context, sessionId, viewerIdentityId }) {
    const identityId = requirePermission(context, "cast:use");
    const session = await this.#session(sessionId); this.#requireOwner(session, identityId);
    if (!UUID.test(viewerIdentityId ?? "") || viewerIdentityId === identityId) {
      fail("cast_viewer_invalid", "The casting viewer is invalid");
    }
    this.#ephemeral.revokeViewer({ sessionId, viewerIdentityId });
    await this.#runtime.disconnectViewer({ sessionId, viewerIdentityId, reasonCode: "cast_viewer_removed" });
    const grant = await this.#repository.endGrant({ sessionId, viewerIdentityId, state: "revoked",
      actorIdentityId: identityId, reasonCode: "cast_viewer_removed", at: this.#clock() });
    await this.#auditSafe("security.cast_viewer_removed", identityId, sessionId,
      "succeeded", "cast_viewer_removed");
    return Object.freeze({ sessionId, viewerIdentityId, removed: Boolean(grant) });
  }

  async stopSession({ context, sessionId }) {
    const identityId = requirePermission(context, "cast:use");
    const session = await this.#session(sessionId); this.#requireOwner(session, identityId, false);
    return this.#stop(session, identityId, "cast_stopped_by_initiator", false);
  }

  async forceStop({ context, sessionId }) {
    const identityId = requirePermission(context, "cast:manage");
    const session = await this.#session(sessionId);
    return this.#stop(session, identityId, "cast_force_stopped", true);
  }

  async handleInitiatorSignOut(identityId) {
    if (!UUID.test(identityId ?? "")) return null;
    const session = await this.#repository.findActiveSession(this.#applianceNodeId);
    if (!session || session.initiatorIdentityId !== identityId) return null;
    return this.#stop(session, identityId, "cast_initiator_signed_out", false);
  }

  async reconcileViewerAuthorization(sessionId, viewerIdentityId) {
    if (!UUID.test(viewerIdentityId ?? "")) return Object.freeze({ disconnected: false });
    const session = await this.#session(sessionId);
    const current = await this.#directory.authorization(viewerIdentityId);
    const authorized = current?.permissions?.includes("cast:view") === true
      && await this.#repository.isIdentityInAudience({ sessionId, identityId: viewerIdentityId,
        teamIds: current?.teamMemberships?.map((item) => item.teamId) ?? [], now: this.#clock() });
    if (authorized) return Object.freeze({ disconnected: false });
    const grant = await this.#revokeMediaViewer({ session, viewerIdentityId,
      grantState: "revoked", reasonCode: "cast_view_authorization_revoked" });
    return Object.freeze({ disconnected: Boolean(grant) });
  }

  async authorizeMediaConnection({ sessionId, viewerIdentityId, browserInstanceId, mediaCredential } = {}) {
    if (!UUID.test(sessionId ?? "") || !UUID.test(viewerIdentityId ?? "")
      || !BROWSER_INSTANCE.test(browserInstanceId ?? "") || !MEDIA_CREDENTIAL.test(mediaCredential ?? "")) {
      fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
    }
    const authority = await this.#currentMediaGrant({ sessionId, viewerIdentityId });
    if (!this.#ephemeral.verifyViewerCredential({ sessionId, viewerIdentityId,
      browserInstanceId, mediaCredential })) {
      // Invalid or expired entry secrets cannot revoke another live viewer.
      fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
    }
    return Object.freeze({ ...authority,
      expiresAt: iso(new Date(Math.min(date(authority.expiresAt).getTime(), this.#clock().getTime() + 5 * 60_000))) });
  }

  confirmMediaConnection(input) {
    if (!this.#ephemeral.markViewerCredentialAdmitted(input)) {
      fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
    }
    return Object.freeze({ admitted: true });
  }

  // Internal to the authenticated ingress. Only its existing connection owner
  // may call this; there is no HTTP/callback route for creating a connection
  // with a grant ID. The real login and browser binding stay in that owner.
  async reauthorizeConnectedMedia({ sessionId, viewerIdentityId, grantId } = {}) {
    if (![sessionId, viewerIdentityId, grantId].every(value => UUID.test(value ?? ""))) {
      fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
    }
    const authority = await this.#currentMediaGrant({ sessionId, viewerIdentityId });
    // A replacement grant is not authority for the old socket, and must not be
    // revoked merely because that old socket is being checked.
    if (authority.grantId !== grantId) {
      fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
    }
    return authority;
  }

  async #currentMediaGrant({ sessionId, viewerIdentityId }) {
    let session;
    let current;
    let grant;
    let inAudience;
    try {
      session = await this.#session(sessionId);
      current = await this.#directory.authorization(viewerIdentityId);
      grant = await this.#repository.getOpenGrant({ sessionId, viewerIdentityId });
      inAudience = current?.permissions?.includes("cast:view") === true
        && await this.#repository.isIdentityInAudience({ sessionId, identityId: viewerIdentityId,
          teamIds: current?.teamMemberships?.map((item) => item.teamId) ?? [], now: this.#clock() });
    } catch (error) {
      if (error?.code === "cast_session_not_found") {
        fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
      }
      throw new PlatformError("cast_media_authorization_unavailable",
        "Casting media authorization is temporarily unavailable", { status: 503, retryable: true, cause: error });
    }

    const now = this.#clock();
    const grantValid = grant?.state === "joined" && grant.expiresAt > now
      && grant.audienceRevision === session.audienceRevision;
    const authorityValid = MEDIA_CONNECTABLE.has(session.state) && session.outputSinks.includes("browser")
      && session.expiresAt > now && inAudience && grantValid;
    if (!authorityValid) {
      const expired = grant?.expiresAt <= now;
      await this.#revokeMediaViewer({ session, viewerIdentityId,
        grantState: expired ? "expired" : "revoked",
        reasonCode: expired ? "cast_viewer_grant_expired" : "cast_view_authorization_revoked" });
      fail("cast_media_authorization_denied", "Casting media authorization was denied", 403);
    }
    return Object.freeze({ authorized: true, sessionId, viewerIdentityId, grantId: grant.grantId,
      audienceRevision: session.audienceRevision,
      expiresAt: iso(grant.expiresAt),
      muted: false, maximumViewers: null, publisherEncodeRenditions: 1 });
  }

  async createMediaConnection({ context, sessionId, browserInstanceId, mediaCredential } = {}) {
    const viewerIdentityId = requirePermission(context, "cast:view");
    const authorization = await this.authorizeMediaConnection({ sessionId, viewerIdentityId,
      browserInstanceId, mediaCredential });
    let issued;
    try {
      issued = await this.#runtime.issueViewerConnection({
        sessionId: authorization.sessionId,
        viewerIdentityId: authorization.viewerIdentityId,
        grantId: authorization.grantId,
        audienceRevision: authorization.audienceRevision,
        browserInstanceId,
        expiresAt: authorization.expiresAt,
        muted: authorization.muted,
        maximumViewers: authorization.maximumViewers,
        publisherEncodeRenditions: authorization.publisherEncodeRenditions,
      });
    } catch (error) {
      await this.#revokeMediaViewer({ session: await this.#session(sessionId), viewerIdentityId,
        grantState: "revoked", reasonCode: "cast_media_connection_failed" }).catch(() => {});
      throw new PlatformError("cast_media_connection_unavailable",
        "Casting media connection is temporarily unavailable", { status: 503, retryable: true, cause: error });
    }
    let url;
    let expiry;
    try {
      url = this.#validatedMediaUrl(issued?.url);
      expiry = date(issued?.expiresAt);
      if (!MEDIA_ACCESS_TOKEN.test(issued?.accessToken ?? "") || !Number.isFinite(expiry.getTime())
        || expiry <= this.#clock() || expiry > date(authorization.expiresAt)
        || issued?.sessionId !== authorization.sessionId
        || issued?.viewerIdentityId !== authorization.viewerIdentityId
        || issued?.grantId !== authorization.grantId) {
        throw new TypeError("invalid casting media connection");
      }
    } catch {
      await this.#revokeMediaViewer({ session: await this.#session(sessionId), viewerIdentityId,
        grantState: "revoked", reasonCode: "cast_media_connection_invalid" }).catch(() => {});
      throw new PlatformError("cast_media_connection_invalid",
        "Casting media service returned an invalid connection", { status: 502, retryable: false });
    }
    await this.#auditSafe("security.cast_media_connection_issued", viewerIdentityId, sessionId);
    return Object.freeze({ sessionId: authorization.sessionId, viewerIdentityId,
      grantId: authorization.grantId, url, accessToken: issued.accessToken,
      expiresAt: expiry.toISOString(), muted: authorization.muted });
  }

  async health({ context, sessionId }) {
    requirePermission(context, "cast:manage");
    const session = await this.#session(sessionId);
    const [runtime, viewers] = await Promise.all([this.#displayHealth(session),
      this.#repository.listJoinedViewers(sessionId, this.#clock())]);
    const current = runtime?.receiverState === "failed" ? await this.#session(sessionId) : session;
    const outputHealth = safeHealth(runtime, current.outputSinks);
    return Object.freeze({ ...publicSession(current, { role: "manager", viewerCount: active(current) ? viewers.length : 0, outputHealth, ...sourceStatus(runtime) }),
      receiverHealthy: outputHealth.receiverHealthy });
  }

  #validatedMediaUrl(value) {
    if (typeof value !== "string" || value.length > 512) {
      fail("cast_media_connection_invalid", "Casting media URL is invalid", 502);
    }
    let parsed;
    try { parsed = new URL(value); } catch {
      fail("cast_media_connection_invalid", "Casting media URL is invalid", 502);
    }
    if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.hash
      || !parsed.hostname || parsed.search) {
      fail("cast_media_connection_invalid", "Casting media URL is invalid", 502);
    }
    return parsed.toString();
  }

  async pairSource({ sessionId, pin, sourceConnectionId, sourceDeviceLabel = null }) {
    let session = await this.#session(sessionId);
    if (["paired", "streaming"].includes(session.state)
      && this.#ephemeral.verifySourceConnection({ sessionId, sourceConnectionId })) {
      return Object.freeze({ paired: true, repeated: true, state: session.state });
    }
    if (session.state !== "pairing") fail("cast_pairing_unavailable", "Casting session is not accepting a source", 409);
    const result = this.#ephemeral.verifyAndPair({ sessionId, pin, sourceConnectionId, sourceDeviceLabel });
    if (!result.paired) {
      await this.#repository.recordPairingFailure({ sessionId, attempts: result.failedAttempts,
        blockedUntil: result.blockedUntil, at: this.#clock() });
      return result;
    }
    session = await this.#repository.transitionSession({ sessionId, expectedStateRevision: session.stateRevision,
      toState: "paired", actorIdentityId: session.initiatorIdentityId, at: this.#clock() });
    return Object.freeze({ paired: true, repeated: result.repeated, state: session.state });
  }

  async markStreaming({ sessionId, sourceConnectionId } = {}) {
    if (!UUID.test(sessionId ?? "") || !SOURCE_CONNECTION.test(sourceConnectionId ?? "")
      || !this.#ephemeral.verifySourceConnection({ sessionId, sourceConnectionId })) {
      fail("cast_source_not_paired", "Casting source connection is not paired", 403);
    }
    const session = await this.#session(sessionId);
    if (session.state === "streaming") return session;
    if (session.state !== "paired") fail("cast_stream_state_invalid", "Casting stream cannot start before pairing", 409);
    return this.#repository.transitionSession({ sessionId, expectedStateRevision: session.stateRevision,
      toState: "streaming", actorIdentityId: session.initiatorIdentityId, at: this.#clock() });
  }

  async #revokeMediaViewer({ session, viewerIdentityId, grantState, reasonCode }) {
    this.#ephemeral.revokeViewer({ sessionId: session.sessionId, viewerIdentityId });
    const [disconnected, ended] = await Promise.allSettled([
      this.#runtime.disconnectViewer({ sessionId: session.sessionId, viewerIdentityId, reasonCode }),
      this.#repository.endGrant({ sessionId: session.sessionId, viewerIdentityId, state: grantState,
        actorIdentityId: session.initiatorIdentityId, reasonCode, at: this.#clock() }),
    ]);
    if (disconnected.status === "rejected" || ended.status === "rejected") {
      await this.#auditSafe("security.cast_media_revocation_incomplete", session.initiatorIdentityId,
        session.sessionId, "failed", "cast_media_revocation_incomplete").catch(() => {});
      throw new PlatformError("cast_media_revocation_incomplete",
        "Casting viewer access was revoked but disconnect cleanup is incomplete", { status: 503, retryable: true });
    }
    await this.#auditSafe("security.cast_media_authorization_revoked", viewerIdentityId,
      session.sessionId, "succeeded", reasonCode);
    return ended.value;
  }

  async reconcileAuthorization(sessionId) {
    let session = await this.#session(sessionId);
    if (!active(session)) return session;
    const current = await this.#directory.authorization(session.initiatorIdentityId);
    if (!current?.permissions?.includes("cast:use")) {
      return this.#stop(session, session.initiatorIdentityId, "cast_use_revoked", true);
    }
    if (["selected_users", "selected_team"].includes(session.browserAudience)
      && !await this.#hasShareAuthority(current, {
        browserAudience: session.browserAudience,
        ...await this.#currentAudienceTargets(sessionId),
      })) {
      const viewers = await this.#repository.listJoinedViewers(sessionId, this.#clock());
      const result = await this.#repository.downgradeAudienceToOwner({ sessionId,
        initiatorIdentityId: session.initiatorIdentityId, expectedAudienceRevision: session.audienceRevision, at: this.#clock() });
      this.#ephemeral.revokeAllExcept({ sessionId, viewerIdentityId: session.initiatorIdentityId });
      await Promise.all(viewers.filter((item) => item.viewerIdentityId !== session.initiatorIdentityId)
        .map((item) => this.#runtime.disconnectViewer({ sessionId, viewerIdentityId: item.viewerIdentityId,
          reasonCode: "cast_share_revoked" })));
      await this.#auditSafe("security.cast_audience_downgraded", session.initiatorIdentityId, sessionId,
        "succeeded", "cast_share_revoked");
      session = result.session;
    }
    if (!current.permissions.includes("cast:view")) {
      return this.#stop(session, session.initiatorIdentityId, "cast_view_revoked", true);
    }
    return session;
  }

  async expireDue() {
    const now = this.#clock();
    const sessions = await this.#repository.expireDue(now);
    let expiredCount = 0;
    for (const session of sessions) {
      this.#ephemeral.destroySession(session.sessionId);
      const terminal = new Set(["pairing", "paired", "streaming"]).has(session.state) ? "expired" : "failed";
      const retry = { sessionId: session.sessionId, actorIdentityId: null, reasonCode: "cast_session_expired",
        force: false, terminalState: terminal,
        eventType: terminal === "expired" ? "session.expired" : "session.failed" };
      try {
        await this.#runtime.stopReceiver({ sessionId: session.sessionId, reasonCode: retry.reasonCode });
        await this.#repository.transitionSession({ sessionId: session.sessionId,
          expectedStateRevision: session.stateRevision, toState: terminal, actorIdentityId: null,
          reasonCode: retry.reasonCode, eventType: retry.eventType, at: now });
        this.#clearSessionTimer(session.sessionId);
        expiredCount += 1;
      } catch {
        this.#scheduleStopRetry(retry);
        await this.#auditSafe("security.cast_expiry_cleanup_pending", session.initiatorIdentityId,
          session.sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
      }
    }
    return Object.freeze({ expiredCount });
  }

  async reconcileStartup() {
    const session = await this.#repository.findActiveSession(this.#applianceNodeId);
    if (!session) return Object.freeze({ recovered: false });
    try {
      await this.#runtime.stopReceiver({ sessionId: session.sessionId, reasonCode: "cast_control_plane_restarted" });
    } catch (error) {
      await this.#auditSafe("security.cast_restart_cleanup_failed", session.initiatorIdentityId,
        session.sessionId, "failed", "cast_receiver_cleanup_failed");
      fail("cast_restart_cleanup_failed", "Casting receiver cleanup failed during startup", 503, true);
    }
    this.#ephemeral.destroySession(session.sessionId);
    await this.#repository.transitionSession({ sessionId: session.sessionId,
      expectedStateRevision: session.stateRevision, toState: "failed", actorIdentityId: null,
      reasonCode: "cast_control_plane_restarted", eventType: "session.failed", at: this.#clock() });
    await this.#auditSafe("security.cast_interrupted_session_closed", session.initiatorIdentityId,
      session.sessionId, "failed", "cast_control_plane_restarted");
    return Object.freeze({ recovered: true, sessionId: session.sessionId });
  }

  close() {
    for (const timer of this.#expiryTimers.values()) this.#clearTimeout(timer);
    this.#expiryTimers.clear();
    this.#ephemeral.close?.();
  }

  async #stop(initial, actorIdentityId, reasonCode, force, terminalState = "stopped") {
    let session = initial;
    if (TERMINAL.has(session.state)) return publicSession(session, { role: force ? "manager" : "owner" });
    if (!STOPPABLE.has(session.state)) fail("cast_state_conflict", "Casting session cannot be stopped", 409);
    if (session.state !== "stopping" && session.state !== "requested") {
      session = await this.#repository.transitionSession({ sessionId: session.sessionId,
        expectedStateRevision: session.stateRevision, toState: "stopping", actorIdentityId, at: this.#clock() });
    }
    this.#ephemeral.destroySession(session.sessionId);
    const retry = { sessionId: session.sessionId, actorIdentityId, reasonCode, force,
      terminalState, eventType: terminalState === "failed" ? "session.failed" : force ? "session.force_stopped" : "session.stopped" };
    try {
      await this.#runtime.stopReceiver({ sessionId: session.sessionId, reasonCode });
    } catch {
      this.#scheduleStopRetry(retry);
      await this.#auditSafe("security.cast_stop_cleanup_pending", actorIdentityId,
        session.sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
      throw new PlatformError("cast_receiver_stop_pending", "Casting receiver stop is pending a fail-closed retry", {
        status: 503, retryable: true,
      });
    }
    try {
      session = await this.#repository.transitionSession({ sessionId: session.sessionId,
        expectedStateRevision: session.stateRevision, toState: terminalState, actorIdentityId, reasonCode,
        eventType: retry.eventType, at: this.#clock() });
    } catch {
      const current = await this.#repository.getSession(session.sessionId).catch(() => null);
      if (!current || !TERMINAL.has(current.state)) {
        this.#scheduleStopRetry(retry);
        await this.#auditSafe("security.cast_stop_cleanup_pending", actorIdentityId,
          session.sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
        throw new PlatformError("cast_receiver_stop_pending", "Casting receiver stop is pending durable completion", {
          status: 503, retryable: true,
        });
      }
      session = current;
    }
    this.#clearSessionTimer(session.sessionId);
    await this.#auditSafe(terminalState === "failed" ? "security.cast_receiver_terminated"
      : force ? "security.cast_force_stopped" : "security.cast_stopped",
      actorIdentityId, session.sessionId, "succeeded", reasonCode);
    return publicSession(session, { role: force ? "manager" : "owner" });
  }

  async #view(context, identityId, session) {
    if (session.initiatorIdentityId === identityId) {
      requirePermission(context, "cast:use");
      return this.#ownerView(session);
    }
    if (permissions(context).has("cast:manage")) return this.health({ context, sessionId: session.sessionId });
    requirePermission(context, "cast:view");
    const authorization = await this.#directory.authorization(identityId);
    if (!await this.#repository.isIdentityInAudience({ sessionId: session.sessionId, identityId,
      teamIds: authorization?.teamMemberships?.map((item) => item.teamId) ?? [], now: this.#clock() })) {
      // The page can observe membership loss before the WSS recheck. Clear the
      // native grant before returning 404 and causing the page to close WSS;
      // socket cleanup alone removes media but does not end that grant.
      if (await this.#repository.getOpenGrant({ sessionId: session.sessionId, viewerIdentityId: identityId })) {
        await this.#revokeMediaViewer({ session, viewerIdentityId: identityId,
          grantState: "revoked", reasonCode: "cast_view_authorization_revoked" });
      }
      fail("cast_session_not_found", "Casting session was not found", 404);
    }
    const runtimeHealth = await this.#displayHealth(session);
    return publicSession(session, { role: "viewer", ...sourceStatus(runtimeHealth) });
  }

  async #ownerView(session) {
    const [targets, ephemeral, runtimeHealth] = await Promise.all([
      this.#repository.getAudienceTargets(session.sessionId),
      Promise.resolve(active(session) ? this.#ephemeral.describe(session.sessionId) : null),
      this.#displayHealth(session),
    ]);
    const current = runtimeHealth?.receiverState === "failed" ? await this.#session(session.sessionId) : session;
    return publicSession(current, { role: "owner", targets, ephemeral: active(current) ? ephemeral : null,
      outputHealth: safeHealth(runtimeHealth, current.outputSinks), ...sourceStatus(runtimeHealth) });
  }

  async #displayHealth(session) {
    if (!active(session)) return null;
    // Status is advisory, not a permission or cleanup gate. A media outage
    // must not hide an authorized session and its Stop control. Unknown is
    // never presented as healthy; start/join/stop keep their strict failures.
    let result;
    try { result = await this.#runtime.health({ sessionId: session.sessionId }); }
    catch { return null; }
    // Only an explicit, authenticated terminal report triggers cleanup. A
    // quiet sender, waiting output or transient TLS timeout is not a crash.
    if (result?.receiverState === "failed" && result.healthy === false) {
      const current = await this.#session(session.sessionId);
      if (active(current)) {
        await this.#stop(current, null, "cast_receiver_terminated", false, "failed").catch(() => {});
      }
    }
    return result;
  }

  async #session(sessionId) {
    if (!UUID.test(sessionId ?? "")) fail("cast_session_not_found", "Casting session was not found", 404);
    let session = await this.#repository.getSession(sessionId);
    if (!session) fail("cast_session_not_found", "Casting session was not found", 404);
    if (active(session) && session.expiresAt <= this.#clock()) {
      await this.expireDue();
      session = await this.#repository.getSession(sessionId);
    }
    return session;
  }

  #requireOwner(session, identityId, requireActive = true) {
    if (session.initiatorIdentityId !== identityId) fail("cast_session_not_found", "Casting session was not found", 404);
    if (requireActive && !active(session)) fail("cast_session_terminal", "Casting session is terminal", 409);
  }

  async #validateTargets(policy) {
    if (policy.browserAudience === "selected_users") {
      const values = await this.#directory.identities(policy.viewerUserIds);
      if (values.length !== policy.viewerUserIds.length || values.some((item) => item.status !== "active")) {
        fail("cast_audience_invalid", "Every casting user target must be an active local user");
      }
    }
    if (policy.browserAudience === "selected_team") {
      const team = await this.#directory.team(policy.viewerTeamId);
      if (!team || team.status !== "active") fail("cast_audience_invalid", "Casting team target must be active");
    }
  }

  async #assertOutputsAdmitted(outputSinks) {
    if (this.#admission === null) {
      throw new PlatformError("cast_capability_unavailable", "Wireless casting runtime admission is not configured", {
        status: 503,
        retryable: false,
        details: {
          state: "unsupported",
          receiverReady: false,
          startAllowed: false,
          gateCodes: ["casting_runtime_admission_not_configured"],
        },
      });
    }
    const requestedOutputs = Object.freeze([...outputSinks]);
    await this.#admission.assertSessionStartAllowed({
      outputSinks: requestedOutputs,
      mediaPrivacyPolicy: castingMediaPrivacyPolicyV1,
    });
    const status = await this.#admission.status();
    const blocked = status?.gates?.some?.((gate) => gate?.state === "blocked") === true;
    const unavailableOutputs = requestedOutputs.filter((sink) => status?.outputs?.[sink]?.state !== "available");
    const unavailable = unavailableOutputs.length > 0;
    if (status?.mode !== "runtime" || status?.state !== "ready" || status?.receiverReady !== true
      || status?.sessionStartAllowed !== true || status?.receiverAdvertisementAllowed !== true
      || blocked || unavailable) {
      const gateCodes = Array.isArray(status?.gates)
        ? status.gates.filter((gate) => gate?.state === "blocked" && typeof gate?.code === "string")
          .map((gate) => gate.code)
        : [];
      for (const sink of unavailableOutputs) {
        const reasonCode = status?.outputs?.[sink]?.reasonCode;
        if (typeof reasonCode === "string" && REASON.test(reasonCode) && !gateCodes.includes(reasonCode)) {
          gateCodes.push(reasonCode);
        }
      }
      if (gateCodes.length === 0) gateCodes.push("casting_runtime_admission_invalid");
      throw new PlatformError("cast_capability_unavailable", "Wireless casting runtime admission is not ready", {
        status: 503,
        retryable: false,
        details: {
          state: typeof status?.state === "string" ? status.state : "unknown",
          receiverReady: status?.receiverReady === true,
          startAllowed: false,
          gateCodes,
        },
      });
    }
  }

  async #currentAudienceTargets(sessionId) {
    const targets = await this.#repository.getAudienceTargets(sessionId);
    return {
      viewerUserIds: targets.filter((item) => item.targetKind === "user").map((item) => item.targetIdentityId),
      viewerTeamId: targets.find((item) => item.targetKind === "team")?.targetTeamId ?? null,
    };
  }

  async #hasShareAuthority(context, policy) {
    if (permissions(context).has("cast:share")) return true;
    const managedTeamIds = (context?.teamMemberships ?? [])
      .filter((item) => item.roleKey === "team_admin" || item.roleKey === "manager")
      .map((item) => item.teamId);
    if (policy.browserAudience === "selected_team") return managedTeamIds.includes(policy.viewerTeamId);
    if (policy.browserAudience !== "selected_users" || managedTeamIds.length === 0) return false;
    const managedTeams = (await Promise.all(managedTeamIds.map((teamId) => this.#directory.team(teamId)))).filter(Boolean);
    const memberIds = new Set(managedTeams.flatMap((team) => team.memberIdentityIds));
    return policy.viewerUserIds.length > 0 && policy.viewerUserIds.every((identityId) => memberIds.has(identityId));
  }

  async #requireShareAuthority(context, policy) {
    actor(context);
    if (!await this.#hasShareAuthority(context, policy)) {
      fail("cast_permission_required", "Missing permission: cast:share", 403);
    }
  }

  #targets(policy, identityId, now) {
    return policy.browserAudience === "selected_users"
      ? policy.viewerUserIds.map((targetIdentityId) => ({ targetId: this.#idFactory(), targetKind: "user",
        targetIdentityId, targetTeamId: null, createdByIdentityId: identityId, createdAt: now }))
      : policy.browserAudience === "selected_team"
        ? [{ targetId: this.#idFactory(), targetKind: "team", targetIdentityId: null,
          targetTeamId: policy.viewerTeamId, createdByIdentityId: identityId, createdAt: now }]
        : [];
  }

  #invitation({ sessionId, inviteeIdentityId, initiatorIdentityId, audienceRevision, now, sessionExpiresAt }) {
    return { invitationId: this.#idFactory(), sessionId, audienceRevision, inviteeIdentityId,
      invitedByIdentityId: initiatorIdentityId, issuedAt: now,
      expiresAt: new Date(Math.min(date(sessionExpiresAt).getTime(), now.getTime() + 15 * 60_000)) };
  }

  #publicInvitation(value) {
    return Object.freeze({ id: value.invitationId, object: "cast.viewer_invitation", sessionId: value.sessionId,
      state: value.state, audienceRevision: value.audienceRevision, issuedAt: iso(value.issuedAt),
      expiresAt: iso(value.expiresAt), resolvedAt: iso(value.resolvedAt) });
  }

  #enforceStartRate(identityId, now) {
    const threshold = now.getTime() - this.#startWindowMilliseconds;
    const starts = (this.#starts.get(identityId) ?? []).filter((value) => value > threshold);
    if (starts.length >= this.#maximumStartsPerWindow) fail("cast_start_rate_limited", "Casting start rate limit exceeded", 429, true);
    starts.push(now.getTime()); this.#starts.set(identityId, starts);
  }

  async #auditSafe(action, actorIdentityId, sessionId, outcome = "succeeded", reasonCode = null) {
    await this.#audit({ action, domain: "security", actorIdentityId, outcome,
      resourceKind: "cast_session", resourceId: sessionId, reasonCode,
      occurredAt: this.#clock().toISOString() });
  }

  #scheduleExpiry(sessionId, expiresAt, now) {
    this.#clearSessionTimer(sessionId);
    let timeout;
    timeout = this.#setTimeout(() => {
      if (this.#expiryTimers.get(sessionId) === timeout) this.#expiryTimers.delete(sessionId);
      void this.#runExpiryTimer(sessionId, 1);
    }, Math.max(1, date(expiresAt).getTime() - date(now).getTime()));
    timeout.unref?.();
    this.#expiryTimers.set(sessionId, timeout);
  }

  #clearSessionTimer(sessionId) {
    const timer = this.#expiryTimers.get(sessionId);
    if (timer) this.#clearTimeout(timer);
    this.#expiryTimers.delete(sessionId);
  }

  #scheduleExpiryRetry(sessionId, attempt) {
    this.#clearSessionTimer(sessionId);
    const delay = Math.min(30_000, this.#stopRetryMilliseconds * (2 ** Math.min(5, attempt - 1)));
    let timeout;
    timeout = this.#setTimeout(() => {
      if (this.#expiryTimers.get(sessionId) === timeout) this.#expiryTimers.delete(sessionId);
      void this.#runExpiryTimer(sessionId, attempt + 1);
    }, delay);
    timeout.unref?.();
    this.#expiryTimers.set(sessionId, timeout);
  }

  async #runExpiryTimer(sessionId, attempt) {
    try {
      await this.expireDue();
    } catch {
      this.#scheduleExpiryRetry(sessionId, attempt);
      await this.#auditSafe("security.cast_expiry_retry_scheduled", null,
        sessionId, "failed", "cast_expiry_repository_unavailable").catch(() => {});
      return;
    }
    if (this.#expiryTimers.has(sessionId)) return;
    let session;
    try { session = await this.#repository.getSession(sessionId); } catch {
      this.#scheduleExpiryRetry(sessionId, attempt);
      return;
    }
    if (active(session)) {
      const now = this.#clock();
      if (date(session.expiresAt) <= now) this.#scheduleExpiryRetry(sessionId, attempt);
      else this.#scheduleExpiry(sessionId, session.expiresAt, now);
    }
  }

  #scheduleStopRetry(retry, attempt = 1) {
    this.#clearSessionTimer(retry.sessionId);
    const delay = Math.min(30_000, this.#stopRetryMilliseconds * (2 ** Math.min(5, attempt - 1)));
    const timeout = this.#setTimeout(() => {
      void this.#retryStop(retry, attempt).catch(() => this.#scheduleStopRetry(retry, attempt + 1));
    }, delay);
    timeout.unref?.();
    this.#expiryTimers.set(retry.sessionId, timeout);
  }

  async #retryStop(retry, attempt) {
    let session;
    try { session = await this.#repository.getSession(retry.sessionId); } catch {
      this.#scheduleStopRetry(retry, attempt + 1);
      return;
    }
    if (!active(session)) {
      this.#clearSessionTimer(retry.sessionId);
      return;
    }
    this.#ephemeral.destroySession(retry.sessionId);
    try {
      await this.#runtime.stopReceiver({ sessionId: retry.sessionId, reasonCode: retry.reasonCode });
    } catch {
      this.#scheduleStopRetry(retry, attempt + 1);
      await this.#auditSafe("security.cast_stop_retry_failed", retry.actorIdentityId,
        retry.sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
      return;
    }
    try {
      await this.#repository.transitionSession({ sessionId: retry.sessionId,
        expectedStateRevision: session.stateRevision, toState: retry.terminalState,
        actorIdentityId: retry.actorIdentityId, reasonCode: retry.reasonCode,
        eventType: retry.eventType, at: this.#clock() });
    } catch {
      const current = await this.#repository.getSession(retry.sessionId).catch(() => null);
      if (!current || !TERMINAL.has(current.state)) {
        this.#scheduleStopRetry(retry, attempt + 1);
        await this.#auditSafe("security.cast_stop_retry_failed", retry.actorIdentityId,
          retry.sessionId, "failed", "cast_receiver_stop_pending").catch(() => {});
        return;
      }
    }
    this.#clearSessionTimer(retry.sessionId);
    await this.#auditSafe(retry.successAuditAction
        ?? (retry.force ? "security.cast_force_stopped" : "security.cast_stopped"),
      retry.actorIdentityId, retry.sessionId, "succeeded", retry.reasonCode).catch(() => {});
  }
}
