import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const ACTIVE_STATES = new Set(["requested", "starting", "pairing", "paired", "streaming", "stopping"]);
const VIEWABLE_STATES = new Set(["requested", "starting", "pairing", "paired", "streaming"]);
const TRANSITIONS = Object.freeze({
  requested: new Set(["starting", "stopped", "failed"]),
  starting: new Set(["pairing", "stopping", "stopped", "failed"]),
  pairing: new Set(["paired", "streaming", "stopping", "stopped", "expired", "failed"]),
  paired: new Set(["streaming", "stopping", "stopped", "expired", "failed"]),
  streaming: new Set(["stopping", "stopped", "expired", "failed"]),
  stopping: new Set(["stopped", "failed"]),
});

function copy(value) { return value == null ? value : structuredClone(value); }
function conflict(code, message) { throw new PlatformError(code, message, { status: 409 }); }
function notFound() { throw new PlatformError("cast_session_not_found", "Casting session was not found", { status: 404 }); }
function invitationNotFound() { throw new PlatformError("cast_invitation_not_found", "Casting invitation was not found", { status: 404 }); }

function activeViewerCount(grants, sessionId, now) {
  return [...grants.values()].filter((grant) => grant.sessionId === sessionId
    && grant.state === "joined" && grant.expiresAt > now).length;
}

/** In-memory contract-compatible implementation used by isolated Platform tests. */
export class MemoryCastingRepository {
  #sessions = new Map();
  #targets = new Map();
  #invitations = new Map();
  #grants = new Map();
  #events = [];

  async createSession({ session, targets = [], invitations = [] }) {
    const present = [...this.#sessions.values()].find((item) => item.applianceNodeId === session.applianceNodeId
      && ACTIVE_STATES.has(item.state));
    if (present) conflict("cast_session_busy", "This appliance already has an active casting session");
    this.#sessions.set(session.sessionId, copy({
      ...session, state: "requested", stateRevision: 1, audienceRevision: 1,
      pairingFailedAttempts: 0, pairingBlockedUntil: null, pairedAt: null,
      startedAt: null, terminalAt: null, terminalReasonCode: null,
    }));
    this.#targets.set(session.sessionId, targets.map((target) => copy({
      ...target, sessionId: session.sessionId, audienceRevision: 1, state: "active", revision: 1,
    })));
    for (const invitation of invitations) this.#invitations.set(invitation.invitationId, copy({
      ...invitation, sessionId: session.sessionId, audienceRevision: 1, state: "pending", revision: 1,
      resolvedAt: null, reasonCode: null,
    }));
    this.#event(this.#sessions.get(session.sessionId), {
      eventType: "session.created", actorIdentityId: session.initiatorIdentityId, at: session.createdAt,
    });
    for (const invitation of invitations) this.#event(this.#sessions.get(session.sessionId), {
      eventType: "invitation.created", actorIdentityId: session.initiatorIdentityId, at: invitation.issuedAt,
    });
    return copy(this.#sessions.get(session.sessionId));
  }

  async getSession(sessionId) { return copy(this.#sessions.get(sessionId) ?? null); }

  async findActiveSession(applianceNodeId) {
    return copy([...this.#sessions.values()].find((item) => item.applianceNodeId === applianceNodeId
      && ACTIVE_STATES.has(item.state)) ?? null);
  }

  async getAudienceTargets(sessionId) {
    return copy((this.#targets.get(sessionId) ?? []).filter((target) => target.state === "active"));
  }

  async transitionSession({ sessionId, expectedStateRevision, toState, actorIdentityId = null,
    reasonCode = null, eventType = "session.state_changed", at }) {
    const session = this.#sessions.get(sessionId);
    if (!session) notFound();
    if (session.stateRevision !== expectedStateRevision || !TRANSITIONS[session.state]?.has(toState)) {
      conflict("cast_state_conflict", "Casting session state changed concurrently or transition is invalid");
    }
    session.state = toState;
    session.stateRevision += 1;
    session.updatedAt = new Date(at);
    if ((toState === "paired" || toState === "streaming") && session.pairedAt === null) session.pairedAt = new Date(at);
    if (toState === "streaming" && session.startedAt === null) session.startedAt = new Date(at);
    if (["stopped", "expired", "failed"].includes(toState)) {
      if (!reasonCode) throw new TypeError("terminal casting reason is required");
      session.terminalAt = new Date(at);
      session.terminalReasonCode = reasonCode;
      for (const invitation of this.#invitations.values()) {
        if (invitation.sessionId === sessionId && invitation.state === "pending") {
          invitation.state = "revoked"; invitation.revision += 1;
          invitation.resolvedAt = new Date(at); invitation.reasonCode = reasonCode;
        }
      }
      for (const grant of this.#grants.values()) {
        if (grant.sessionId === sessionId && ["issued", "joined"].includes(grant.state)) {
          grant.state = "revoked"; grant.revision += 1;
          grant.endedAt = new Date(at); grant.reasonCode = reasonCode;
        }
      }
    }
    this.#event(session, { eventType, actorIdentityId, reasonCode, at });
    return copy(session);
  }

  async recordPairingFailure({ sessionId, attempts, blockedUntil, actorIdentityId = null, at }) {
    const session = this.#sessions.get(sessionId);
    if (!session) notFound();
    if (!ACTIVE_STATES.has(session.state) || attempts < session.pairingFailedAttempts) {
      conflict("cast_pairing_state_conflict", "Casting pairing state is stale");
    }
    session.pairingFailedAttempts = attempts;
    session.pairingBlockedUntil = blockedUntil ? new Date(blockedUntil) : session.pairingBlockedUntil;
    session.updatedAt = new Date(at);
    if (blockedUntil) this.#event(session, {
      eventType: "authorization.denied", actorIdentityId, outcome: "denied", reasonCode: "cast_pairing_rate_limited", at,
    });
    return copy(session);
  }

  async replaceAudience({ sessionId, expectedAudienceRevision, outputSinks, browserAudience,
    targets = [], invitations = [], actorIdentityId, at }) {
    const session = this.#sessions.get(sessionId);
    if (!session) notFound();
    if (!ACTIVE_STATES.has(session.state) || session.audienceRevision !== expectedAudienceRevision) {
      conflict("cast_audience_conflict", "Casting audience changed concurrently");
    }
    const key = (item) => `${item.targetKind}:${item.targetIdentityId ?? item.targetTeamId}`;
    const currentTargets = (this.#targets.get(sessionId) ?? []).filter((item) => item.state === "active");
    if (JSON.stringify(session.outputSinks) === JSON.stringify(outputSinks)
      && session.browserAudience === browserAudience
      && currentTargets.map(key).sort().join("|") === targets.map(key).sort().join("|")) return copy(session);
    this.#revokeAudienceFacts(sessionId, actorIdentityId, "cast_audience_changed", at, false);
    session.outputSinks = [...outputSinks];
    session.browserAudience = browserAudience;
    session.audienceRevision += 1;
    session.updatedAt = new Date(at);
    this.#targets.set(sessionId, [
      ...(this.#targets.get(sessionId) ?? []),
      ...targets.map((target) => copy({ ...target, sessionId, audienceRevision: session.audienceRevision,
        state: "active", revision: 1 })),
    ]);
    for (const invitation of invitations) this.#invitations.set(invitation.invitationId, copy({
      ...invitation, sessionId, audienceRevision: session.audienceRevision, state: "pending", revision: 1,
      resolvedAt: null, reasonCode: null,
    }));
    this.#event(session, { eventType: "audience.changed", actorIdentityId, at });
    for (const invitation of invitations) this.#event(session, {
      eventType: "invitation.created", actorIdentityId, at: invitation.issuedAt,
    });
    return copy(session);
  }

  async downgradeAudienceToOwner({ sessionId, initiatorIdentityId, expectedAudienceRevision, at }) {
    const session = this.#sessions.get(sessionId);
    if (!session) notFound();
    if (session.initiatorIdentityId !== initiatorIdentityId || session.audienceRevision !== expectedAudienceRevision
      || !ACTIVE_STATES.has(session.state) || !session.outputSinks.includes("browser")) {
      conflict("cast_audience_conflict", "Casting audience downgrade generation is stale");
    }
    if (session.browserAudience === "owner_only") return { session: copy(session), revokedViewerIdentityIds: [] };
    const revokedViewerIdentityIds = this.#revokeAudienceFacts(sessionId, initiatorIdentityId, "cast_share_revoked", at, true);
    session.browserAudience = "owner_only";
    session.audienceRevision += 1;
    session.updatedAt = new Date(at);
    this.#event(session, { eventType: "audience.downgraded", actorIdentityId: initiatorIdentityId,
      reasonCode: "cast_share_revoked", at });
    return { session: copy(session), revokedViewerIdentityIds };
  }

  async createInvitation(value) {
    const session = this.#sessions.get(value.sessionId);
    if (!session) notFound();
    if (session.audienceRevision !== value.audienceRevision || !ACTIVE_STATES.has(session.state)) {
      conflict("cast_audience_conflict", "Casting invitation audience is stale");
    }
    const duplicate = [...this.#invitations.values()].find((item) => item.sessionId === value.sessionId
      && item.inviteeIdentityId === value.inviteeIdentityId && item.state === "pending");
    if (duplicate) return copy(duplicate);
    const invitation = { ...copy(value), state: "pending", revision: 1, resolvedAt: null, reasonCode: null };
    this.#invitations.set(value.invitationId, invitation);
    this.#event(session, { eventType: "invitation.created", actorIdentityId: value.invitedByIdentityId, at: value.issuedAt });
    return copy(invitation);
  }

  async getInvitation(invitationId) { return copy(this.#invitations.get(invitationId) ?? null); }

  async listInvitationsForIdentity(identityId, now) {
    return copy([...this.#invitations.values()].filter((item) => item.inviteeIdentityId === identityId
      && item.state === "pending" && item.expiresAt > now).sort((a, b) => b.issuedAt - a.issuedAt));
  }

  async resolveInvitation({ invitationId, inviteeIdentityId, state, reasonCode = null, at }) {
    const invitation = this.#invitations.get(invitationId);
    if (!invitation || invitation.inviteeIdentityId !== inviteeIdentityId) invitationNotFound();
    if (invitation.state !== "pending") conflict("cast_invitation_resolved", "Casting invitation is already resolved");
    if (state === "accepted" && invitation.expiresAt <= at) conflict("cast_invitation_expired", "Casting invitation has expired");
    invitation.state = state;
    invitation.revision += 1;
    invitation.resolvedAt = new Date(at);
    invitation.reasonCode = reasonCode;
    this.#event(this.#sessions.get(invitation.sessionId), {
      eventType: "invitation.resolved", actorIdentityId: inviteeIdentityId,
      reasonCode: state === "accepted" || state === "declined" ? null : reasonCode, at,
    });
    return copy(invitation);
  }

  async isIdentityInAudience({ sessionId, identityId, teamIds = [], now }) {
    const session = this.#sessions.get(sessionId);
    if (!session || !VIEWABLE_STATES.has(session.state) || session.expiresAt <= now
      || !session.outputSinks.includes("browser")) return false;
    if (session.initiatorIdentityId === identityId) return true;
    const targets = (this.#targets.get(sessionId) ?? []).filter((target) => target.state === "active"
      && target.audienceRevision === session.audienceRevision);
    return session.browserAudience === "selected_users"
      ? targets.some((target) => target.targetKind === "user" && target.targetIdentityId === identityId)
      : session.browserAudience === "selected_team"
        && targets.some((target) => target.targetKind === "team" && teamIds.includes(target.targetTeamId));
  }

  async createGrant(value) {
    const session = this.#sessions.get(value.sessionId);
    if (!session) notFound();
    const open = [...this.#grants.values()].find((item) => item.sessionId === value.sessionId
      && item.viewerIdentityId === value.viewerIdentityId && ["issued", "joined"].includes(item.state));
    if (open) return copy(open);
    const grant = { ...copy(value), state: "issued", revision: 1, joinedAt: null, endedAt: null, reasonCode: null };
    this.#grants.set(value.grantId, grant);
    return copy(grant);
  }

  async getOpenGrant({ sessionId, viewerIdentityId }) {
    return copy([...this.#grants.values()].find((item) => item.sessionId === sessionId
      && item.viewerIdentityId === viewerIdentityId && ["issued", "joined"].includes(item.state)) ?? null);
  }

  async joinGrant({ grantId, expectedRevision, at }) {
    const grant = this.#grants.get(grantId);
    if (!grant || grant.state !== "issued" || grant.revision !== expectedRevision || grant.expiresAt <= at) {
      conflict("cast_viewer_grant_conflict", "Casting viewer grant is stale or expired");
    }
    grant.state = "joined"; grant.revision += 1; grant.joinedAt = new Date(at);
    this.#event(this.#sessions.get(grant.sessionId), {
      eventType: "viewer.joined", actorIdentityId: grant.viewerIdentityId, at,
    });
    return copy(grant);
  }

  async endGrant({ sessionId, viewerIdentityId, state, actorIdentityId, reasonCode, at }) {
    const grant = [...this.#grants.values()].find((item) => item.sessionId === sessionId
      && item.viewerIdentityId === viewerIdentityId && ["issued", "joined"].includes(item.state));
    if (!grant) return null;
    grant.state = state; grant.revision += 1; grant.endedAt = new Date(at); grant.reasonCode = reasonCode;
    this.#event(this.#sessions.get(sessionId), { eventType: state === "left" ? "viewer.left" : "viewer.revoked",
      actorIdentityId, reasonCode, at });
    return copy(grant);
  }

  async listJoinedViewers(sessionId, now) {
    return copy([...this.#grants.values()].filter((item) => item.sessionId === sessionId
      && item.state === "joined" && item.expiresAt > now));
  }

  async expireDue(now) {
    const expired = [];
    for (const session of this.#sessions.values()) {
      if (ACTIVE_STATES.has(session.state) && session.expiresAt <= now) expired.push(copy(session));
    }
    for (const invitation of this.#invitations.values()) {
      if (invitation.state === "pending" && invitation.expiresAt <= now) {
        invitation.state = "expired"; invitation.revision += 1; invitation.resolvedAt = new Date(now);
        invitation.reasonCode = "cast_invitation_expired";
      }
    }
    for (const grant of this.#grants.values()) {
      if (["issued", "joined"].includes(grant.state) && grant.expiresAt <= now) {
        grant.state = "expired"; grant.revision += 1; grant.endedAt = new Date(now); grant.reasonCode = "cast_viewer_grant_expired";
      }
    }
    return expired;
  }

  async listEvents(sessionId) { return copy(this.#events.filter((event) => event.sessionId === sessionId)); }

  #revokeAudienceFacts(sessionId, actorIdentityId, reasonCode, at, preserveInitiator) {
    const session = this.#sessions.get(sessionId);
    for (const target of this.#targets.get(sessionId) ?? []) if (target.state === "active") {
      target.state = "revoked"; target.revision += 1; target.revokedAt = new Date(at);
      target.revokedByIdentityId = actorIdentityId; target.reasonCode = reasonCode;
    }
    for (const invitation of this.#invitations.values()) if (invitation.sessionId === sessionId
      && invitation.state === "pending" && (!preserveInitiator || invitation.inviteeIdentityId !== session.initiatorIdentityId)) {
      invitation.state = "revoked"; invitation.revision += 1; invitation.resolvedAt = new Date(at); invitation.reasonCode = reasonCode;
    }
    const revoked = [];
    for (const grant of this.#grants.values()) if (grant.sessionId === sessionId
      && ["issued", "joined"].includes(grant.state) && (!preserveInitiator || grant.viewerIdentityId !== session.initiatorIdentityId)) {
      grant.state = "revoked"; grant.revision += 1; grant.endedAt = new Date(at); grant.reasonCode = reasonCode;
      revoked.push(grant.viewerIdentityId);
    }
    return [...new Set(revoked)];
  }

  #event(session, { eventType, actorIdentityId = null, outcome = "succeeded", reasonCode = null, at }) {
    if (!session) return;
    this.#events.push({ sequence: this.#events.length + 1, sessionId: session.sessionId, actorIdentityId,
      eventType, outcome, stateRevision: session.stateRevision, audienceRevision: session.audienceRevision,
      sessionState: session.state, browserAudience: session.browserAudience,
      activeViewerCount: activeViewerCount(this.#grants, session.sessionId, new Date(at)), reasonCode,
      occurredAt: new Date(at) });
  }
}
