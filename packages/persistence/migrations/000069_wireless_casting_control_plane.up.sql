INSERT INTO iam.permissions (permission_key, description_key) VALUES
    ('cast:use', 'permissions.cast_use'),
    ('cast:share', 'permissions.cast_share'),
    ('cast:view', 'permissions.cast_view'),
    ('cast:manage', 'permissions.cast_manage');

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, mapping.permission_key
FROM iam.roles role
JOIN (VALUES
    ('owner', 'cast:use'),
    ('owner', 'cast:share'),
    ('owner', 'cast:view'),
    ('owner', 'cast:manage'),
    ('system_admin', 'cast:manage'),
    ('compute_admin', 'cast:use'),
    ('compute_admin', 'cast:view'),
    ('compute_admin', 'cast:manage'),
    ('application_admin', 'cast:use'),
    ('application_admin', 'cast:view'),
    ('developer', 'cast:use'),
    ('developer', 'cast:view'),
    ('team_admin', 'cast:use'),
    ('team_admin', 'cast:share'),
    ('team_admin', 'cast:view'),
    ('member', 'cast:use'),
    ('member', 'cast:view'),
    ('guest', 'cast:view')
) AS mapping(role_key, permission_key)
ON role.role_key = mapping.role_key;

CREATE FUNCTION platform.cast_identity_has_permission(
    p_identity_id uuid,
    p_permission_key text,
    p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM iam.identities identity
        JOIN iam.role_bindings binding
          ON binding.identity_id = identity.id
         AND (binding.expires_at IS NULL OR binding.expires_at > p_at)
        JOIN iam.role_permissions role_permission
          ON role_permission.role_id = binding.role_id
         AND role_permission.permission_key = p_permission_key
        WHERE identity.id = p_identity_id
          AND identity.identity_kind = 'local_user'
          AND identity.status = 'active'
    );
$$;

CREATE FUNCTION platform.cast_output_sinks_valid(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT value = ARRAY['hdmi']::text[]
        OR value = ARRAY['browser']::text[]
        OR value = ARRAY['hdmi', 'browser']::text[];
$$;

CREATE TABLE platform.cast_sessions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    appliance_node_group_id uuid NOT NULL
        REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    initiator_identity_id uuid NOT NULL
        REFERENCES iam.identities(id) ON DELETE RESTRICT,
    session_state text NOT NULL DEFAULT 'requested' CHECK (
        session_state IN (
            'requested', 'starting', 'pairing', 'paired', 'streaming',
            'stopping', 'stopped', 'expired', 'failed'
        )
    ),
    state_revision bigint NOT NULL DEFAULT 1 CHECK (state_revision > 0),
    output_sinks text[] NOT NULL CHECK (
        platform.cast_output_sinks_valid(output_sinks)
    ),
    browser_audience text CHECK (
        browser_audience IS NULL
        OR browser_audience IN ('owner_only', 'selected_users', 'selected_team')
    ),
    audience_revision bigint NOT NULL DEFAULT 1 CHECK (audience_revision > 0),
    pairing_failed_attempts integer NOT NULL DEFAULT 0 CHECK (
        pairing_failed_attempts BETWEEN 0 AND 10
    ),
    pairing_blocked_until timestamptz,
    paired_at timestamptz,
    started_at timestamptz,
    terminal_at timestamptz,
    terminal_reason_code text CHECK (
        terminal_reason_code IS NULL
        OR terminal_reason_code ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK (
        expires_at > created_at
        AND expires_at <= created_at + interval '4 hours'
    ),
    CHECK (paired_at IS NULL OR paired_at >= created_at),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (terminal_at IS NULL OR terminal_at >= created_at),
    CHECK (updated_at >= created_at),
    CHECK (pairing_blocked_until IS NULL OR pairing_blocked_until <= expires_at),
    CHECK (
        paired_at IS NULL
        OR session_state IN ('paired', 'streaming', 'stopping', 'stopped', 'expired', 'failed')
    ),
    CHECK (session_state <> 'streaming' OR started_at IS NOT NULL),
    CHECK (
        (session_state IN ('stopped', 'expired', 'failed')
         AND terminal_at IS NOT NULL AND terminal_reason_code IS NOT NULL)
        OR
        (session_state NOT IN ('stopped', 'expired', 'failed')
         AND terminal_at IS NULL AND terminal_reason_code IS NULL)
    ),
    CHECK (
        session_state NOT IN ('paired', 'streaming')
        OR paired_at IS NOT NULL
    )
);

CREATE UNIQUE INDEX cast_sessions_one_non_terminal_per_appliance_idx
ON platform.cast_sessions (appliance_node_group_id)
WHERE session_state IN (
    'requested', 'starting', 'pairing', 'paired', 'streaming', 'stopping'
);

CREATE INDEX cast_sessions_initiator_time_idx
ON platform.cast_sessions (initiator_identity_id, created_at DESC, id);

CREATE INDEX cast_sessions_expiry_idx
ON platform.cast_sessions (expires_at, id)
WHERE session_state IN (
    'requested', 'starting', 'pairing', 'paired', 'streaming', 'stopping'
);

CREATE FUNCTION platform.enforce_cast_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    appliance_role text;
    initiator_kind text;
    initiator_status text;
    valid_transition boolean;
    audience_changed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'casting sessions are durable lifecycle records'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT role INTO appliance_role
        FROM compute.node_groups
        WHERE id = NEW.appliance_node_group_id;

        SELECT identity_kind, status
        INTO initiator_kind, initiator_status
        FROM iam.identities
        WHERE id = NEW.initiator_identity_id;

        IF appliance_role IS DISTINCT FROM 'appliance-core'
           OR initiator_kind IS DISTINCT FROM 'local_user'
           OR initiator_status IS DISTINCT FROM 'active'
           OR NOT platform.cast_identity_has_permission(
               NEW.initiator_identity_id, 'cast:use', NEW.created_at
           )
           OR (NEW.browser_audience IN ('selected_users', 'selected_team')
               AND NOT platform.cast_identity_has_permission(
                   NEW.initiator_identity_id, 'cast:share', NEW.created_at
               ))
           OR NEW.session_state <> 'requested'
           OR NEW.state_revision <> 1
           OR NEW.audience_revision <> 1 THEN
            RAISE EXCEPTION 'casting session creation is outside the appliance or initiator boundary'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id <> OLD.id
       OR NEW.appliance_node_group_id <> OLD.appliance_node_group_id
       OR NEW.initiator_identity_id <> OLD.initiator_identity_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'immutable casting session identity fields cannot change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.session_state IN ('stopped', 'expired', 'failed') THEN
        RAISE EXCEPTION 'terminal casting sessions cannot change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.session_state IS DISTINCT FROM OLD.session_state THEN
        valid_transition := CASE OLD.session_state
            WHEN 'requested' THEN NEW.session_state IN ('starting', 'stopped', 'failed')
            WHEN 'starting' THEN NEW.session_state IN ('pairing', 'stopping', 'stopped', 'failed')
            WHEN 'pairing' THEN NEW.session_state IN ('paired', 'streaming', 'stopping', 'stopped', 'expired', 'failed')
            WHEN 'paired' THEN NEW.session_state IN ('streaming', 'stopping', 'stopped', 'expired', 'failed')
            WHEN 'streaming' THEN NEW.session_state IN ('stopping', 'stopped', 'expired', 'failed')
            WHEN 'stopping' THEN NEW.session_state IN ('stopped', 'failed')
            ELSE false
        END;
        IF NOT valid_transition OR NEW.state_revision <> OLD.state_revision + 1 THEN
            RAISE EXCEPTION 'invalid casting session state transition or revision'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.state_revision <> OLD.state_revision THEN
        RAISE EXCEPTION 'casting state revision changed without a state transition'
            USING ERRCODE = 'check_violation';
    END IF;

    audience_changed := NEW.output_sinks IS DISTINCT FROM OLD.output_sinks
        OR NEW.browser_audience IS DISTINCT FROM OLD.browser_audience;
    IF NEW.browser_audience IN ('selected_users', 'selected_team')
       AND NOT platform.cast_identity_has_permission(
           NEW.initiator_identity_id, 'cast:share', clock_timestamp()
       ) THEN
        RAISE EXCEPTION 'casting audience sharing requires current cast:share authority'
            USING ERRCODE = 'check_violation';
    END IF;
    IF audience_changed AND NEW.audience_revision <> OLD.audience_revision + 1 THEN
        RAISE EXCEPTION 'casting audience change must advance exactly one revision'
            USING ERRCODE = 'check_violation';
    ELSIF NOT audience_changed AND NEW.audience_revision <> OLD.audience_revision THEN
        RAISE EXCEPTION 'casting audience revision changed without an audience change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.pairing_failed_attempts < OLD.pairing_failed_attempts
       OR (OLD.pairing_blocked_until IS NOT NULL
           AND (NEW.pairing_blocked_until IS NULL
                OR NEW.pairing_blocked_until < OLD.pairing_blocked_until))
       OR (OLD.paired_at IS NULL AND NEW.paired_at IS NOT NULL
           AND NEW.session_state NOT IN ('paired', 'streaming'))
       OR (OLD.started_at IS NULL AND NEW.started_at IS NOT NULL
           AND NEW.session_state <> 'streaming')
       OR (OLD.paired_at IS NOT NULL AND NEW.paired_at IS DISTINCT FROM OLD.paired_at)
       OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
       OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
       OR (OLD.terminal_reason_code IS NOT NULL
           AND NEW.terminal_reason_code IS DISTINCT FROM OLD.terminal_reason_code) THEN
        RAISE EXCEPTION 'casting security or lifecycle facts cannot be rewritten'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER cast_sessions_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON platform.cast_sessions
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_session_write();

CREATE TABLE platform.cast_audience_targets (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL
        REFERENCES platform.cast_sessions(id) ON DELETE RESTRICT,
    audience_revision bigint NOT NULL CHECK (audience_revision > 0),
    target_kind text NOT NULL CHECK (target_kind IN ('user', 'team')),
    target_identity_id uuid REFERENCES iam.identities(id) ON DELETE RESTRICT,
    target_team_id uuid REFERENCES iam.teams(id) ON DELETE RESTRICT,
    target_state text NOT NULL DEFAULT 'active' CHECK (
        target_state IN ('active', 'revoked')
    ),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by_identity_id uuid NOT NULL
        REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    revoked_by_identity_id uuid REFERENCES iam.identities(id) ON DELETE RESTRICT,
    revoke_reason_code text CHECK (
        revoke_reason_code IS NULL
        OR revoke_reason_code ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    CHECK (
        (target_kind = 'user' AND target_identity_id IS NOT NULL AND target_team_id IS NULL)
        OR
        (target_kind = 'team' AND target_identity_id IS NULL AND target_team_id IS NOT NULL)
    ),
    CHECK (
        (target_state = 'active'
         AND revoked_at IS NULL
         AND revoked_by_identity_id IS NULL
         AND revoke_reason_code IS NULL)
        OR
        (target_state = 'revoked'
         AND revoked_at IS NOT NULL
         AND revoked_by_identity_id IS NOT NULL
         AND revoke_reason_code IS NOT NULL)
    ),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX cast_audience_targets_one_active_user_idx
ON platform.cast_audience_targets (session_id, target_identity_id)
WHERE target_state = 'active' AND target_kind = 'user';

CREATE UNIQUE INDEX cast_audience_targets_one_active_team_idx
ON platform.cast_audience_targets (session_id, target_team_id)
WHERE target_state = 'active' AND target_kind = 'team';

CREATE INDEX cast_audience_targets_session_revision_idx
ON platform.cast_audience_targets (session_id, audience_revision, target_state, id);

CREATE FUNCTION platform.enforce_cast_audience_target_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_initiator uuid;
    session_audience text;
    session_audience_revision bigint;
    session_has_browser boolean;
    target_identity_kind text;
    target_identity_status text;
    target_team_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'casting audience facts must be revoked rather than deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.id <> OLD.id
           OR NEW.session_id <> OLD.session_id
           OR NEW.audience_revision <> OLD.audience_revision
           OR NEW.target_kind <> OLD.target_kind
           OR NEW.target_identity_id IS DISTINCT FROM OLD.target_identity_id
           OR NEW.target_team_id IS DISTINCT FROM OLD.target_team_id
           OR NEW.created_by_identity_id <> OLD.created_by_identity_id
           OR NEW.created_at <> OLD.created_at
           OR OLD.target_state <> 'active'
           OR NEW.target_state <> 'revoked'
           OR NEW.revision <> OLD.revision + 1 THEN
            RAISE EXCEPTION 'casting audience target mutation is not a one-way revocation'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    SELECT session.initiator_identity_id,
           session.browser_audience,
           session.audience_revision,
           session.output_sinks @> ARRAY['browser']::text[]
    INTO session_initiator, session_audience,
         session_audience_revision, session_has_browser
    FROM platform.cast_sessions session
    WHERE session.id = NEW.session_id;

    IF session_initiator IS NULL
       OR NOT session_has_browser
       OR NEW.created_by_identity_id <> session_initiator
       OR NEW.audience_revision <> session_audience_revision
       OR NEW.target_state <> 'active'
       OR NEW.revision <> 1
       OR (NEW.target_kind = 'user' AND session_audience <> 'selected_users')
       OR (NEW.target_kind = 'team' AND session_audience <> 'selected_team') THEN
        RAISE EXCEPTION 'casting target is outside the current audience boundary'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.target_kind = 'user' THEN
        SELECT identity_kind, status
        INTO target_identity_kind, target_identity_status
        FROM iam.identities
        WHERE id = NEW.target_identity_id;
        IF target_identity_kind IS DISTINCT FROM 'local_user'
           OR target_identity_status IS DISTINCT FROM 'active'
           OR NEW.target_identity_id = session_initiator THEN
            RAISE EXCEPTION 'casting user audience target is not eligible'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        SELECT status INTO target_team_status
        FROM iam.teams
        WHERE id = NEW.target_team_id;
        IF target_team_status IS DISTINCT FROM 'active' THEN
            RAISE EXCEPTION 'casting team audience target is not active'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER cast_audience_targets_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON platform.cast_audience_targets
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_audience_target_write();

CREATE FUNCTION platform.enforce_cast_audience_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_session_id uuid;
    target_output_sinks text[];
    target_browser_audience text;
    target_audience_revision bigint;
    active_user_targets integer;
    active_team_targets integer;
    stale_active_targets integer;
    has_browser boolean;
BEGIN
    IF TG_TABLE_NAME = 'cast_audience_targets' THEN
        target_session_id := NEW.session_id;
    ELSE
        target_session_id := NEW.id;
    END IF;

    SELECT output_sinks, browser_audience, audience_revision
    INTO target_output_sinks, target_browser_audience, target_audience_revision
    FROM platform.cast_sessions
    WHERE id = target_session_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT count(*) FILTER (WHERE target_kind = 'user'),
           count(*) FILTER (WHERE target_kind = 'team'),
           count(*) FILTER (WHERE audience_revision <> target_audience_revision)
    INTO active_user_targets, active_team_targets, stale_active_targets
    FROM platform.cast_audience_targets
    WHERE session_id = target_session_id
      AND target_state = 'active';

    has_browser := target_output_sinks @> ARRAY['browser']::text[];

    IF stale_active_targets <> 0
       OR (NOT has_browser AND (
            target_browser_audience IS NOT NULL
            OR active_user_targets <> 0
            OR active_team_targets <> 0
       ))
       OR (has_browser AND target_browser_audience IS NULL)
       OR (target_browser_audience = 'owner_only' AND (
            active_user_targets <> 0 OR active_team_targets <> 0
       ))
       OR (target_browser_audience = 'selected_users' AND (
            active_user_targets < 1 OR active_team_targets <> 0
       ))
       OR (target_browser_audience = 'selected_team' AND (
            active_user_targets <> 0 OR active_team_targets <> 1
       )) THEN
        RAISE EXCEPTION 'casting output and audience target invariants are not satisfied'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER cast_sessions_audience_boundary
AFTER INSERT OR UPDATE OF output_sinks, browser_audience, audience_revision
ON platform.cast_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_audience_boundary();

CREATE CONSTRAINT TRIGGER cast_audience_targets_session_boundary
AFTER INSERT OR UPDATE ON platform.cast_audience_targets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_audience_boundary();

CREATE FUNCTION platform.cast_identity_in_current_audience(
    p_session_id uuid,
    p_identity_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM platform.cast_sessions session
        JOIN iam.identities identity
          ON identity.id = p_identity_id
         AND identity.identity_kind = 'local_user'
         AND identity.status = 'active'
        WHERE session.id = p_session_id
          AND session.output_sinks @> ARRAY['browser']::text[]
          AND session.session_state IN (
              'requested', 'starting', 'pairing', 'paired', 'streaming'
          )
          AND session.expires_at > clock_timestamp()
          AND platform.cast_identity_has_permission(
              p_identity_id, 'cast:view', clock_timestamp()
          )
          AND (
              session.initiator_identity_id = p_identity_id
              OR (
                  session.browser_audience = 'selected_users'
                  AND EXISTS (
                      SELECT 1
                      FROM platform.cast_audience_targets target
                      WHERE target.session_id = session.id
                        AND target.audience_revision = session.audience_revision
                        AND target.target_kind = 'user'
                        AND target.target_identity_id = p_identity_id
                        AND target.target_state = 'active'
                  )
              )
              OR (
                  session.browser_audience = 'selected_team'
                  AND EXISTS (
                      SELECT 1
                      FROM platform.cast_audience_targets target
                      JOIN iam.teams team ON team.id = target.target_team_id
                      JOIN iam.role_bindings binding
                        ON binding.identity_id = p_identity_id
                       AND binding.scope_kind = 'team'
                       AND binding.scope_key = team.team_key
                       AND (binding.expires_at IS NULL
                            OR binding.expires_at > clock_timestamp())
                      WHERE target.session_id = session.id
                        AND target.audience_revision = session.audience_revision
                        AND target.target_kind = 'team'
                        AND target.target_state = 'active'
                        AND team.status = 'active'
                  )
              )
          )
    );
$$;

CREATE TABLE platform.cast_viewer_invitations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL
        REFERENCES platform.cast_sessions(id) ON DELETE RESTRICT,
    audience_revision bigint NOT NULL CHECK (audience_revision > 0),
    invitee_identity_id uuid NOT NULL
        REFERENCES iam.identities(id) ON DELETE RESTRICT,
    invited_by_identity_id uuid NOT NULL
        REFERENCES iam.identities(id) ON DELETE RESTRICT,
    invitation_state text NOT NULL DEFAULT 'pending' CHECK (
        invitation_state IN ('pending', 'accepted', 'declined', 'revoked', 'expired')
    ),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    resolved_at timestamptz,
    resolution_reason_code text CHECK (
        resolution_reason_code IS NULL
        OR resolution_reason_code ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    CHECK (
        expires_at > issued_at
        AND expires_at <= issued_at + interval '15 minutes'
    ),
    CHECK (
        (invitation_state = 'pending'
         AND resolved_at IS NULL AND resolution_reason_code IS NULL)
        OR
        (invitation_state IN ('accepted', 'declined')
         AND resolved_at IS NOT NULL)
        OR
        (invitation_state IN ('revoked', 'expired')
         AND resolved_at IS NOT NULL AND resolution_reason_code IS NOT NULL)
    ),
    CHECK (resolved_at IS NULL OR resolved_at >= issued_at)
);

CREATE UNIQUE INDEX cast_viewer_invitations_one_pending_idx
ON platform.cast_viewer_invitations (session_id, invitee_identity_id)
WHERE invitation_state = 'pending';

CREATE INDEX cast_viewer_invitations_expiry_idx
ON platform.cast_viewer_invitations (expires_at, id)
WHERE invitation_state = 'pending';

CREATE FUNCTION platform.enforce_cast_invitation_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_initiator uuid;
    session_audience_revision bigint;
    session_expires_at timestamptz;
    valid_transition boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'casting invitation facts cannot be deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT initiator_identity_id, audience_revision, expires_at
    INTO session_initiator, session_audience_revision, session_expires_at
    FROM platform.cast_sessions
    WHERE id = NEW.session_id;

    IF TG_OP = 'INSERT' THEN
        IF session_initiator IS NULL
           OR NEW.invited_by_identity_id <> session_initiator
           OR NEW.audience_revision <> session_audience_revision
           OR NEW.expires_at > session_expires_at
           OR NEW.invitation_state <> 'pending'
           OR NEW.revision <> 1
           OR NOT platform.cast_identity_in_current_audience(
               NEW.session_id, NEW.invitee_identity_id
           ) THEN
            RAISE EXCEPTION 'casting invitation is outside the current audience boundary'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id <> OLD.id
       OR NEW.session_id <> OLD.session_id
       OR NEW.audience_revision <> OLD.audience_revision
       OR NEW.invitee_identity_id <> OLD.invitee_identity_id
       OR NEW.invited_by_identity_id <> OLD.invited_by_identity_id
       OR NEW.issued_at <> OLD.issued_at
       OR NEW.expires_at <> OLD.expires_at
       OR OLD.invitation_state <> 'pending'
       OR NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'casting invitation mutation is not a terminal resolution'
            USING ERRCODE = 'check_violation';
    END IF;

    valid_transition := NEW.invitation_state IN (
        'accepted', 'declined', 'revoked', 'expired'
    );
    IF NOT valid_transition THEN
        RAISE EXCEPTION 'invalid casting invitation state transition'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.invitation_state = 'accepted' AND NEW.resolved_at > NEW.expires_at THEN
        RAISE EXCEPTION 'expired casting invitations cannot be accepted'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cast_viewer_invitations_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON platform.cast_viewer_invitations
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_invitation_write();

CREATE TABLE platform.cast_viewer_grants (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    session_id uuid NOT NULL
        REFERENCES platform.cast_sessions(id) ON DELETE RESTRICT,
    audience_revision bigint NOT NULL CHECK (audience_revision > 0),
    viewer_identity_id uuid NOT NULL
        REFERENCES iam.identities(id) ON DELETE RESTRICT,
    invitation_id uuid REFERENCES platform.cast_viewer_invitations(id)
        ON DELETE RESTRICT,
    issued_by_identity_id uuid NOT NULL
        REFERENCES iam.identities(id) ON DELETE RESTRICT,
    grant_state text NOT NULL DEFAULT 'issued' CHECK (
        grant_state IN ('issued', 'joined', 'left', 'revoked', 'expired')
    ),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    joined_at timestamptz,
    ended_at timestamptz,
    terminal_reason_code text CHECK (
        terminal_reason_code IS NULL
        OR terminal_reason_code ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    CHECK (
        expires_at > issued_at
        AND expires_at <= issued_at + interval '5 minutes'
    ),
    CHECK (
        (grant_state = 'issued'
         AND joined_at IS NULL AND ended_at IS NULL
         AND terminal_reason_code IS NULL)
        OR
        (grant_state = 'joined'
         AND joined_at IS NOT NULL AND ended_at IS NULL
         AND terminal_reason_code IS NULL)
        OR
        (grant_state IN ('left', 'revoked', 'expired')
         AND ended_at IS NOT NULL AND terminal_reason_code IS NOT NULL)
    ),
    CHECK (joined_at IS NULL OR (joined_at >= issued_at AND joined_at < expires_at)),
    CHECK (ended_at IS NULL OR ended_at >= issued_at)
);

CREATE UNIQUE INDEX cast_viewer_grants_one_open_per_viewer_idx
ON platform.cast_viewer_grants (session_id, viewer_identity_id)
WHERE grant_state IN ('issued', 'joined');

CREATE INDEX cast_viewer_grants_expiry_idx
ON platform.cast_viewer_grants (expires_at, id)
WHERE grant_state IN ('issued', 'joined');

CREATE INDEX cast_viewer_grants_live_session_idx
ON platform.cast_viewer_grants (session_id, grant_state, viewer_identity_id)
WHERE grant_state = 'joined';

CREATE FUNCTION platform.enforce_cast_viewer_grant_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    session_initiator uuid;
    session_audience_revision bigint;
    session_expires_at timestamptz;
    invitation_matches boolean;
    valid_transition boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'casting viewer grant facts cannot be deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT initiator_identity_id, audience_revision, expires_at
    INTO session_initiator, session_audience_revision, session_expires_at
    FROM platform.cast_sessions
    WHERE id = NEW.session_id;

    IF TG_OP = 'INSERT' THEN
        invitation_matches := NEW.viewer_identity_id = session_initiator
            AND NEW.invitation_id IS NULL;
        IF NOT invitation_matches AND NEW.invitation_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1
                FROM platform.cast_viewer_invitations invitation
                WHERE invitation.id = NEW.invitation_id
                  AND invitation.session_id = NEW.session_id
                  AND invitation.invitee_identity_id = NEW.viewer_identity_id
                  AND invitation.audience_revision = NEW.audience_revision
                  AND invitation.invitation_state = 'accepted'
                  AND invitation.expires_at > NEW.issued_at
            ) INTO invitation_matches;
        END IF;

        IF session_initiator IS NULL
           OR NEW.issued_by_identity_id <> session_initiator
           OR NEW.audience_revision <> session_audience_revision
           OR NEW.expires_at > session_expires_at
           OR NEW.grant_state <> 'issued'
           OR NEW.revision <> 1
           OR NOT invitation_matches
           OR NOT platform.cast_identity_in_current_audience(
               NEW.session_id, NEW.viewer_identity_id
           ) THEN
            RAISE EXCEPTION 'casting viewer grant is outside the current authorization boundary'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id <> OLD.id
       OR NEW.session_id <> OLD.session_id
       OR NEW.audience_revision <> OLD.audience_revision
       OR NEW.viewer_identity_id <> OLD.viewer_identity_id
       OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
       OR NEW.issued_by_identity_id <> OLD.issued_by_identity_id
       OR NEW.issued_at <> OLD.issued_at
       OR NEW.expires_at <> OLD.expires_at
       OR (OLD.joined_at IS NOT NULL AND NEW.joined_at <> OLD.joined_at)
       OR NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'immutable casting viewer grant fields cannot change'
            USING ERRCODE = 'check_violation';
    END IF;

    valid_transition := CASE OLD.grant_state
        WHEN 'issued' THEN NEW.grant_state IN ('joined', 'revoked', 'expired')
        WHEN 'joined' THEN NEW.grant_state IN ('left', 'revoked', 'expired')
        ELSE false
    END;
    IF NOT valid_transition THEN
        RAISE EXCEPTION 'invalid casting viewer grant state transition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cast_viewer_grants_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON platform.cast_viewer_grants
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_viewer_grant_write();

CREATE FUNCTION platform.enforce_cast_viewer_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    live_viewers integer;
    session_state text;
    session_expires_at timestamptz;
    has_browser boolean;
BEGIN
    IF NEW.grant_state <> 'joined' OR OLD.grant_state = 'joined' THEN
        RETURN NEW;
    END IF;

    SELECT session.session_state,
           session.expires_at,
           session.output_sinks @> ARRAY['browser']::text[]
    INTO session_state, session_expires_at, has_browser
    FROM platform.cast_sessions session
    WHERE session.id = NEW.session_id
    FOR UPDATE;

    IF session_state NOT IN ('requested', 'starting', 'pairing', 'paired', 'streaming')
       OR session_expires_at <= clock_timestamp()
       OR NEW.expires_at <= clock_timestamp()
       OR NOT has_browser
       OR NOT platform.cast_identity_in_current_audience(
           NEW.session_id, NEW.viewer_identity_id
       ) THEN
        RAISE EXCEPTION 'casting viewer cannot join the current session'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO live_viewers
    FROM platform.cast_viewer_grants grant_row
    WHERE grant_row.session_id = NEW.session_id
      AND grant_row.grant_state = 'joined'
      AND grant_row.expires_at > clock_timestamp()
      AND grant_row.id <> NEW.id;

    IF live_viewers >= 8 THEN
        RAISE EXCEPTION 'casting browser viewer capacity is exhausted'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER cast_viewer_grants_capacity_guard
BEFORE UPDATE OF grant_state ON platform.cast_viewer_grants
FOR EACH ROW EXECUTE FUNCTION platform.enforce_cast_viewer_capacity();

CREATE TABLE platform.cast_session_events (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    session_id uuid NOT NULL
        REFERENCES platform.cast_sessions(id) ON DELETE RESTRICT,
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE RESTRICT,
    event_type text NOT NULL CHECK (
        event_type IN (
            'session.created', 'session.state_changed', 'session.stopped',
            'session.force_stopped', 'session.expired', 'session.failed',
            'audience.changed', 'audience.downgraded',
            'invitation.created', 'invitation.resolved',
            'viewer.joined', 'viewer.left', 'viewer.revoked',
            'output.health_changed', 'capacity.denied', 'authorization.denied'
        )
    ),
    outcome text NOT NULL CHECK (
        outcome IN ('succeeded', 'failed', 'denied')
    ),
    state_revision bigint NOT NULL CHECK (state_revision > 0),
    audience_revision bigint NOT NULL CHECK (audience_revision > 0),
    session_state text NOT NULL CHECK (
        session_state IN (
            'requested', 'starting', 'pairing', 'paired', 'streaming',
            'stopping', 'stopped', 'expired', 'failed'
        )
    ),
    browser_audience text CHECK (
        browser_audience IS NULL
        OR browser_audience IN ('owner_only', 'selected_users', 'selected_team')
    ),
    active_viewer_count integer NOT NULL CHECK (
        active_viewer_count BETWEEN 0 AND 8
    ),
    reason_code text CHECK (
        reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (outcome = 'succeeded' AND reason_code IS NULL)
        OR (outcome IN ('failed', 'denied') AND reason_code IS NOT NULL)
        OR (event_type IN (
            'session.stopped', 'session.force_stopped', 'session.expired',
            'session.failed', 'audience.downgraded', 'viewer.left',
            'viewer.revoked', 'output.health_changed'
        ) AND reason_code IS NOT NULL)
    )
);

CREATE INDEX cast_session_events_session_cursor_idx
ON platform.cast_session_events (session_id, sequence_id);

CREATE FUNCTION platform.reject_cast_session_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'casting session events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER cast_session_events_append_only
BEFORE UPDATE OR DELETE ON platform.cast_session_events
FOR EACH ROW EXECUTE FUNCTION platform.reject_cast_session_event_mutation();

CREATE FUNCTION platform.downgrade_cast_audience_to_owner(
    target_session_id uuid,
    expected_initiator_identity_id uuid,
    expected_audience_revision bigint
)
RETURNS TABLE (
    new_audience_revision bigint,
    revoked_target_count integer,
    revoked_invitation_count integer,
    revoked_viewer_count integer
)
LANGUAGE plpgsql
AS $$
DECLARE
    session_row platform.cast_sessions%ROWTYPE;
    target_count integer;
    invitation_count integer;
    viewer_count integer;
BEGIN
    SELECT * INTO session_row
    FROM platform.cast_sessions
    WHERE id = target_session_id
    FOR UPDATE;

    IF NOT FOUND
       OR session_row.initiator_identity_id <> expected_initiator_identity_id
       OR session_row.audience_revision <> expected_audience_revision
       OR session_row.session_state IN ('stopped', 'expired', 'failed')
       OR NOT (session_row.output_sinks @> ARRAY['browser']::text[]) THEN
        RAISE EXCEPTION 'casting audience downgrade authority or generation is stale'
            USING ERRCODE = 'check_violation';
    END IF;

    IF session_row.browser_audience = 'owner_only' THEN
        RETURN QUERY SELECT session_row.audience_revision, 0, 0, 0;
        RETURN;
    END IF;

    UPDATE platform.cast_audience_targets
    SET target_state = 'revoked',
        revision = revision + 1,
        revoked_at = clock_timestamp(),
        revoked_by_identity_id = expected_initiator_identity_id,
        revoke_reason_code = 'cast_share_revoked'
    WHERE session_id = target_session_id
      AND target_state = 'active';
    GET DIAGNOSTICS target_count = ROW_COUNT;

    UPDATE platform.cast_viewer_invitations
    SET invitation_state = 'revoked',
        revision = revision + 1,
        resolved_at = clock_timestamp(),
        resolution_reason_code = 'cast_share_revoked'
    WHERE session_id = target_session_id
      AND invitee_identity_id <> expected_initiator_identity_id
      AND invitation_state = 'pending';
    GET DIAGNOSTICS invitation_count = ROW_COUNT;

    UPDATE platform.cast_viewer_grants
    SET grant_state = 'revoked',
        revision = revision + 1,
        ended_at = clock_timestamp(),
        terminal_reason_code = 'cast_share_revoked'
    WHERE session_id = target_session_id
      AND viewer_identity_id <> expected_initiator_identity_id
      AND grant_state IN ('issued', 'joined');
    GET DIAGNOSTICS viewer_count = ROW_COUNT;

    UPDATE platform.cast_sessions
    SET browser_audience = 'owner_only',
        audience_revision = audience_revision + 1
    WHERE id = target_session_id;

    INSERT INTO platform.cast_session_events (
        session_id, actor_identity_id, event_type, outcome,
        state_revision, audience_revision, session_state,
        browser_audience, active_viewer_count, reason_code
    )
    SELECT session.id,
           expected_initiator_identity_id,
           'audience.downgraded',
           'succeeded',
           session.state_revision,
           session.audience_revision,
           session.session_state,
           session.browser_audience,
           count(grant_row.id)::integer,
           'cast_share_revoked'
    FROM platform.cast_sessions session
    LEFT JOIN platform.cast_viewer_grants grant_row
      ON grant_row.session_id = session.id
     AND grant_row.grant_state = 'joined'
     AND grant_row.expires_at > clock_timestamp()
    WHERE session.id = target_session_id
    GROUP BY session.id;

    RETURN QUERY
    SELECT session_row.audience_revision + 1,
           target_count, invitation_count, viewer_count;
END;
$$;
