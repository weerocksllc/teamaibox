CREATE SCHEMA iam;
CREATE SCHEMA platform;
CREATE SCHEMA plugins;
CREATE SCHEMA compute;
CREATE SCHEMA audit;

CREATE TABLE public.teamaibox_schema_migrations (
    version bigint PRIMARY KEY,
    name text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    execution_milliseconds bigint NOT NULL CHECK (execution_milliseconds >= 0)
);

CREATE FUNCTION platform.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TABLE iam.identities (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    identity_kind text NOT NULL CHECK (identity_kind IN ('local_user', 'service_account')),
    login_name text NOT NULL CHECK (length(login_name) BETWEEN 1 AND 128),
    normalized_login_name text NOT NULL CHECK (
        normalized_login_name = lower(normalized_login_name)
        AND length(normalized_login_name) BETWEEN 1 AND 128
    ),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    password_hash text,
    password_version integer NOT NULL DEFAULT 1 CHECK (password_version > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
    preferred_locale text NOT NULL DEFAULT 'zh-CN' CHECK (preferred_locale IN ('zh-CN', 'en')),
    preferred_theme text NOT NULL DEFAULT 'system' CHECK (preferred_theme IN ('light', 'dark', 'system')),
    disabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT identities_login_name_unique UNIQUE (normalized_login_name),
    CONSTRAINT identities_disabled_state_consistent CHECK (
        (status = 'disabled' AND disabled_at IS NOT NULL)
        OR (status <> 'disabled' AND disabled_at IS NULL)
    ),
    CONSTRAINT local_user_password_present CHECK (
        identity_kind <> 'local_user' OR password_hash IS NOT NULL
    )
);

CREATE TRIGGER identities_touch_updated_at
BEFORE UPDATE ON iam.identities
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE iam.roles (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    role_key text NOT NULL UNIQUE CHECK (role_key ~ '^[a-z][a-z0-9_.-]{2,63}$'),
    display_name_key text NOT NULL CHECK (length(display_name_key) BETWEEN 1 AND 256),
    description_key text NOT NULL CHECK (length(description_key) BETWEEN 1 AND 256),
    system_role boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER roles_touch_updated_at
BEFORE UPDATE ON iam.roles
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE iam.identity_roles (
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES iam.roles(id) ON DELETE RESTRICT,
    granted_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz,
    PRIMARY KEY (identity_id, role_id),
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE INDEX identity_roles_role_idx ON iam.identity_roles (role_id, identity_id);

CREATE TABLE platform.configuration_versions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    scope text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_.-]{1,63}$'),
    config_key text NOT NULL CHECK (config_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    version bigint NOT NULL CHECK (version > 0),
    document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    active boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    supersedes_id uuid REFERENCES platform.configuration_versions(id) ON DELETE RESTRICT,
    UNIQUE (scope, config_key, version)
);

CREATE UNIQUE INDEX configuration_one_active_idx
ON platform.configuration_versions (scope, config_key)
WHERE active;

CREATE TABLE plugins.plugins (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    plugin_key text NOT NULL UNIQUE CHECK (plugin_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    plugin_type text NOT NULL CHECK (plugin_type IN ('application', 'compute')),
    publisher text NOT NULL CHECK (length(publisher) BETWEEN 1 AND 256),
    protected boolean NOT NULL DEFAULT false,
    lifecycle_state text NOT NULL DEFAULT 'discovered' CHECK (
        lifecycle_state IN ('discovered', 'staged', 'enabled', 'disabled', 'failed', 'uninstalled')
    ),
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER plugins_touch_updated_at
BEFORE UPDATE ON plugins.plugins
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE plugins.plugin_versions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE CASCADE,
    version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.-]+)?$'),
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
    supply_chain_state text NOT NULL DEFAULT 'unverified' CHECK (
        supply_chain_state IN ('unverified', 'verified', 'rejected')
    ),
    install_state text NOT NULL DEFAULT 'available' CHECK (
        install_state IN ('available', 'staging', 'healthy', 'failed', 'retired')
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (plugin_id, version)
);

ALTER TABLE plugins.plugins
ADD CONSTRAINT plugins_current_version_fk
FOREIGN KEY (current_version_id)
REFERENCES plugins.plugin_versions(id)
ON DELETE SET NULL
DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE compute.capabilities (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    capability_key text NOT NULL UNIQUE CHECK (capability_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    modality text NOT NULL CHECK (modality IN (
        'chat', 'embedding', 'image', 'ocr', 'asr', 'translation',
        'fine_tuning', 'codec', 'realtime', 'agent'
    )),
    contract_version text NOT NULL CHECK (contract_version ~ '^v[0-9]+([a-z][0-9]+)?$'),
    api_operations jsonb NOT NULL CHECK (jsonb_typeof(api_operations) = 'array'),
    lifecycle_state text NOT NULL DEFAULT 'active' CHECK (
        lifecycle_state IN ('active', 'deprecated', 'retired')
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE compute.nodes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    node_key text NOT NULL UNIQUE CHECK (node_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    architecture text NOT NULL CHECK (architecture ~ '^[a-z0-9_]+$'),
    trust_kind text NOT NULL CHECK (trust_kind IN ('managed_appliance', 'external_provider')),
    lifecycle_state text NOT NULL DEFAULT 'joining' CHECK (
        lifecycle_state IN ('joining', 'ready', 'draining', 'offline', 'disabled')
    ),
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    agent_version text,
    labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(labels) = 'object'),
    capacity jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capacity) = 'object'),
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER nodes_touch_updated_at
BEFORE UPDATE ON compute.nodes
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.node_capabilities (
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE CASCADE,
    capability_id uuid NOT NULL REFERENCES compute.capabilities(id) ON DELETE CASCADE,
    availability_state text NOT NULL DEFAULT 'available' CHECK (
        availability_state IN ('available', 'degraded', 'unavailable')
    ),
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
    PRIMARY KEY (node_id, capability_id)
);

CREATE TABLE compute.providers (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    provider_key text NOT NULL UNIQUE CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    provider_kind text NOT NULL CHECK (provider_kind IN ('managed_node', 'external_openai')),
    endpoint_uri text,
    secret_ref text,
    data_policy text NOT NULL DEFAULT 'internal_only' CHECK (
        data_policy IN ('internal_only', 'approved_external', 'public_only')
    ),
    lifecycle_state text NOT NULL DEFAULT 'disabled' CHECK (
        lifecycle_state IN ('disabled', 'healthy', 'degraded', 'unavailable')
    ),
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (provider_kind <> 'external_openai' OR endpoint_uri IS NOT NULL)
);

CREATE TRIGGER providers_touch_updated_at
BEFORE UPDATE ON compute.providers
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.model_profiles (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    profile_key text NOT NULL UNIQUE CHECK (profile_key ~ '^[a-z][a-z0-9_.-]{2,191}$'),
    capability_id uuid NOT NULL REFERENCES compute.capabilities(id) ON DELETE RESTRICT,
    source_model text NOT NULL CHECK (length(source_model) BETWEEN 1 AND 512),
    source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 256),
    engine text NOT NULL CHECK (length(engine) BETWEEN 1 AND 128),
    engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 128),
    precision text NOT NULL CHECK (precision IN ('fp32', 'bf16', 'fp16', 'fp8', 'nvfp4', 'int8', 'int4', 'awq', 'gptq', 'other')),
    artifact_digest text NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    quantization_recipe jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quantization_recipe) = 'object'),
    compatibility jsonb NOT NULL CHECK (jsonb_typeof(compatibility) = 'object'),
    declared_resources jsonb NOT NULL CHECK (jsonb_typeof(declared_resources) = 'object'),
    measured_envelope jsonb CHECK (measured_envelope IS NULL OR jsonb_typeof(measured_envelope) = 'object'),
    certification_state text NOT NULL DEFAULT 'discovery' CHECK (
        certification_state IN (
            'discovery', 'build', 'smoke', 'conformance', 'quality', 'benchmark',
            'stress_soak', 'coexistence_cluster', 'security', 'certified', 'rejected', 'retired'
        )
    ),
    exclusive boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (source_model, source_revision, engine, engine_version, precision, artifact_digest)
);

CREATE INDEX model_profiles_capability_state_idx
ON compute.model_profiles (capability_id, certification_state);

CREATE TABLE compute.provider_model_profiles (
    provider_id uuid NOT NULL REFERENCES compute.providers(id) ON DELETE CASCADE,
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE CASCADE,
    provider_model_name text NOT NULL CHECK (length(provider_model_name) BETWEEN 1 AND 512),
    enabled boolean NOT NULL DEFAULT false,
    routing_weight integer NOT NULL DEFAULT 100 CHECK (routing_weight BETWEEN 0 AND 10000),
    limits jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
    PRIMARY KEY (provider_id, model_profile_id)
);

CREATE TABLE compute.artifacts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    namespace text NOT NULL CHECK (namespace ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
    object_version text NOT NULL CHECK (length(object_version) BETWEEN 1 AND 256),
    media_type text CHECK (media_type IS NULL OR length(media_type) <= 256),
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    lifecycle_state text NOT NULL DEFAULT 'pending' CHECK (
        lifecycle_state IN ('pending', 'verified', 'deleted', 'quarantined')
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    UNIQUE (namespace, object_key, object_version),
    CHECK (
        (lifecycle_state = 'deleted' AND deleted_at IS NOT NULL)
        OR (lifecycle_state <> 'deleted' AND deleted_at IS NULL)
    )
);

CREATE TABLE compute.jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    submitted_by_plugin_id uuid REFERENCES plugins.plugins(id) ON DELETE SET NULL,
    capability_id uuid NOT NULL REFERENCES compute.capabilities(id) ON DELETE RESTRICT,
    requested_model text,
    status text NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'admitted', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'incomplete')
    ),
    priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
    idempotency_scope text,
    idempotency_key text,
    request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_metadata) = 'object'),
    result_metadata jsonb CHECK (result_metadata IS NULL OR jsonb_typeof(result_metadata) = 'object'),
    correlation_id uuid NOT NULL DEFAULT uuidv7(),
    deadline_at timestamptz,
    cancel_requested_at timestamptz,
    terminal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((idempotency_scope IS NULL) = (idempotency_key IS NULL)),
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 512),
    CHECK (deadline_at IS NULL OR deadline_at > created_at),
    CHECK (
        (status IN ('succeeded', 'failed', 'cancelled', 'expired', 'incomplete') AND terminal_at IS NOT NULL)
        OR (status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'incomplete') AND terminal_at IS NULL)
    )
);

CREATE UNIQUE INDEX jobs_idempotency_idx
ON compute.jobs (owner_identity_id, idempotency_scope, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX jobs_queue_idx
ON compute.jobs (status, priority DESC, created_at)
WHERE status IN ('queued', 'admitted', 'running');

CREATE TRIGGER jobs_touch_updated_at
BEFORE UPDATE ON compute.jobs
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.job_artifacts (
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    artifact_id uuid NOT NULL REFERENCES compute.artifacts(id) ON DELETE RESTRICT,
    relationship text NOT NULL CHECK (relationship IN ('input', 'output', 'log', 'checkpoint', 'evidence')),
    label text NOT NULL DEFAULT '' CHECK (length(label) <= 256),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (job_id, artifact_id, relationship)
);

CREATE TABLE compute.attempts (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    status text NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'dispatched', 'accepted', 'running', 'succeeded', 'failed', 'cancelled', 'lost', 'incomplete')
    ),
    node_id uuid REFERENCES compute.nodes(id) ON DELETE SET NULL,
    provider_id uuid REFERENCES compute.providers(id) ON DELETE SET NULL,
    model_profile_id uuid REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    worker_instance_key text,
    dispatch_fence bigint NOT NULL CHECK (dispatch_fence > 0),
    acceptance_state text NOT NULL DEFAULT 'not_accepted' CHECK (
        acceptance_state IN ('not_accepted', 'accepted_no_output', 'output_observed', 'side_effect_uncertain')
    ),
    retryable boolean,
    error_code text,
    error_artifact_id uuid REFERENCES compute.artifacts(id) ON DELETE SET NULL,
    dispatched_at timestamptz,
    accepted_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (job_id, attempt_number),
    CHECK (node_id IS NOT NULL OR provider_id IS NOT NULL),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX attempts_active_idx
ON compute.attempts (status, created_at)
WHERE status IN ('pending', 'dispatched', 'accepted', 'running');

CREATE TABLE compute.leases (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    resource_kind text NOT NULL CHECK (resource_kind IN ('node', 'cpu', 'unified_memory', 'accelerator', 'codec', 'worker', 'realtime', 'exclusive')),
    resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 256),
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    attempt_id uuid REFERENCES compute.attempts(id) ON DELETE CASCADE,
    lease_token uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    fencing_token bigint NOT NULL CHECK (fencing_token > 0),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released', 'expired', 'revoked')),
    reservation jsonb NOT NULL CHECK (jsonb_typeof(reservation) = 'object'),
    acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    heartbeat_at timestamptz,
    released_at timestamptz,
    CHECK (expires_at > acquired_at),
    CHECK (
        (state = 'active' AND released_at IS NULL)
        OR (state <> 'active' AND released_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX leases_one_active_resource_idx
ON compute.leases (resource_kind, resource_key)
WHERE state = 'active';

CREATE INDEX leases_expiry_idx
ON compute.leases (expires_at)
WHERE state = 'active';

CREATE TABLE audit.audit_references (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'administrator', 'service', 'system')),
    action text NOT NULL CHECK (length(action) BETWEEN 1 AND 256),
    resource_kind text NOT NULL CHECK (length(resource_kind) BETWEEN 1 AND 128),
    resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
    correlation_id uuid,
    event_hash bytea NOT NULL UNIQUE CHECK (octet_length(event_hash) = 32),
    previous_event_hash bytea CHECK (previous_event_hash IS NULL OR octet_length(previous_event_hash) = 32),
    detail_artifact_id uuid REFERENCES compute.artifacts(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_resource_idx
ON audit.audit_references (resource_kind, resource_id, occurred_at DESC);

CREATE INDEX audit_actor_idx
ON audit.audit_references (actor_identity_id, occurred_at DESC)
WHERE actor_identity_id IS NOT NULL;

