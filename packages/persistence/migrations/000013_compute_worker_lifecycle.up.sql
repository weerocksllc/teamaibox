CREATE TABLE compute.worker_instances (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    compute_plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE RESTRICT,
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    image_reference text NOT NULL CHECK (
        image_reference ~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'
    ),
    architecture text NOT NULL CHECK (architecture IN ('linux/arm64/v8', 'linux/amd64')),
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    lifecycle_state text NOT NULL DEFAULT 'stopped' CHECK (
        lifecycle_state IN (
            'stopped', 'starting', 'preparing', 'ready', 'busy',
            'draining', 'stopping', 'failed', 'circuit_open'
        )
    ),
    health_state text NOT NULL DEFAULT 'unknown' CHECK (
        health_state IN ('unknown', 'starting', 'healthy', 'degraded', 'unhealthy')
    ),
    health_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    health_generation bigint NOT NULL DEFAULT 1 CHECK (health_generation > 0),
    health_reason_code text CHECK (
        health_reason_code IS NULL OR health_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    resources jsonb NOT NULL CHECK (
        jsonb_typeof(resources) = 'object'
        AND resources ?& ARRAY[
            'cpuMillis', 'unifiedMemoryBytes', 'storageBytes',
            'networkBitsPerSecond', 'acceleratorUnits', 'codecSessions'
        ]
    ),
    max_concurrent_attempts integer NOT NULL DEFAULT 1 CHECK (
        max_concurrent_attempts BETWEEN 1 AND 1024
    ),
    active_attempt_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    attempt_states jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
        jsonb_typeof(attempt_states) = 'object'
    ),
    reservation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    control_lease_id uuid NOT NULL,
    control_fencing_token bigint NOT NULL CHECK (control_fencing_token > 0),
    loaded_at timestamptz,
    last_heartbeat_at timestamptz,
    idle_since timestamptz,
    crash_timestamps timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[],
    crash_count integer NOT NULL DEFAULT 0 CHECK (crash_count >= 0),
    next_retry_at timestamptz,
    circuit_open_until timestamptz,
    last_failure_code text CHECK (
        last_failure_code IS NULL OR last_failure_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (health_generation <= generation),
    CHECK (cardinality(active_attempt_ids) <= max_concurrent_attempts),
    CHECK (crash_count = cardinality(crash_timestamps)),
    CHECK (
        (lifecycle_state = 'busy' AND cardinality(active_attempt_ids) > 0)
        OR (lifecycle_state <> 'busy' AND cardinality(active_attempt_ids) = 0)
    ),
    CHECK (
        (lifecycle_state = 'circuit_open' AND circuit_open_until IS NOT NULL AND next_retry_at = circuit_open_until)
        OR (lifecycle_state <> 'circuit_open' AND circuit_open_until IS NULL)
    ),
    CHECK (
        lifecycle_state NOT IN ('ready', 'busy')
        OR (health_state = 'healthy' AND loaded_at IS NOT NULL)
    )
);

CREATE INDEX worker_instances_profile_warm_idx
ON compute.worker_instances (model_profile_id, node_id, lifecycle_state, idle_since)
WHERE lifecycle_state IN ('ready', 'busy');

CREATE INDEX worker_instances_retry_idx
ON compute.worker_instances (lifecycle_state, next_retry_at)
WHERE lifecycle_state IN ('failed', 'circuit_open');

CREATE TRIGGER worker_instances_touch_updated_at
BEFORE UPDATE ON compute.worker_instances
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
