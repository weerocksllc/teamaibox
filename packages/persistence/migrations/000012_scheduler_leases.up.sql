CREATE TABLE compute.node_lease_fences (
    node_id uuid PRIMARY KEY REFERENCES compute.nodes(id) ON DELETE CASCADE,
    next_fencing_token bigint NOT NULL DEFAULT 1 CHECK (next_fencing_token > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE compute.lease_sets (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    acquisition_key uuid NOT NULL UNIQUE,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL UNIQUE REFERENCES compute.attempts(id) ON DELETE CASCADE,
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    lease_token uuid NOT NULL UNIQUE,
    fencing_token bigint NOT NULL CHECK (fencing_token > 0),
    state text NOT NULL DEFAULT 'active' CHECK (
        state IN ('active', 'released', 'expired', 'revoked')
    ),
    dispatch_state text NOT NULL DEFAULT 'pending' CHECK (
        dispatch_state IN ('pending', 'claimed', 'accepted', 'reconcile_required', 'cancelled')
    ),
    dispatch_id uuid UNIQUE,
    reservation jsonb NOT NULL CHECK (
        jsonb_typeof(reservation) = 'object'
        AND reservation ?& ARRAY[
            'cpuMillis', 'unifiedMemoryBytes', 'acceleratorUnits',
            'codecSessions', 'storageBytes', 'networkBitsPerSecond'
        ]
    ),
    acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    dispatched_at timestamptz,
    accepted_at timestamptz,
    released_at timestamptz,
    release_reason text CHECK (
        release_reason IS NULL OR release_reason ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
    reconciliation_count bigint NOT NULL DEFAULT 0 CHECK (reconciliation_count >= 0),
    last_reconciled_at timestamptz,
    CHECK (expires_at > acquired_at),
    CHECK (heartbeat_at >= acquired_at),
    CHECK (
        (state = 'active' AND released_at IS NULL)
        OR (state <> 'active' AND released_at IS NOT NULL)
    ),
    CHECK (
        (dispatch_state = 'pending' AND dispatch_id IS NULL AND dispatched_at IS NULL AND accepted_at IS NULL)
        OR (dispatch_state = 'claimed' AND dispatch_id IS NOT NULL AND dispatched_at IS NOT NULL AND accepted_at IS NULL)
        OR (dispatch_state = 'accepted' AND dispatch_id IS NOT NULL AND dispatched_at IS NOT NULL AND accepted_at IS NOT NULL)
        OR dispatch_state IN ('reconcile_required', 'cancelled')
    )
);

CREATE UNIQUE INDEX lease_sets_one_active_job_idx
ON compute.lease_sets (job_id)
WHERE state = 'active';

CREATE INDEX lease_sets_node_capacity_idx
ON compute.lease_sets (node_id, state, expires_at);

CREATE INDEX lease_sets_reconciliation_idx
ON compute.lease_sets (state, expires_at, node_id)
WHERE state = 'active';

ALTER TABLE compute.jobs
ADD COLUMN current_attempt_id uuid
REFERENCES compute.attempts(id) ON DELETE SET NULL;

DROP INDEX compute.leases_one_active_resource_idx;

ALTER TABLE compute.leases
DROP CONSTRAINT leases_resource_kind_check;

ALTER TABLE compute.leases
ADD CONSTRAINT leases_resource_kind_check CHECK (
    resource_kind IN (
        'node', 'cpu', 'unified_memory', 'accelerator', 'codec',
        'storage', 'network', 'worker', 'realtime', 'exclusive'
    )
);

ALTER TABLE compute.leases
    ADD COLUMN lease_set_id uuid REFERENCES compute.lease_sets(id) ON DELETE CASCADE,
    ADD COLUMN node_id uuid REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    ADD COLUMN amount bigint NOT NULL DEFAULT 0 CHECK (amount >= 0);

CREATE UNIQUE INDEX leases_one_active_exclusive_resource_idx
ON compute.leases (resource_kind, resource_key)
WHERE state = 'active' AND resource_kind IN ('worker', 'realtime', 'exclusive');

CREATE INDEX leases_active_node_resource_idx
ON compute.leases (node_id, resource_kind, state)
WHERE state = 'active';

CREATE UNIQUE INDEX leases_set_resource_idx
ON compute.leases (lease_set_id, resource_kind)
WHERE lease_set_id IS NOT NULL;

