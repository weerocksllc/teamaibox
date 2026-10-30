-- Snapshot only nodes that existed before the production three-field
-- Provisioner became enforceable.  New rows default to requiring the exact
-- bootstrap/onboarding ledgers, so legacy enrollment APIs cannot manufacture
-- a grandfathered schedulable node after this migration commits.
ALTER TABLE compute.nodes
ADD COLUMN bootstrap_admission_required boolean;

UPDATE compute.nodes SET bootstrap_admission_required=FALSE;

ALTER TABLE compute.nodes
ALTER COLUMN bootstrap_admission_required SET DEFAULT TRUE,
ALTER COLUMN bootstrap_admission_required SET NOT NULL;

CREATE TABLE compute.node_bootstrap_coordinations (
    onboarding_id uuid PRIMARY KEY
        REFERENCES compute.node_onboarding_transactions(id) ON DELETE CASCADE,
    installation_id text NOT NULL CHECK (
        installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    manifest_digest bytea NOT NULL CHECK (octet_length(manifest_digest) = 32),
    node_key text NOT NULL CHECK (node_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    actor_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    state text NOT NULL CHECK (
        state IN (
            'validating', 'authorized', 'csr_pending', 'certificate_pending',
            'heartbeat_pending', 'ready', 'rolled_back', 'manual_recovery'
        )
    ),
    authorization_id uuid,
    enrollment_id uuid REFERENCES compute.node_enrollments(id) ON DELETE RESTRICT,
    authorization_expires_at timestamptz,
    public_key_fingerprint bytea CHECK (
        public_key_fingerprint IS NULL OR octet_length(public_key_fingerprint) = 32
    ),
    enrollment_revision bigint CHECK (enrollment_revision IS NULL OR enrollment_revision > 0),
    node_id uuid REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint CHECK (node_generation IS NULL OR node_generation > 0),
    certificate_fingerprint bytea CHECK (
        certificate_fingerprint IS NULL OR octet_length(certificate_fingerprint) = 32
    ),
    certificate_not_after timestamptz,
    lifecycle_state text CHECK (lifecycle_state IS NULL OR lifecycle_state IN ('joining', 'ready')),
    steady_state_transport text CHECK (
        steady_state_transport IS NULL OR steady_state_transport = 'signed_mtls_only'
    ),
    signed_command_channel_ready boolean NOT NULL DEFAULT false,
    bootstrap_authorization_closed boolean NOT NULL DEFAULT false,
    error_code text CHECK (
        error_code IS NULL OR error_code ~ '^node_(onboarding|enrollment|trust)_[a-z0-9_]{2,96}$'
    ),
    cleanup_state text NOT NULL DEFAULT 'not_started' CHECK (
        cleanup_state IN ('not_started', 'removed', 'incomplete', 'unreachable')
    ),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    UNIQUE (onboarding_id, installation_id),
    CONSTRAINT node_bootstrap_installation_identity_exact CHECK (
        installation_id = 'node-agent-install:' || onboarding_id::text
    ),
    CHECK (
        authorization_id IS NULL OR (
            enrollment_id IS NOT NULL
            AND authorization_id = enrollment_id
            AND authorization_expires_at IS NOT NULL
            AND public_key_fingerprint IS NOT NULL
        )
    ),
    CHECK (node_id IS NULL OR (enrollment_id IS NOT NULL AND node_generation IS NOT NULL)),
    CHECK (
        state <> 'ready' OR (
            node_id IS NOT NULL
            AND certificate_fingerprint IS NOT NULL
            AND certificate_not_after IS NOT NULL
            AND lifecycle_state IN ('joining', 'ready')
            AND steady_state_transport = 'signed_mtls_only'
            AND signed_command_channel_ready
            AND bootstrap_authorization_closed
            AND cleanup_state = 'removed'
            AND completed_at IS NOT NULL
            AND error_code IS NULL
        )
    ),
    CHECK (state <> 'rolled_back' OR cleanup_state = 'removed'),
    CHECK (state <> 'manual_recovery' OR cleanup_state IN ('removed', 'incomplete', 'unreachable')),
    CHECK (
        state <> 'rolled_back' OR authorization_id IS NULL OR bootstrap_authorization_closed
    ),
    CHECK (completed_at IS NULL OR state IN ('ready', 'rolled_back', 'manual_recovery')),
    CHECK ((state IN ('rolled_back', 'manual_recovery')) = (error_code IS NOT NULL))
);

CREATE INDEX node_bootstrap_coordinations_state_idx
ON compute.node_bootstrap_coordinations (state, updated_at, onboarding_id);

CREATE TABLE compute.node_bootstrap_orphans (
    orphan_id uuid PRIMARY KEY,
    onboarding_id uuid NOT NULL,
    installation_id text NOT NULL,
    node_id uuid REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    state text NOT NULL CHECK (state = 'manual_recovery'),
    cleanup_state text NOT NULL CHECK (cleanup_state IN ('incomplete', 'unreachable')),
    reason_code text NOT NULL CHECK (
        reason_code ~ '^node_(onboarding|enrollment|trust)_[a-z0-9_]{2,96}$'
    ),
    instructions jsonb NOT NULL CHECK (
        jsonb_typeof(instructions) = 'array' AND jsonb_array_length(instructions) BETWEEN 1 AND 16
    ),
    created_at timestamptz NOT NULL,
    UNIQUE (onboarding_id),
    FOREIGN KEY (onboarding_id, installation_id)
        REFERENCES compute.node_bootstrap_coordinations(onboarding_id, installation_id)
        ON DELETE CASCADE
);

CREATE INDEX node_bootstrap_orphans_created_idx
ON compute.node_bootstrap_orphans (created_at, orphan_id);

CREATE FUNCTION compute.reject_node_bootstrap_orphan_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'managed-node bootstrap orphan evidence is append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER node_bootstrap_orphans_append_only
BEFORE UPDATE OR DELETE ON compute.node_bootstrap_orphans
FOR EACH ROW EXECUTE FUNCTION compute.reject_node_bootstrap_orphan_mutation();

-- Claims and resolutions are an append-only operator ledger.  The orphan row
-- remains immutable evidence; a current claim is the latest non-expired
-- `claimed` action and a terminal resolution is the latest `resolved_*`
-- action.  This avoids mutating an incident record merely to make it disappear
-- from the administrator queue.
CREATE TABLE compute.node_bootstrap_orphan_actions (
    orphan_id uuid NOT NULL
        REFERENCES compute.node_bootstrap_orphans(orphan_id) ON DELETE RESTRICT,
    action_sequence bigint NOT NULL CHECK (action_sequence > 0),
    action_id uuid NOT NULL UNIQUE,
    action_type text NOT NULL CHECK (
        action_type IN ('claimed', 'claim_released', 'resolved_exact_cleanup', 'resolved_confirmed_absent')
    ),
    claim_id uuid NOT NULL,
    actor_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    claim_expires_at timestamptz,
    cleanup_proof_digest bytea CHECK (
        cleanup_proof_digest IS NULL OR octet_length(cleanup_proof_digest) = 32
    ),
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (orphan_id, action_sequence),
    CHECK (
        (action_type = 'claimed' AND claim_expires_at IS NOT NULL
            AND cleanup_proof_digest IS NULL)
        OR
        (action_type = 'claim_released' AND claim_expires_at IS NULL
            AND cleanup_proof_digest IS NULL)
        OR
        (action_type IN ('resolved_exact_cleanup', 'resolved_confirmed_absent')
            AND claim_expires_at IS NULL AND cleanup_proof_digest IS NOT NULL)
    )
);

CREATE INDEX node_bootstrap_orphan_actions_latest_idx
ON compute.node_bootstrap_orphan_actions (orphan_id, action_sequence DESC);

CREATE FUNCTION compute.reject_node_bootstrap_orphan_action_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'managed-node bootstrap orphan resolution ledger is append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER node_bootstrap_orphan_actions_append_only
BEFORE UPDATE OR DELETE ON compute.node_bootstrap_orphan_actions
FOR EACH ROW EXECUTE FUNCTION compute.reject_node_bootstrap_orphan_action_mutation();

-- Consumer-targeted audit events are delivered directly to the tamper-evident
-- audit sink.  Exclude them from the generic broker publisher so a broker
-- claim cannot race the audit relay and permanently consume the only durable
-- audit-pending record.
CREATE OR REPLACE FUNCTION platform.claim_outbox(
    p_publisher text,
    p_batch_size integer DEFAULT 100,
    p_claim_seconds integer DEFAULT 30
)
RETURNS SETOF platform.outbox_events
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_publisher !~ '^[a-z][a-z0-9._-]{2,127}$' THEN
        RAISE EXCEPTION 'invalid publisher identifier';
    END IF;
    IF p_batch_size < 1 OR p_batch_size > 1000 THEN
        RAISE EXCEPTION 'batch size must be between 1 and 1000';
    END IF;
    IF p_claim_seconds < 5 OR p_claim_seconds > 600 THEN
        RAISE EXCEPTION 'claim seconds must be between 5 and 600';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT event_id
        FROM platform.outbox_events
        WHERE published_at IS NULL
          AND available_at <= clock_timestamp()
          AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
          AND COALESCE(headers->>'consumer', '') <> 'tamper-evident-audit'
        ORDER BY available_at, occurred_at, event_id
        FOR UPDATE SKIP LOCKED
        LIMIT p_batch_size
    )
    UPDATE platform.outbox_events AS event
    SET claimed_by = p_publisher,
        claim_token = uuidv7(),
        claimed_until = clock_timestamp() + make_interval(secs => p_claim_seconds),
        publish_attempts = event.publish_attempts + 1,
        last_error = NULL
    FROM candidates
    WHERE event.event_id = candidates.event_id
    RETURNING event.*;
END;
$$;

-- A completed node must not keep the target-address admission lock. The node
-- and enrollment ledgers, rather than the transient address, are authoritative
-- after the verified first heartbeat.
DROP INDEX compute.node_onboarding_one_active_target_idx;
CREATE UNIQUE INDEX node_onboarding_one_active_target_idx
ON compute.node_onboarding_transactions (target_ip, ssh_port)
WHERE state NOT IN ('ready', 'manual_recovery', 'cancelled');
