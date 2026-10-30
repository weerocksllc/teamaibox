import { PlatformError } from "../../../../packages/observability/src/index.mjs";

function rows(result) {
  if (!result || !Array.isArray(result.rows)) throw new TypeError("PostgreSQL casting result is invalid");
  return result.rows;
}
function date(value) { return value == null ? null : new Date(value); }
function session(row) {
  return row ? {
    sessionId: row.id, applianceNodeId: row.appliance_node_id,
    initiatorIdentityId: row.initiator_identity_id, state: row.session_state,
    stateRevision: Number(row.state_revision), outputSinks: [...row.output_sinks],
    browserAudience: row.browser_audience, audienceRevision: Number(row.audience_revision),
    pairingFailedAttempts: Number(row.pairing_failed_attempts), pairingBlockedUntil: date(row.pairing_blocked_until),
    pairedAt: date(row.paired_at), startedAt: date(row.started_at), terminalAt: date(row.terminal_at),
    terminalReasonCode: row.terminal_reason_code, createdAt: date(row.created_at),
    updatedAt: date(row.updated_at), expiresAt: date(row.expires_at),
  } : null;
}
function target(row) {
  return row ? { targetId: row.id, sessionId: row.session_id, audienceRevision: Number(row.audience_revision),
    targetKind: row.target_kind, targetIdentityId: row.target_identity_id, targetTeamId: row.target_team_id,
    state: row.target_state, revision: Number(row.revision), createdByIdentityId: row.created_by_identity_id,
    createdAt: date(row.created_at), revokedAt: date(row.revoked_at), reasonCode: row.revoke_reason_code } : null;
}
function invitation(row) {
  return row ? { invitationId: row.id, sessionId: row.session_id, audienceRevision: Number(row.audience_revision),
    inviteeIdentityId: row.invitee_identity_id, invitedByIdentityId: row.invited_by_identity_id,
    state: row.invitation_state, revision: Number(row.revision), issuedAt: date(row.issued_at),
    expiresAt: date(row.expires_at), resolvedAt: date(row.resolved_at), reasonCode: row.resolution_reason_code } : null;
}
function grant(row) {
  return row ? { grantId: row.id, sessionId: row.session_id, audienceRevision: Number(row.audience_revision),
    viewerIdentityId: row.viewer_identity_id, invitationId: row.invitation_id,
    issuedByIdentityId: row.issued_by_identity_id, state: row.grant_state, revision: Number(row.revision),
    issuedAt: date(row.issued_at), expiresAt: date(row.expires_at), joinedAt: date(row.joined_at),
    endedAt: date(row.ended_at), reasonCode: row.terminal_reason_code } : null;
}
function fail(code, message, status = 409) { throw new PlatformError(code, message, { status }); }

async function appendEvent(executor, value) {
  await executor.query(`INSERT INTO platform.cast_session_events (
    session_id, actor_identity_id, event_type, outcome, state_revision,
    audience_revision, session_state, browser_audience, active_viewer_count,
    reason_code, occurred_at
  ) SELECT session.id,$2,$3,$4,session.state_revision,session.audience_revision,
      session.session_state,session.browser_audience,count(grant_row.id)::integer,$5,$6
    FROM platform.cast_sessions session
    LEFT JOIN platform.cast_viewer_grants grant_row ON grant_row.session_id=session.id
      AND grant_row.grant_state='joined' AND grant_row.expires_at>$6
    WHERE session.id=$1 GROUP BY session.id`, [value.sessionId, value.actorIdentityId ?? null,
    value.eventType, value.outcome ?? "succeeded", value.reasonCode ?? null, value.at]);
}

async function getSession(executor, sessionId, lock = false) {
  return session(rows(await executor.query(`SELECT * FROM platform.cast_sessions WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [sessionId]))[0]);
}

async function revokeAudienceFacts(executor, { sessionId, actorIdentityId, reasonCode, at }) {
  await executor.query(`UPDATE platform.cast_audience_targets SET target_state='revoked',revision=revision+1,
    revoked_at=$3,revoked_by_identity_id=$2,revoke_reason_code=$4
    WHERE session_id=$1 AND target_state='active'`, [sessionId, actorIdentityId, at, reasonCode]);
  await executor.query(`UPDATE platform.cast_viewer_invitations SET invitation_state='revoked',revision=revision+1,
    resolved_at=$2,resolution_reason_code=$3 WHERE session_id=$1 AND invitation_state='pending'`,
  [sessionId, at, reasonCode]);
  await executor.query(`UPDATE platform.cast_viewer_grants SET grant_state='revoked',revision=revision+1,
    ended_at=$2,terminal_reason_code=$3 WHERE session_id=$1 AND grant_state IN ('issued','joined')`,
  [sessionId, at, reasonCode]);
}

async function insertTarget(executor, sessionId, audienceRevision, value) {
  await executor.query(`INSERT INTO platform.cast_audience_targets (
    id,session_id,audience_revision,target_kind,target_identity_id,target_team_id,
    created_by_identity_id,created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [value.targetId, sessionId, audienceRevision,
    value.targetKind, value.targetIdentityId, value.targetTeamId, value.createdByIdentityId, value.createdAt]);
}

async function insertInvitation(executor, sessionId, audienceRevision, value) {
  return invitation(rows(await executor.query(`INSERT INTO platform.cast_viewer_invitations (
    id,session_id,audience_revision,invitee_identity_id,invited_by_identity_id,issued_at,expires_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [value.invitationId, sessionId, audienceRevision,
    value.inviteeIdentityId, value.invitedByIdentityId, value.issuedAt, value.expiresAt]))[0]);
}

/** PostgreSQL repository for durable, secret-free casting control-plane facts. */
export class PostgresCastingRepository {
  #database;
  constructor({ database }) {
    if (!database?.query || !database?.transaction) throw new TypeError("PostgreSQL casting repository requires query and transaction");
    this.#database = database;
  }

  async createSession({ session: value, targets = [], invitations = [] }) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const created = session(rows(await transaction.query(`INSERT INTO platform.cast_sessions (
          id,appliance_node_id,initiator_identity_id,output_sinks,browser_audience,
          created_at,updated_at,expires_at
        ) VALUES ($1,$2,$3,$4::text[],$5,$6,$6,$7) RETURNING *`, [value.sessionId,
          value.applianceNodeId, value.initiatorIdentityId, value.outputSinks,
          value.browserAudience, value.createdAt, value.expiresAt]))[0]);
        for (const item of targets) await insertTarget(transaction, value.sessionId, 1, item);
        for (const item of invitations) await insertInvitation(transaction, value.sessionId, 1, item);
        await appendEvent(transaction, { sessionId: value.sessionId, actorIdentityId: value.initiatorIdentityId,
          eventType: "session.created", at: value.createdAt });
        for (const item of invitations) await appendEvent(transaction, { sessionId: value.sessionId,
          actorIdentityId: value.initiatorIdentityId, eventType: "invitation.created", at: item.issuedAt });
        return created;
      });
    } catch (error) {
      if (error?.code === "23505") fail("cast_session_busy", "This appliance already has an active casting session");
      throw error;
    }
  }

  async getSession(sessionId) { return getSession(this.#database, sessionId); }

  async findActiveSession(applianceNodeId) {
    return session(rows(await this.#database.query(`SELECT * FROM platform.cast_sessions
      WHERE appliance_node_id=$1 AND session_state IN ('requested','starting','pairing','paired','streaming','stopping')
      ORDER BY created_at DESC,id DESC LIMIT 1`, [applianceNodeId]))[0]);
  }

  async getAudienceTargets(sessionId) {
    return rows(await this.#database.query(`SELECT * FROM platform.cast_audience_targets
      WHERE session_id=$1 AND target_state='active' ORDER BY target_kind,id`, [sessionId])).map(target);
  }

  async transitionSession({ sessionId, expectedStateRevision, toState, actorIdentityId = null,
    reasonCode = null, eventType = "session.state_changed", at }) {
    return this.#database.transaction(async (transaction) => {
      const updated = session(rows(await transaction.query(`UPDATE platform.cast_sessions SET
        session_state=$3,state_revision=state_revision+1,
        paired_at=CASE WHEN $3 IN ('paired','streaming') THEN COALESCE(paired_at,$5) ELSE paired_at END,
        started_at=CASE WHEN $3='streaming' THEN COALESCE(started_at,$5) ELSE started_at END,
        terminal_at=CASE WHEN $3 IN ('stopped','expired','failed') THEN $5 ELSE terminal_at END,
        terminal_reason_code=CASE WHEN $3 IN ('stopped','expired','failed') THEN $4 ELSE terminal_reason_code END
        WHERE id=$1 AND state_revision=$2 RETURNING *`, [sessionId, expectedStateRevision, toState,
        reasonCode, at]))[0]);
      if (!updated) {
        if (await getSession(transaction, sessionId)) fail("cast_state_conflict", "Casting state changed concurrently");
        fail("cast_session_not_found", "Casting session was not found", 404);
      }
      if (["stopped", "expired", "failed"].includes(toState)) {
        await transaction.query(`UPDATE platform.cast_viewer_invitations SET invitation_state='revoked',
          revision=revision+1,resolved_at=$2,resolution_reason_code=$3
          WHERE session_id=$1 AND invitation_state='pending'`, [sessionId, at, reasonCode]);
        await transaction.query(`UPDATE platform.cast_viewer_grants SET grant_state='revoked',
          revision=revision+1,ended_at=$2,terminal_reason_code=$3
          WHERE session_id=$1 AND grant_state IN ('issued','joined')`, [sessionId, at, reasonCode]);
      }
      await appendEvent(transaction, { sessionId, actorIdentityId, eventType, reasonCode, at });
      return updated;
    });
  }

  async recordPairingFailure({ sessionId, attempts, blockedUntil, actorIdentityId = null, at }) {
    return this.#database.transaction(async (transaction) => {
      const updated = session(rows(await transaction.query(`UPDATE platform.cast_sessions SET
        pairing_failed_attempts=$2,pairing_blocked_until=CASE WHEN $3::timestamptz IS NULL
          THEN pairing_blocked_until ELSE $3 END
        WHERE id=$1 AND session_state IN ('requested','starting','pairing','paired','streaming','stopping')
          AND pairing_failed_attempts<=$2 RETURNING *`, [sessionId, attempts, blockedUntil]))[0]);
      if (!updated) fail("cast_pairing_state_conflict", "Casting pairing state is stale");
      if (blockedUntil) await appendEvent(transaction, { sessionId, actorIdentityId,
        eventType: "authorization.denied", outcome: "denied", reasonCode: "cast_pairing_rate_limited", at });
      return updated;
    });
  }

  async replaceAudience({ sessionId, expectedAudienceRevision, outputSinks, browserAudience,
    targets = [], invitations = [], actorIdentityId, at }) {
    return this.#database.transaction(async (transaction) => {
      const current = await getSession(transaction, sessionId, true);
      if (!current) fail("cast_session_not_found", "Casting session was not found", 404);
      if (current.audienceRevision !== expectedAudienceRevision) fail("cast_audience_conflict", "Casting audience changed concurrently");
      const currentTargets = rows(await transaction.query(`SELECT target_kind,target_identity_id,target_team_id
        FROM platform.cast_audience_targets WHERE session_id=$1 AND target_state='active' ORDER BY target_kind,target_identity_id,target_team_id`,
      [sessionId]));
      const key = (item) => `${item.targetKind ?? item.target_kind}:${item.targetIdentityId ?? item.target_identity_id ?? item.targetTeamId ?? item.target_team_id}`;
      const sameTargets = currentTargets.map(key).join("|") === [...targets].sort((a, b) => key(a).localeCompare(key(b))).map(key).join("|");
      const samePolicy = JSON.stringify(current.outputSinks) === JSON.stringify(outputSinks)
        && current.browserAudience === browserAudience;
      if (samePolicy && sameTargets) return current;
      await revokeAudienceFacts(transaction, { sessionId, actorIdentityId, reasonCode: "cast_audience_changed", at });
      let baseRevision = expectedAudienceRevision;
      if (samePolicy && browserAudience !== "owner_only" && browserAudience !== null) {
        const intermediate = session(rows(await transaction.query(`UPDATE platform.cast_sessions SET
          browser_audience='owner_only',audience_revision=audience_revision+1
          WHERE id=$1 AND audience_revision=$2 RETURNING *`, [sessionId, baseRevision]))[0]);
        if (!intermediate) fail("cast_audience_conflict", "Casting audience changed concurrently");
        baseRevision = intermediate.audienceRevision;
      }
      const updated = session(rows(await transaction.query(`UPDATE platform.cast_sessions SET
        output_sinks=$3::text[],browser_audience=$4,audience_revision=audience_revision+1
        WHERE id=$1 AND audience_revision=$2 RETURNING *`, [sessionId, baseRevision,
        outputSinks, browserAudience]))[0]);
      if (!updated) fail("cast_audience_conflict", "Casting audience changed concurrently");
      for (const item of targets) await insertTarget(transaction, sessionId, updated.audienceRevision, item);
      for (const item of invitations) await insertInvitation(transaction, sessionId, updated.audienceRevision, item);
      await appendEvent(transaction, { sessionId, actorIdentityId, eventType: "audience.changed", at });
      for (const item of invitations) await appendEvent(transaction, { sessionId,
        actorIdentityId, eventType: "invitation.created", at: item.issuedAt });
      return updated;
    });
  }

  async downgradeAudienceToOwner({ sessionId, initiatorIdentityId, expectedAudienceRevision, at: _at }) {
    return this.#database.transaction(async (transaction) => {
      const viewers = rows(await transaction.query(`SELECT viewer_identity_id FROM platform.cast_viewer_grants
        WHERE session_id=$1 AND viewer_identity_id<>$2 AND grant_state IN ('issued','joined')`,
      [sessionId, initiatorIdentityId])).map((row) => row.viewer_identity_id);
      try {
        await transaction.query(`SELECT * FROM platform.downgrade_cast_audience_to_owner($1,$2,$3)`,
          [sessionId, initiatorIdentityId, expectedAudienceRevision]);
      } catch (error) {
        if (error?.code === "23514") fail("cast_audience_conflict", "Casting audience downgrade is stale");
        throw error;
      }
      return { session: await getSession(transaction, sessionId), revokedViewerIdentityIds: viewers };
    });
  }

  async createInvitation(value) {
    try {
      return await this.#database.transaction(async (transaction) => {
        const existing = invitation(rows(await transaction.query(`SELECT * FROM platform.cast_viewer_invitations
          WHERE session_id=$1 AND invitee_identity_id=$2 AND invitation_state='pending' FOR SHARE`,
        [value.sessionId, value.inviteeIdentityId]))[0]);
        if (existing) return existing;
        const created = await insertInvitation(transaction, value.sessionId, value.audienceRevision, value);
        await appendEvent(transaction, { sessionId: value.sessionId, actorIdentityId: value.invitedByIdentityId,
          eventType: "invitation.created", at: value.issuedAt });
        return created;
      });
    } catch (error) {
      if (error?.code === "23505") fail("cast_invitation_conflict", "A pending casting invitation already exists");
      throw error;
    }
  }

  async getInvitation(invitationId) {
    return invitation(rows(await this.#database.query(`SELECT * FROM platform.cast_viewer_invitations WHERE id=$1`,
      [invitationId]))[0]);
  }

  async listInvitationsForIdentity(identityId, now) {
    return rows(await this.#database.query(`SELECT * FROM platform.cast_viewer_invitations
      WHERE invitee_identity_id=$1 AND invitation_state='pending' AND expires_at>$2
      ORDER BY issued_at DESC,id DESC`, [identityId, now])).map(invitation);
  }

  async resolveInvitation({ invitationId, inviteeIdentityId, state, reasonCode = null, at }) {
    return this.#database.transaction(async (transaction) => {
      const updated = invitation(rows(await transaction.query(`UPDATE platform.cast_viewer_invitations SET
        invitation_state=$3,revision=revision+1,resolved_at=$4,resolution_reason_code=$5
        WHERE id=$1 AND invitee_identity_id=$2 AND invitation_state='pending' RETURNING *`,
      [invitationId, inviteeIdentityId, state, at, reasonCode]))[0]);
      if (!updated) fail("cast_invitation_resolved", "Casting invitation is missing or already resolved");
      await appendEvent(transaction, { sessionId: updated.sessionId, actorIdentityId: inviteeIdentityId,
        eventType: "invitation.resolved", reasonCode: ["accepted", "declined"].includes(state) ? null : reasonCode, at });
      return updated;
    });
  }

  async isIdentityInAudience({ sessionId, identityId, teamIds: _teamIds = [], now: _now }) {
    return rows(await this.#database.query(`SELECT platform.cast_identity_in_current_audience($1,$2) AS allowed`,
      [sessionId, identityId]))[0]?.allowed === true;
  }

  async createGrant(value) {
    try {
      return grant(rows(await this.#database.query(`INSERT INTO platform.cast_viewer_grants (
        id,session_id,audience_revision,viewer_identity_id,invitation_id,issued_by_identity_id,issued_at,expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [value.grantId, value.sessionId,
        value.audienceRevision, value.viewerIdentityId, value.invitationId, value.issuedByIdentityId,
        value.issuedAt, value.expiresAt]))[0]);
    } catch (error) {
      if (error?.code === "23505") fail("cast_viewer_grant_conflict", "An open casting viewer grant already exists");
      throw error;
    }
  }

  async getOpenGrant({ sessionId, viewerIdentityId }) {
    return grant(rows(await this.#database.query(`SELECT * FROM platform.cast_viewer_grants
      WHERE session_id=$1 AND viewer_identity_id=$2 AND grant_state IN ('issued','joined') LIMIT 1`,
    [sessionId, viewerIdentityId]))[0]);
  }

  async joinGrant({ grantId, expectedRevision, at }) {
    return this.#database.transaction(async (transaction) => {
      const updated = grant(rows(await transaction.query(`UPDATE platform.cast_viewer_grants SET
        grant_state='joined',revision=revision+1,joined_at=$3
        WHERE id=$1 AND revision=$2 AND grant_state='issued' AND expires_at>$3 RETURNING *`,
      [grantId, expectedRevision, at]))[0]);
      if (!updated) fail("cast_viewer_grant_conflict", "Casting viewer grant is stale or expired");
      await appendEvent(transaction, { sessionId: updated.sessionId, actorIdentityId: updated.viewerIdentityId,
        eventType: "viewer.joined", at });
      return updated;
    });
  }

  async endGrant({ sessionId, viewerIdentityId, state, actorIdentityId, reasonCode, at }) {
    return this.#database.transaction(async (transaction) => {
      const allowedFrom = state === "left" ? "grant_state='joined'" : "grant_state IN ('issued','joined')";
      const updated = grant(rows(await transaction.query(`UPDATE platform.cast_viewer_grants SET
        grant_state=$3,revision=revision+1,ended_at=$4,terminal_reason_code=$5
        WHERE session_id=$1 AND viewer_identity_id=$2 AND ${allowedFrom} RETURNING *`,
      [sessionId, viewerIdentityId, state, at, reasonCode]))[0]);
      if (!updated) return null;
      await appendEvent(transaction, { sessionId, actorIdentityId,
        eventType: state === "left" ? "viewer.left" : "viewer.revoked", reasonCode, at });
      return updated;
    });
  }

  async listJoinedViewers(sessionId, now) {
    return rows(await this.#database.query(`SELECT * FROM platform.cast_viewer_grants
      WHERE session_id=$1 AND grant_state='joined' AND expires_at>$2 ORDER BY joined_at,id`,
    [sessionId, now])).map(grant);
  }

  async expireDue(now) {
    return this.#database.transaction(async (transaction) => {
      await transaction.query(`UPDATE platform.cast_viewer_invitations SET invitation_state='expired',
        revision=revision+1,resolved_at=$1,resolution_reason_code='cast_invitation_expired'
        WHERE invitation_state='pending' AND expires_at<=$1`, [now]);
      await transaction.query(`UPDATE platform.cast_viewer_grants SET grant_state='expired',
        revision=revision+1,ended_at=$1,terminal_reason_code='cast_viewer_grant_expired'
        WHERE grant_state IN ('issued','joined') AND expires_at<=$1`, [now]);
      return rows(await transaction.query(`SELECT * FROM platform.cast_sessions WHERE expires_at<=$1
        AND session_state IN ('requested','starting','pairing','paired','streaming','stopping')
        ORDER BY expires_at,id FOR UPDATE SKIP LOCKED`, [now])).map(session);
    });
  }
}
