CREATE TABLE compute.node_onboarding_transactions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    target_ip inet NOT NULL,
    ssh_username text NOT NULL CHECK (
        ssh_username ~ '^[a-z_][a-z0-9_-]{0,31}$'
        AND ssh_username <> 'root'
    ),
    ssh_port integer NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
    authentication_mode text NOT NULL DEFAULT 'password' CHECK (
        authentication_mode IN ('password', 'password_with_one_time_key')
    ),
    state text NOT NULL CHECK (
        state IN (
            'awaiting_host_key_confirmation', 'credential_required',
            'credential_handoff', 'preflight', 'installing', 'enrolling',
            'heartbeat', 'ready', 'blocked', 'rollback',
            'manual_recovery', 'cancelled'
        )
    ),
    host_key_algorithm text NOT NULL CHECK (
        host_key_algorithm IN (
            'ssh-ed25519', 'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'
        )
    ),
    host_public_key text NOT NULL CHECK (
        length(host_public_key) BETWEEN 16 AND 16384
        AND host_public_key ~ '^[A-Za-z0-9+/]+={0,2}$'
    ),
    host_key_fingerprint_sha256 text NOT NULL CHECK (
        host_key_fingerprint_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'
    ),
    out_of_band_comparison text CHECK (
        out_of_band_comparison IN ('matched', 'not_available')
    ),
    error_code text CHECK (
        error_code IS NULL OR error_code ~ '^node_onboarding_[a-z0-9_]{2,96}$'
    ),
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    node_id uuid REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    host_key_confirmed_at timestamptz,
    credential_handed_off_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (family(target_ip) IN (4, 6)),
    CHECK (
        (host_key_confirmed_at IS NULL AND out_of_band_comparison IS NULL)
        OR (host_key_confirmed_at IS NOT NULL AND out_of_band_comparison IS NOT NULL)
    ),
    CHECK (credential_handed_off_at IS NULL OR host_key_confirmed_at IS NOT NULL),
    CHECK (
        (state IN ('credential_required', 'blocked', 'manual_recovery') AND error_code IS NOT NULL)
        OR (state NOT IN ('credential_required', 'blocked', 'manual_recovery') AND error_code IS NULL)
    ),
    CHECK (completed_at IS NULL OR state IN ('ready', 'manual_recovery', 'cancelled'))
);

CREATE UNIQUE INDEX node_onboarding_one_active_target_idx
ON compute.node_onboarding_transactions (target_ip, ssh_port)
WHERE state NOT IN ('manual_recovery', 'cancelled');

CREATE INDEX node_onboarding_progress_idx
ON compute.node_onboarding_transactions (state, updated_at, id);

CREATE TRIGGER node_onboarding_transactions_touch_updated_at
BEFORE UPDATE ON compute.node_onboarding_transactions
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.node_onboarding_events (
    onboarding_id uuid NOT NULL
        REFERENCES compute.node_onboarding_transactions(id) ON DELETE CASCADE,
    event_sequence bigint NOT NULL CHECK (event_sequence > 0),
    event_type text NOT NULL CHECK (
        event_type IN (
            'host_key_observed', 'credential_handoff_started',
            'credential_handoff_accepted', 'credential_handoff_failed',
            'preflight_started', 'preflight_completed', 'installation_started',
            'enrollment_started', 'heartbeat_observed', 'ready', 'blocked',
            'rollback_started', 'manual_recovery_required', 'cancelled'
        )
    ),
    state text NOT NULL CHECK (
        state IN (
            'awaiting_host_key_confirmation', 'credential_required',
            'credential_handoff', 'preflight', 'installing', 'enrolling',
            'heartbeat', 'ready', 'blocked', 'rollback',
            'manual_recovery', 'cancelled'
        )
    ),
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    error_code text CHECK (
        error_code IS NULL OR error_code ~ '^node_onboarding_[a-z0-9_]{2,96}$'
    ),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (onboarding_id, event_sequence),
    CHECK (
        (event_type IN ('credential_handoff_failed', 'blocked', 'manual_recovery_required') AND error_code IS NOT NULL)
        OR (event_type NOT IN ('credential_handoff_failed', 'blocked', 'manual_recovery_required') AND error_code IS NULL)
    )
);

CREATE INDEX node_onboarding_events_time_idx
ON compute.node_onboarding_events (occurred_at, onboarding_id, event_sequence);

CREATE FUNCTION compute.reject_node_onboarding_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'node onboarding events are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER node_onboarding_events_append_only
BEFORE UPDATE OR DELETE ON compute.node_onboarding_events
FOR EACH ROW EXECUTE FUNCTION compute.reject_node_onboarding_event_mutation();
