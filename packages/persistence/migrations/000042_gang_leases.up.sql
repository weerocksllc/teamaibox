CREATE TABLE compute.distributed_profile_certifications (
    id uuid PRIMARY KEY,
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    profile_fingerprint bytea NOT NULL CHECK (octet_length(profile_fingerprint) = 32),
    topology_digest bytea NOT NULL CHECK (octet_length(topology_digest) = 32),
    environment_digest bytea NOT NULL CHECK (octet_length(environment_digest) = 32),
    readiness_evidence_digest bytea NOT NULL CHECK (octet_length(readiness_evidence_digest) = 32),
    network_class text NOT NULL CHECK (network_class = 'connectx_roce'),
    collective text NOT NULL CHECK (collective = 'all-reduce'),
    minimum_nodes integer NOT NULL CHECK (minimum_nodes BETWEEN 2 AND 16),
    maximum_nodes integer NOT NULL CHECK (maximum_nodes BETWEEN 2 AND 16),
    state text NOT NULL CHECK (
        state IN ('validating', 'certified', 'revalidation_required', 'failed')
    ),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    certified_at timestamptz,
    created_at timestamptz NOT NULL,
    UNIQUE (
        model_profile_id, profile_fingerprint, topology_digest,
        environment_digest, readiness_evidence_digest
    ),
    CHECK (maximum_nodes >= minimum_nodes),
    CHECK ((state = 'certified') = (certified_at IS NOT NULL))
);

CREATE INDEX distributed_profile_certifications_profile_state_idx
ON compute.distributed_profile_certifications (model_profile_id, state, created_at DESC);

CREATE TABLE compute.distributed_profile_certification_members (
    certification_id uuid NOT NULL REFERENCES compute.distributed_profile_certifications(id) ON DELETE CASCADE,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    rank integer NOT NULL CHECK (rank >= 0),
    link_evidence_digest bytea NOT NULL CHECK (octet_length(link_evidence_digest) = 32),
    PRIMARY KEY (certification_id, node_id),
    UNIQUE (certification_id, rank)
);

CREATE TABLE compute.gang_lease_sets (
    id uuid PRIMARY KEY,
    acquisition_key uuid NOT NULL UNIQUE,
    gang_lease_token uuid NOT NULL UNIQUE,
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    distributed_certification_id uuid NOT NULL
        REFERENCES compute.distributed_profile_certifications(id) ON DELETE RESTRICT,
    profile_fingerprint bytea NOT NULL CHECK (octet_length(profile_fingerprint) = 32),
    topology_digest bytea NOT NULL CHECK (octet_length(topology_digest) = 32),
    environment_digest bytea NOT NULL CHECK (octet_length(environment_digest) = 32),
    readiness_evidence_digest bytea NOT NULL CHECK (octet_length(readiness_evidence_digest) = 32),
    network_class text NOT NULL CHECK (network_class = 'connectx_roce'),
    collective text NOT NULL CHECK (collective = 'all-reduce'),
    member_count integer NOT NULL CHECK (member_count BETWEEN 2 AND 16),
    state text NOT NULL DEFAULT 'preparing' CHECK (
        state IN ('preparing', 'active', 'reconcile_required', 'released', 'expired', 'failed')
    ),
    acquired_at timestamptz NOT NULL,
    heartbeat_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    activated_at timestamptz,
    reconciliation_reason text CHECK (
        reconciliation_reason IS NULL OR reconciliation_reason ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
    reconciliation_observed_at timestamptz,
    released_at timestamptz,
    release_reason text CHECK (
        release_reason IS NULL OR release_reason ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
    CHECK (expires_at > acquired_at AND heartbeat_at >= acquired_at),
    CHECK (
        (state = 'preparing' AND activated_at IS NULL AND reconciliation_reason IS NULL AND released_at IS NULL)
        OR (state = 'active' AND activated_at IS NOT NULL AND reconciliation_reason IS NULL AND released_at IS NULL)
        OR (state = 'reconcile_required' AND reconciliation_reason IS NOT NULL AND reconciliation_observed_at IS NOT NULL AND released_at IS NULL)
        OR (state IN ('released', 'expired', 'failed') AND released_at IS NOT NULL AND release_reason IS NOT NULL)
    )
);

CREATE UNIQUE INDEX gang_lease_sets_one_active_job_idx
ON compute.gang_lease_sets (job_id)
WHERE state IN ('preparing', 'active', 'reconcile_required');

CREATE INDEX gang_lease_sets_expiry_idx
ON compute.gang_lease_sets (expires_at)
WHERE state IN ('preparing', 'active');

CREATE TABLE compute.gang_lease_members (
    id uuid PRIMARY KEY,
    gang_lease_set_id uuid NOT NULL REFERENCES compute.gang_lease_sets(id) ON DELETE CASCADE,
    member_lease_token uuid NOT NULL UNIQUE,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    rank integer NOT NULL CHECK (rank >= 0),
    fencing_token bigint NOT NULL CHECK (fencing_token > 0),
    reservation jsonb NOT NULL CHECK (
        jsonb_typeof(reservation) = 'object'
        AND reservation ?& ARRAY[
            'cpuMillis', 'unifiedMemoryBytes', 'acceleratorUnits',
            'codecSessions', 'storageBytes', 'networkBitsPerSecond'
        ]
    ),
    state text NOT NULL DEFAULT 'reserved' CHECK (
        state IN ('reserved', 'active', 'released')
    ),
    worker_instance_id uuid REFERENCES compute.worker_instances(id) ON DELETE SET NULL,
    ready_at timestamptz,
    released_at timestamptz,
    UNIQUE (gang_lease_set_id, node_id),
    UNIQUE (gang_lease_set_id, rank),
    CHECK (
        (state = 'reserved' AND worker_instance_id IS NULL AND ready_at IS NULL AND released_at IS NULL)
        OR (state = 'active' AND worker_instance_id IS NOT NULL AND ready_at IS NOT NULL AND released_at IS NULL)
        OR (state = 'released' AND released_at IS NOT NULL)
    )
);

CREATE INDEX gang_lease_members_node_capacity_idx
ON compute.gang_lease_members (node_id, gang_lease_set_id);
