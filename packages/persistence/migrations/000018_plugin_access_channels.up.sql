ALTER TABLE plugins.plugin_versions
ADD CONSTRAINT plugin_versions_plugin_id_id_key UNIQUE (plugin_id, id);

ALTER TABLE iam.sessions
ADD CONSTRAINT sessions_identity_id_id_key UNIQUE (identity_id, id);

ALTER TABLE compute.worker_instances
ADD CONSTRAINT worker_instances_plugin_id_id_key UNIQUE (compute_plugin_id, id),
ADD CONSTRAINT worker_instances_node_id_id_key UNIQUE (node_id, id);

ALTER TABLE compute.model_profiles
ADD CONSTRAINT model_profiles_capability_id_id_key UNIQUE (capability_id, id);

CREATE TABLE plugins.delegated_user_tokens (
    id uuid PRIMARY KEY,
    plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE RESTRICT,
    plugin_version_id uuid NOT NULL,
    plugin_generation bigint NOT NULL CHECK (plugin_generation > 0),
    audience text NOT NULL CHECK (
        audience ~ '^plugin:[a-z][a-z0-9.-]{2,127}$'
    ),
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    grants jsonb NOT NULL CHECK (
        jsonb_typeof(grants) = 'array'
        AND jsonb_array_length(grants) BETWEEN 1 AND 64
    ),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text CHECK (
        revoke_reason IS NULL OR revoke_reason ~ '^[a-z][a-z0-9_-]{2,63}$'
    ),
    FOREIGN KEY (plugin_id, plugin_version_id)
        REFERENCES plugins.plugin_versions(plugin_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (identity_id, session_id)
        REFERENCES iam.sessions(identity_id, id) ON DELETE CASCADE,
    CHECK (expires_at >= issued_at + interval '15 seconds'),
    CHECK (expires_at <= issued_at + interval '15 minutes'),
    CHECK (last_used_at IS NULL OR last_used_at BETWEEN issued_at AND expires_at),
    CHECK (
        (revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    )
);

CREATE INDEX delegated_user_tokens_active_identity_idx
ON plugins.delegated_user_tokens (identity_id, session_id, expires_at)
WHERE revoked_at IS NULL;

CREATE INDEX delegated_user_tokens_active_plugin_idx
ON plugins.delegated_user_tokens (plugin_id, plugin_generation, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE plugins.compute_capability_registrations (
    id uuid PRIMARY KEY,
    plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE RESTRICT,
    plugin_version_id uuid NOT NULL,
    plugin_generation bigint NOT NULL CHECK (plugin_generation > 0),
    worker_instance_id uuid NOT NULL,
    worker_generation bigint NOT NULL CHECK (worker_generation > 0),
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    capability_id uuid NOT NULL REFERENCES compute.capabilities(id) ON DELETE RESTRICT,
    control_lease_id uuid NOT NULL,
    control_fencing_token bigint NOT NULL CHECK (control_fencing_token > 0),
    operations jsonb NOT NULL CHECK (
        jsonb_typeof(operations) = 'array'
        AND jsonb_array_length(operations) BETWEEN 1 AND 32
    ),
    resource_envelope jsonb NOT NULL CHECK (
        jsonb_typeof(resource_envelope) = 'object'
        AND resource_envelope ?& ARRAY[
            'cpuMillis', 'unifiedMemoryBytes', 'storageBytes',
            'networkBitsPerSecond', 'acceleratorUnits', 'codecSessions'
        ]
    ),
    registration_digest bytea NOT NULL UNIQUE CHECK (
        octet_length(registration_digest) = 32
    ),
    registration_state text NOT NULL DEFAULT 'available' CHECK (
        registration_state IN ('available', 'retired', 'expired')
    ),
    observed_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    retired_at timestamptz,
    retire_reason text CHECK (
        retire_reason IS NULL OR retire_reason ~ '^[a-z][a-z0-9_-]{2,63}$'
    ),
    FOREIGN KEY (plugin_id, plugin_version_id)
        REFERENCES plugins.plugin_versions(plugin_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (plugin_id, worker_instance_id)
        REFERENCES compute.worker_instances(compute_plugin_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (node_id, worker_instance_id)
        REFERENCES compute.worker_instances(node_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (capability_id, model_profile_id)
        REFERENCES compute.model_profiles(capability_id, id) ON DELETE RESTRICT,
    UNIQUE (worker_instance_id, worker_generation, model_profile_id),
    CHECK (expires_at > observed_at),
    CHECK (expires_at <= observed_at + interval '5 minutes'),
    CHECK (
        (registration_state = 'available' AND retired_at IS NULL AND retire_reason IS NULL)
        OR (registration_state <> 'available' AND retired_at IS NOT NULL AND retire_reason IS NOT NULL)
    )
);

CREATE INDEX compute_capability_registrations_available_idx
ON plugins.compute_capability_registrations (
    capability_id, model_profile_id, expires_at
)
WHERE registration_state = 'available';

CREATE INDEX compute_capability_registrations_worker_idx
ON plugins.compute_capability_registrations (
    worker_instance_id, worker_generation, registration_state
);
