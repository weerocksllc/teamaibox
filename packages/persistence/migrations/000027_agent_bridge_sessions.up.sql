CREATE TABLE platform.agent_session_bindings (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    platform_conversation_id uuid NOT NULL REFERENCES platform.assistant_conversations(id) ON DELETE CASCADE,
    workspace_key text NOT NULL CHECK (workspace_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    sandbox_key text NOT NULL CHECK (sandbox_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    adapter_key text NOT NULL CHECK (adapter_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    upstream_version text NOT NULL CHECK (length(upstream_version) BETWEEN 1 AND 64),
    upstream_artifact_digest bytea NOT NULL CHECK (octet_length(upstream_artifact_digest) = 32),
    opencode_session_id text NOT NULL CHECK (opencode_session_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'reconciling', 'terminal')),
    crash_generation bigint NOT NULL DEFAULT 0 CHECK (crash_generation >= 0),
    event_tail_sequence bigint NOT NULL DEFAULT 0 CHECK (event_tail_sequence >= 0),
    terminal jsonb CHECK (terminal IS NULL OR jsonb_typeof(terminal) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reconciled_at timestamptz,
    UNIQUE (owner_identity_id, platform_conversation_id),
    UNIQUE (sandbox_key, opencode_session_id),
    CHECK ((state = 'terminal' AND terminal IS NOT NULL) OR (state <> 'terminal' AND terminal IS NULL))
);

CREATE TRIGGER agent_session_bindings_touch_updated_at
BEFORE UPDATE ON platform.agent_session_bindings
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE INDEX agent_session_bindings_sandbox_state_idx
ON platform.agent_session_bindings (sandbox_key, state, updated_at DESC);

CREATE TABLE platform.agent_prompts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    binding_id uuid NOT NULL REFERENCES platform.agent_session_bindings(id) ON DELETE CASCADE,
    platform_run_id uuid NOT NULL UNIQUE REFERENCES platform.assistant_runs(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    opencode_message_id text NOT NULL CHECK (opencode_message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
    status text NOT NULL DEFAULT 'admitted' CHECK (status IN (
        'admitted', 'submitting', 'accepted', 'running', 'completed', 'failed',
        'cancelled', 'reconcile_required', 'incomplete'
    )),
    acceptance_boundary text NOT NULL DEFAULT 'none' CHECK (acceptance_boundary IN ('none', 'unknown', 'accepted')),
    terminal jsonb CHECK (terminal IS NULL OR jsonb_typeof(terminal) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    submitted_at timestamptz,
    accepted_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (binding_id, idempotency_key),
    UNIQUE (binding_id, opencode_message_id),
    CHECK ((status IN ('completed', 'failed', 'cancelled', 'incomplete') AND terminal IS NOT NULL AND completed_at IS NOT NULL)
        OR (status NOT IN ('completed', 'failed', 'cancelled', 'incomplete') AND terminal IS NULL AND completed_at IS NULL)),
    CHECK (status <> 'submitting' OR acceptance_boundary = 'unknown'),
    CHECK (status NOT IN ('accepted', 'running', 'completed') OR acceptance_boundary = 'accepted')
);

CREATE TRIGGER agent_prompts_touch_updated_at
BEFORE UPDATE ON platform.agent_prompts
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE INDEX agent_prompts_binding_status_idx
ON platform.agent_prompts (binding_id, status, updated_at DESC);

CREATE TABLE platform.agent_events (
    event_id uuid NOT NULL DEFAULT uuidv7() UNIQUE,
    binding_id uuid NOT NULL REFERENCES platform.agent_session_bindings(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence > 0),
    prompt_id uuid REFERENCES platform.agent_prompts(id) ON DELETE SET NULL,
    connection_id uuid NOT NULL,
    connection_ordinal bigint NOT NULL CHECK (connection_ordinal > 0),
    upstream_event_id text,
    event_type text NOT NULL CHECK (event_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$'),
    event_data jsonb NOT NULL CHECK (jsonb_typeof(event_data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (binding_id, sequence),
    UNIQUE (binding_id, connection_id, connection_ordinal)
);

CREATE INDEX agent_events_prompt_sequence_idx
ON platform.agent_events (prompt_id, sequence) WHERE prompt_id IS NOT NULL;

CREATE TABLE platform.agent_crash_reconciliations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    binding_id uuid NOT NULL REFERENCES platform.agent_session_bindings(id) ON DELETE CASCADE,
    crash_generation bigint NOT NULL CHECK (crash_generation > 0),
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
    reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    upstream_session_exists boolean,
    accepted_message_ids jsonb CHECK (accepted_message_ids IS NULL OR jsonb_typeof(accepted_message_ids) = 'array'),
    outcome jsonb CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    resolved_at timestamptz,
    UNIQUE (binding_id, crash_generation),
    CHECK ((state = 'open' AND resolved_at IS NULL AND outcome IS NULL)
        OR (state = 'resolved' AND resolved_at IS NOT NULL AND outcome IS NOT NULL))
);

CREATE UNIQUE INDEX agent_one_open_reconciliation_idx
ON platform.agent_crash_reconciliations (binding_id) WHERE state = 'open';
