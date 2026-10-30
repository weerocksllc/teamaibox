CREATE TABLE iam.appliance_bootstrap (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    owner_identity_id uuid NOT NULL UNIQUE REFERENCES iam.identities(id) ON DELETE RESTRICT,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE iam.authentication_states (
    identity_id uuid PRIMARY KEY REFERENCES iam.identities(id) ON DELETE CASCADE,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    failure_window_started_at timestamptz,
    locked_until timestamptz,
    last_failed_at timestamptz,
    last_authenticated_at timestamptz,
    password_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (failed_attempts = 0 AND failure_window_started_at IS NULL)
        OR (failed_attempts > 0 AND failure_window_started_at IS NOT NULL)
    )
);

CREATE TABLE iam.login_rate_limits (
    network_hash bytea PRIMARY KEY CHECK (octet_length(network_hash) = 32),
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    window_started_at timestamptz NOT NULL,
    blocked_until timestamptz,
    last_failed_at timestamptz NOT NULL
);

CREATE INDEX login_rate_limits_cleanup_idx
ON iam.login_rate_limits (GREATEST(COALESCE(blocked_until, window_started_at), last_failed_at));

CREATE TABLE iam.sessions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
    password_version integer NOT NULL CHECK (password_version > 0),
    user_agent_hash bytea NOT NULL CHECK (octet_length(user_agent_hash) = 32),
    network_hash bytea NOT NULL CHECK (octet_length(network_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    idle_expires_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 128),
    CHECK (created_at <= last_seen_at),
    CHECK (last_seen_at < idle_expires_at),
    CHECK (idle_expires_at <= expires_at),
    CHECK (
        (revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    )
);

CREATE INDEX sessions_identity_active_idx
ON iam.sessions (identity_id, expires_at)
WHERE revoked_at IS NULL;

CREATE INDEX sessions_expiry_cleanup_idx
ON iam.sessions (LEAST(idle_expires_at, expires_at));

CREATE TABLE iam.owner_recovery_codes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
    generation integer NOT NULL CHECK (generation > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    used_at timestamptz,
    invalidated_at timestamptz,
    CHECK (used_at IS NULL OR invalidated_at IS NULL)
);

CREATE INDEX owner_recovery_codes_identity_active_idx
ON iam.owner_recovery_codes (identity_id, generation)
WHERE used_at IS NULL AND invalidated_at IS NULL;
