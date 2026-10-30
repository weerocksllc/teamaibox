ALTER TABLE platform.agent_operation_confirmations
    ADD COLUMN bridge_schema_version integer NOT NULL DEFAULT 0 CHECK (bridge_schema_version IN (0, 1)),
    ADD COLUMN binding_id uuid REFERENCES platform.agent_session_bindings(id) ON DELETE CASCADE,
    ADD COLUMN prompt_id uuid REFERENCES platform.agent_prompts(id) ON DELETE CASCADE,
    ADD COLUMN upstream_request_id text,
    ADD COLUMN tool_name text,
    ADD COLUMN action_digest bytea CHECK (action_digest IS NULL OR octet_length(action_digest) = 32),
    ADD COLUMN side_effect_class text CHECK (side_effect_class IS NULL OR side_effect_class IN ('none', 'idempotent', 'non_idempotent')),
    ADD COLUMN policy_id text,
    ADD COLUMN policy_revision bigint CHECK (policy_revision IS NULL OR policy_revision > 0),
    ADD COLUMN policy_disposition text CHECK (policy_disposition IS NULL OR policy_disposition IN ('allow', 'confirm', 'deny')),
    ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'pending' CHECK (lifecycle_state IN (
        'pending', 'dispatching', 'approved', 'denied', 'timed_out', 'interrupted',
        'executing', 'executed', 'failed', 'reconcile_required', 'reconciled'
    )),
    ADD COLUMN upstream_reply_state text NOT NULL DEFAULT 'none' CHECK (upstream_reply_state IN ('none', 'dispatching', 'accepted', 'unknown', 'rejected')),
    ADD COLUMN execution_boundary text NOT NULL DEFAULT 'none' CHECK (execution_boundary IN ('none', 'unknown', 'accepted')),
    ADD COLUMN decision_kind text CHECK (decision_kind IS NULL OR decision_kind IN ('approve', 'deny', 'policy_allow', 'policy_deny', 'timeout', 'interrupt')),
    ADD COLUMN authentication_event_id uuid,
    ADD COLUMN authentication_proof_digest bytea CHECK (authentication_proof_digest IS NULL OR octet_length(authentication_proof_digest) = 32),
    ADD COLUMN authenticated_at timestamptz,
    ADD COLUMN reconciliation_outcome text CHECK (reconciliation_outcome IS NULL OR reconciliation_outcome IN ('executed', 'not_executed', 'abandoned')),
    ADD COLUMN reconciliation_reason_code text,
    ADD COLUMN result_digest bytea CHECK (result_digest IS NULL OR octet_length(result_digest) = 32),
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD CONSTRAINT agent_operation_confirmations_bridge_fields_check CHECK (
        bridge_schema_version = 0 OR (
            binding_id IS NOT NULL AND prompt_id IS NOT NULL AND upstream_request_id IS NOT NULL
            AND upstream_request_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'
            AND tool_name IS NOT NULL AND tool_name ~ '^[a-z][a-z0-9_.-]{1,127}$'
            AND action_digest IS NOT NULL AND side_effect_class IS NOT NULL
            AND policy_id IS NOT NULL AND policy_revision IS NOT NULL AND policy_disposition IS NOT NULL
        )
    ),
    ADD CONSTRAINT agent_operation_confirmations_decision_evidence_check CHECK (
        (decision_kind IS NULL AND authentication_event_id IS NULL AND authentication_proof_digest IS NULL AND authenticated_at IS NULL)
        OR (decision_kind IN ('policy_allow', 'policy_deny', 'timeout', 'interrupt'))
        OR (decision_kind IN ('approve', 'deny') AND authentication_event_id IS NOT NULL
            AND authentication_proof_digest IS NOT NULL AND authenticated_at IS NOT NULL
            AND decided_by_identity_id = owner_identity_id)
    ),
    ADD CONSTRAINT agent_operation_confirmations_reconciliation_check CHECK (
        (lifecycle_state = 'reconciled' AND reconciliation_outcome IS NOT NULL)
        OR (lifecycle_state <> 'reconciled' AND reconciliation_outcome IS NULL)
    );

CREATE UNIQUE INDEX agent_confirmation_upstream_request_idx
ON platform.agent_operation_confirmations (binding_id, upstream_request_id)
WHERE bridge_schema_version = 1;

CREATE INDEX agent_confirmation_lifecycle_deadline_idx
ON platform.agent_operation_confirmations (lifecycle_state, expires_at, id)
WHERE bridge_schema_version = 1 AND lifecycle_state IN ('pending', 'dispatching', 'approved', 'executing', 'reconcile_required');

CREATE TRIGGER agent_operation_confirmations_touch_updated_at
BEFORE UPDATE ON platform.agent_operation_confirmations
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
