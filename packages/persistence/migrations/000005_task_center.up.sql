CREATE TABLE compute.job_events (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    event_kind text NOT NULL CHECK (event_kind IN (
        'state', 'progress', 'progress_reset', 'result',
        'retry_guidance', 'cancellation_requested'
    )),
    public_state text NOT NULL CHECK (public_state IN (
        'queued', 'preparing', 'running', 'completed', 'failed', 'cancelled'
    )),
    progress numeric(5,2) NOT NULL CHECK (progress BETWEEN 0 AND 100),
    progress_revision integer NOT NULL DEFAULT 1 CHECK (progress_revision > 0),
    message_key text NOT NULL CHECK (message_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    guidance_key text CHECK (guidance_key IS NULL OR guidance_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    retryable boolean,
    retry_action text CHECK (retry_action IS NULL OR retry_action ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((error_code IS NULL) = (guidance_key IS NULL)),
    CHECK (retry_action IS NULL OR retryable),
    CHECK (event_kind <> 'retry_guidance' OR error_code IS NOT NULL)
);

CREATE INDEX job_events_job_cursor_idx
ON compute.job_events (job_id, sequence_id);

CREATE TABLE platform.agent_operation_confirmations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    agent_session_key text NOT NULL CHECK (length(agent_session_key) BETWEEN 1 AND 256),
    operation_kind text NOT NULL CHECK (operation_kind ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    title_key text NOT NULL CHECK (title_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    operation_scope jsonb NOT NULL CHECK (jsonb_typeof(operation_scope) = 'object'),
    status text NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    decided_by_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    CHECK (expires_at > created_at),
    CHECK (
        (status = 'pending' AND decided_at IS NULL AND decided_by_identity_id IS NULL)
        OR (status IN ('approved', 'denied') AND decided_at IS NOT NULL AND decided_by_identity_id IS NOT NULL)
        OR (status IN ('expired', 'cancelled') AND decided_at IS NOT NULL)
    )
);

CREATE INDEX agent_confirmations_owner_pending_idx
ON platform.agent_operation_confirmations (owner_identity_id, expires_at)
WHERE status = 'pending';

CREATE INDEX agent_confirmations_session_idx
ON platform.agent_operation_confirmations (agent_session_key, created_at DESC);

