ALTER TABLE compute.jobs
DROP CONSTRAINT jobs_status_check;

ALTER TABLE compute.jobs
ADD CONSTRAINT jobs_status_check CHECK (
    status IN (
        'queued', 'admitted', 'preparing', 'running', 'succeeded',
        'failed', 'cancelled', 'expired', 'incomplete'
    )
);

ALTER TABLE compute.jobs
    ADD COLUMN operation text NOT NULL DEFAULT 'legacy.unknown'
        CHECK (operation ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    ADD COLUMN requested_model_profile_id uuid
        REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    ADD COLUMN response_id text
        CHECK (response_id IS NULL OR response_id ~ '^resp_[A-Za-z0-9_-]{8,127}$'),
    ADD COLUMN route text NOT NULL DEFAULT 'unassigned'
        CHECK (route IN ('unassigned', 'local', 'managed_node', 'external_provider')),
    ADD COLUMN request_digest bytea
        CHECK (request_digest IS NULL OR octet_length(request_digest) = 32),
    ADD COLUMN request_size_bytes integer
        CHECK (request_size_bytes IS NULL OR request_size_bytes > 0),
    ADD COLUMN request_artifact jsonb
        CHECK (request_artifact IS NULL OR jsonb_typeof(request_artifact) = 'object'),
    ADD COLUMN data_class text NOT NULL DEFAULT 'internal'
        CHECK (data_class IN ('public', 'internal', 'confidential', 'restricted')),
    ADD COLUMN progress_revision integer NOT NULL DEFAULT 1
        CHECK (progress_revision > 0),
    ADD COLUMN progress_sequence bigint NOT NULL DEFAULT 0
        CHECK (progress_sequence >= 0),
    ADD COLUMN progress_value numeric(8,7) NOT NULL DEFAULT 0
        CHECK (progress_value BETWEEN 0 AND 1),
    ADD COLUMN progress_message_key text NOT NULL DEFAULT 'tasks.state.queued'
        CHECK (progress_message_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    ADD COLUMN waiting_reason text
        CHECK (waiting_reason IS NULL OR waiting_reason ~ '^[a-z][a-z0-9_]{1,63}$'),
    ADD COLUMN retry_classification text
        CHECK (retry_classification IS NULL OR retry_classification IN (
            'retryable', 'terminal', 'manual_reconcile'
        )),
    ADD COLUMN result_schema text
        CHECK (result_schema IS NULL OR length(result_schema) BETWEEN 3 AND 256),
    ADD COLUMN result_artifact jsonb
        CHECK (result_artifact IS NULL OR jsonb_typeof(result_artifact) = 'object'),
    ADD COLUMN terminal_error jsonb
        CHECK (terminal_error IS NULL OR jsonb_typeof(terminal_error) = 'object'),
    ADD COLUMN correlation_key text
        CHECK (correlation_key IS NULL OR correlation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    ADD COLUMN replay_count bigint NOT NULL DEFAULT 0
        CHECK (replay_count >= 0);

CREATE UNIQUE INDEX jobs_response_id_idx
ON compute.jobs (response_id)
WHERE response_id IS NOT NULL;

CREATE INDEX jobs_owner_recent_idx
ON compute.jobs (owner_identity_id, created_at DESC);

CREATE TABLE compute.job_quota_policies (
    scope_kind text NOT NULL CHECK (scope_kind IN ('appliance', 'owner', 'capability')),
    scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
    enabled boolean NOT NULL DEFAULT true,
    max_queued integer NOT NULL CHECK (max_queued > 0),
    max_active integer NOT NULL CHECK (max_active > 0),
    max_daily_submissions integer NOT NULL CHECK (max_daily_submissions > 0),
    max_request_bytes integer NOT NULL CHECK (max_request_bytes > 0),
    configuration_version bigint NOT NULL DEFAULT 1 CHECK (configuration_version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (scope_kind, scope_key)
);

CREATE TRIGGER job_quota_policies_touch_updated_at
BEFORE UPDATE ON compute.job_quota_policies
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

INSERT INTO compute.job_quota_policies (
    scope_kind, scope_key, max_queued, max_active,
    max_daily_submissions, max_request_bytes
) VALUES (
    'appliance', '*', 10000, 256, 100000, 1048576
);
