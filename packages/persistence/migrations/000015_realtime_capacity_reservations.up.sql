CREATE TABLE compute.realtime_sessions (
    id uuid PRIMARY KEY,
    admission_key uuid NOT NULL UNIQUE,
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    correlation_id text CHECK (
        correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    capability_key text NOT NULL CHECK (
        capability_key IN ('asr', 'translation', 'codec', 'webrtc-gateway')
    ),
    requested_model text CHECK (
        requested_model IS NULL OR (length(requested_model) BETWEEN 1 AND 512 AND requested_model !~ '[[:space:][:cntrl:]]')
    ),
    model_profile_id uuid REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    route text NOT NULL CHECK (route IN ('local', 'managed_node')),
    state text NOT NULL DEFAULT 'admitted' CHECK (
        state IN ('admitted', 'connected', 'released', 'expired', 'revoked')
    ),
    priority_class text NOT NULL DEFAULT 'latency' CHECK (priority_class = 'latency'),
    scheduler_priority smallint NOT NULL DEFAULT 100 CHECK (scheduler_priority = 100),
    latency_budget_milliseconds integer NOT NULL CHECK (
        latency_budget_milliseconds BETWEEN 10 AND 10000
    ),
    reservation jsonb NOT NULL CHECK (
        jsonb_typeof(reservation) = 'object'
        AND reservation ?& ARRAY[
            'cpuMillis', 'unifiedMemoryBytes', 'acceleratorUnits',
            'codecSessions', 'storageBytes', 'networkBitsPerSecond'
        ]
    ),
    codec_directions jsonb NOT NULL CHECK (
        jsonb_typeof(codec_directions) = 'object'
        AND codec_directions ?& ARRAY['encodeSessions', 'decodeSessions']
        AND (codec_directions->>'encodeSessions')::bigint >= 0
        AND (codec_directions->>'decodeSessions')::bigint >= 0
    ),
    lease_token uuid NOT NULL UNIQUE,
    fencing_token bigint NOT NULL CHECK (fencing_token > 0),
    connection_id uuid UNIQUE,
    admitted_at timestamptz NOT NULL,
    connection_deadline_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    connected_at timestamptz,
    heartbeat_at timestamptz NOT NULL,
    released_at timestamptz,
    release_reason text CHECK (
        release_reason IS NULL OR release_reason ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (connection_deadline_at > admitted_at),
    CHECK (connection_deadline_at <= expires_at),
    CHECK (expires_at > admitted_at),
    CHECK (heartbeat_at >= admitted_at),
    CHECK (
        (state = 'admitted' AND connection_id IS NULL AND connected_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
        OR (state = 'connected' AND connection_id IS NOT NULL AND connected_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL)
        OR (state IN ('released', 'expired', 'revoked') AND released_at IS NOT NULL AND release_reason IS NOT NULL)
    )
);

CREATE INDEX realtime_sessions_node_capacity_idx
ON compute.realtime_sessions (node_id, state, expires_at)
WHERE state IN ('admitted', 'connected');

CREATE INDEX realtime_sessions_expiry_idx
ON compute.realtime_sessions (expires_at, connection_deadline_at)
WHERE state IN ('admitted', 'connected');

CREATE INDEX realtime_sessions_owner_idx
ON compute.realtime_sessions (owner_identity_id, admitted_at DESC);

CREATE TRIGGER realtime_sessions_touch_updated_at
BEFORE UPDATE ON compute.realtime_sessions
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
