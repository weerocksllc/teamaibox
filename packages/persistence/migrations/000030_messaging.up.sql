CREATE TABLE platform.messaging_conversations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    conversation_kind text NOT NULL CHECK (conversation_kind IN ('direct', 'group')),
    title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 160),
    team_key text CHECK (team_key IS NULL OR team_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    direct_key bytea UNIQUE CHECK (direct_key IS NULL OR octet_length(direct_key) = 32),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    last_message_sequence bigint NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (conversation_kind = 'direct' AND title IS NULL AND team_key IS NULL AND direct_key IS NOT NULL)
        OR (conversation_kind = 'group' AND title IS NOT NULL AND direct_key IS NULL)
    )
);

CREATE INDEX messaging_conversations_updated_idx
ON platform.messaging_conversations (updated_at DESC, id);

CREATE TRIGGER messaging_conversations_touch_updated_at
BEFORE UPDATE ON platform.messaging_conversations
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE platform.messaging_participants (
    conversation_id uuid NOT NULL REFERENCES platform.messaging_conversations(id) ON DELETE CASCADE,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    participant_role text NOT NULL CHECK (participant_role IN ('owner', 'admin', 'member')),
    joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    left_at timestamptz,
    last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
    notification_level text NOT NULL DEFAULT 'all' CHECK (notification_level IN ('all', 'mentions', 'muted')),
    PRIMARY KEY (conversation_id, identity_id),
    CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE INDEX messaging_participants_identity_active_idx
ON platform.messaging_participants (identity_id, conversation_id)
WHERE left_at IS NULL;

CREATE TABLE platform.messaging_messages (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    conversation_id uuid NOT NULL REFERENCES platform.messaging_conversations(id) ON DELETE CASCADE,
    message_sequence bigint NOT NULL CHECK (message_sequence > 0),
    author_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    author_kind text NOT NULL CHECK (author_kind IN ('user', 'application')),
    application_key text CHECK (application_key IS NULL OR application_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    content text NOT NULL CHECK (length(content) <= 32000),
    reply_to_message_id uuid REFERENCES platform.messaging_messages(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    edited_at timestamptz,
    deleted_at timestamptz,
    UNIQUE (conversation_id, message_sequence),
    UNIQUE (conversation_id, author_identity_id, idempotency_key),
    CHECK ((author_kind = 'user' AND application_key IS NULL) OR (author_kind = 'application' AND application_key IS NOT NULL)),
    CHECK (edited_at IS NULL OR edited_at >= created_at),
    CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX messaging_messages_history_idx
ON platform.messaging_messages (conversation_id, message_sequence);

CREATE INDEX messaging_messages_search_scope_idx
ON platform.messaging_messages (conversation_id, created_at DESC, id)
WHERE deleted_at IS NULL;

CREATE TABLE platform.messaging_attachments (
    message_id uuid NOT NULL REFERENCES platform.messaging_messages(id) ON DELETE CASCADE,
    attachment_ordinal smallint NOT NULL CHECK (attachment_ordinal BETWEEN 1 AND 16),
    object_id uuid NOT NULL,
    object_version integer NOT NULL CHECK (object_version > 0),
    filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 1024),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    PRIMARY KEY (message_id, attachment_ordinal),
    FOREIGN KEY (object_id, object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT
);

CREATE INDEX messaging_attachments_object_idx
ON platform.messaging_attachments (object_id, object_version, message_id);

CREATE TABLE platform.messaging_delivery_receipts (
    message_id uuid NOT NULL REFERENCES platform.messaging_messages(id) ON DELETE CASCADE,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    delivery_state text NOT NULL CHECK (delivery_state IN ('queued', 'delivered', 'read')),
    delivered_at timestamptz,
    read_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (message_id, identity_id),
    CHECK (
        (delivery_state = 'queued' AND delivered_at IS NULL AND read_at IS NULL)
        OR (delivery_state = 'delivered' AND delivered_at IS NOT NULL AND read_at IS NULL)
        OR (delivery_state = 'read' AND delivered_at IS NOT NULL AND read_at IS NOT NULL)
    ),
    CHECK (read_at IS NULL OR read_at >= delivered_at)
);

CREATE INDEX messaging_delivery_identity_state_idx
ON platform.messaging_delivery_receipts (identity_id, delivery_state, updated_at DESC);

CREATE TABLE platform.messaging_notifications (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES platform.messaging_conversations(id) ON DELETE CASCADE,
    message_id uuid REFERENCES platform.messaging_messages(id) ON DELETE CASCADE,
    notification_kind text NOT NULL CHECK (notification_kind IN ('message', 'mention', 'membership')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz,
    CHECK (read_at IS NULL OR read_at >= created_at)
);

CREATE INDEX messaging_notifications_identity_unread_idx
ON platform.messaging_notifications (identity_id, created_at DESC, id)
WHERE read_at IS NULL;

CREATE TABLE platform.messaging_events (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    conversation_id uuid REFERENCES platform.messaging_conversations(id) ON DELETE CASCADE,
    message_id uuid REFERENCES platform.messaging_messages(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK (event_type IN (
        'conversation.created', 'conversation.participant_added', 'conversation.participant_removed',
        'message.created', 'message.edited', 'message.deleted', 'message.delivered', 'message.read'
    )),
    audience_identity_ids uuid[] NOT NULL CHECK (cardinality(audience_identity_ids) BETWEEN 1 AND 500),
    author_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    event_data jsonb NOT NULL CHECK (jsonb_typeof(event_data) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX messaging_events_audience_cursor_idx
ON platform.messaging_events (sequence_id);

CREATE TABLE platform.messaging_presence (
    identity_id uuid PRIMARY KEY REFERENCES iam.identities(id) ON DELETE CASCADE,
    presence_state text NOT NULL CHECK (presence_state IN ('online', 'away', 'offline')),
    connection_count integer NOT NULL DEFAULT 0 CHECK (connection_count >= 0),
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    CHECK (
        (presence_state = 'offline' AND connection_count = 0 AND expires_at IS NULL)
        OR (presence_state IN ('online', 'away') AND connection_count > 0 AND expires_at > last_seen_at)
    )
);

CREATE INDEX messaging_presence_expiry_idx
ON platform.messaging_presence (expires_at)
WHERE expires_at IS NOT NULL;

CREATE TABLE platform.messaging_presence_connections (
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    presence_state text NOT NULL CHECK (presence_state IN ('online', 'away')),
    last_seen_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > last_seen_at),
    PRIMARY KEY (identity_id, connection_id)
);

CREATE INDEX messaging_presence_connections_expiry_idx
ON platform.messaging_presence_connections (expires_at);
