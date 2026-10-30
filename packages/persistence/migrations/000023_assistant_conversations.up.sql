CREATE TABLE platform.assistant_conversations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 160),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX assistant_conversations_owner_updated_idx
ON platform.assistant_conversations (owner_identity_id, updated_at DESC, id);

CREATE TRIGGER assistant_conversations_touch_updated_at
BEFORE UPDATE ON platform.assistant_conversations
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE platform.assistant_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    conversation_id uuid NOT NULL REFERENCES platform.assistant_conversations(id) ON DELETE CASCADE,
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    user_message_id uuid NOT NULL,
    assistant_message_id uuid NOT NULL,
    requested_mode text NOT NULL CHECK (requested_mode IN ('auto', 'answer', 'agent')),
    effective_mode text NOT NULL CHECK (effective_mode IN ('answer', 'agent')),
    status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    routing jsonb NOT NULL CHECK (jsonb_typeof(routing) = 'object'),
    idempotency_key text NOT NULL CHECK (
        idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    ),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    pending_confirmation_id uuid REFERENCES platform.agent_operation_confirmations(id) ON DELETE SET NULL,
    terminal_error jsonb CHECK (terminal_error IS NULL OR jsonb_typeof(terminal_error) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    completed_at timestamptz,
    UNIQUE (owner_identity_id, conversation_id, idempotency_key),
    UNIQUE (conversation_id, user_message_id),
    UNIQUE (conversation_id, assistant_message_id),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        (status IN ('queued', 'running') AND completed_at IS NULL)
        OR (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    )
);

CREATE INDEX assistant_runs_owner_status_idx
ON platform.assistant_runs (owner_identity_id, status, created_at DESC);

CREATE TABLE platform.assistant_messages (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES platform.assistant_conversations(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES platform.assistant_runs(id) ON DELETE CASCADE,
    message_ordinal bigint NOT NULL CHECK (message_ordinal > 0),
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    content text NOT NULL CHECK (length(content) <= 512000),
    requested_mode text NOT NULL CHECK (requested_mode IN ('auto', 'answer', 'agent')),
    effective_mode text NOT NULL CHECK (effective_mode IN ('answer', 'agent')),
    status text NOT NULL CHECK (status IN ('streaming', 'completed', 'failed', 'cancelled')),
    artifacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifacts) = 'array'),
    sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
    tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array'),
    routing jsonb CHECK (routing IS NULL OR jsonb_typeof(routing) = 'object'),
    usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    UNIQUE (conversation_id, id),
    UNIQUE (conversation_id, message_ordinal),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        (status = 'streaming' AND completed_at IS NULL)
        OR (status IN ('completed', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    )
);

ALTER TABLE platform.assistant_runs
ADD CONSTRAINT assistant_runs_user_message_fk
FOREIGN KEY (conversation_id, user_message_id)
REFERENCES platform.assistant_messages(conversation_id, id)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE platform.assistant_runs
ADD CONSTRAINT assistant_runs_assistant_message_fk
FOREIGN KEY (conversation_id, assistant_message_id)
REFERENCES platform.assistant_messages(conversation_id, id)
DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX assistant_messages_conversation_created_idx
ON platform.assistant_messages (conversation_id, message_ordinal);

CREATE TABLE platform.assistant_events (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    conversation_id uuid NOT NULL REFERENCES platform.assistant_conversations(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES platform.assistant_runs(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN (
        'message.created', 'message.completed', 'run.created', 'run.started',
        'run.completed', 'run.failed', 'run.cancelled', 'routing.selected',
        'response.delta', 'tool.started', 'tool.completed', 'artifact.created',
        'usage.updated', 'source.cited', 'confirmation.requested', 'confirmation.resolved'
    )),
    event_data jsonb NOT NULL CHECK (jsonb_typeof(event_data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX assistant_events_conversation_cursor_idx
ON platform.assistant_events (conversation_id, sequence_id);
