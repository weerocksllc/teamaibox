CREATE TABLE compute.asr_shard_plans (
    id uuid PRIMARY KEY,
    parent_job_id uuid NOT NULL UNIQUE REFERENCES compute.jobs(id) ON DELETE CASCADE,
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    capability_id uuid NOT NULL REFERENCES compute.capabilities(id) ON DELETE RESTRICT,
    source_artifact_id uuid NOT NULL REFERENCES compute.artifacts(id) ON DELETE RESTRICT,
    source_reference_id uuid NOT NULL REFERENCES objects.access_grants(reference_id) ON DELETE RESTRICT,
    source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
    source_duration_milliseconds bigint NOT NULL CHECK (
        source_duration_milliseconds BETWEEN 1 AND 604800000
    ),
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    profile_fingerprint bytea NOT NULL CHECK (octet_length(profile_fingerprint) = 32),
    engine_image_digest bytea NOT NULL CHECK (octet_length(engine_image_digest) = 32),
    plan_digest bytea NOT NULL CHECK (octet_length(plan_digest) = 32),
    request_options jsonb NOT NULL CHECK (
        jsonb_typeof(request_options) = 'object'
        AND request_options ?& ARRAY['language', 'timestampGranularities', 'speakerInformation']
    ),
    shard_policy jsonb NOT NULL CHECK (
        jsonb_typeof(shard_policy) = 'object'
        AND shard_policy ?& ARRAY[
            'targetShardDurationMilliseconds', 'overlapMilliseconds',
            'maxParallelShards', 'maxAttemptsPerShard'
        ]
    ),
    shard_count integer NOT NULL CHECK (shard_count BETWEEN 1 AND 10080),
    status text NOT NULL DEFAULT 'planned' CHECK (
        status IN ('planned', 'running', 'ready_for_reduction', 'succeeded', 'failed', 'cancelled')
    ),
    result_artifact_id uuid REFERENCES compute.artifacts(id) ON DELETE RESTRICT,
    result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    CHECK ((result_artifact_id IS NULL) = (result_sha256 IS NULL)),
    CHECK (
        (status = 'succeeded' AND result_artifact_id IS NOT NULL AND completed_at IS NOT NULL)
        OR (status <> 'succeeded' AND result_artifact_id IS NULL AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX asr_shard_plans_digest_idx
ON compute.asr_shard_plans (parent_job_id, plan_digest);

CREATE INDEX asr_shard_plans_active_idx
ON compute.asr_shard_plans (status, updated_at)
WHERE status IN ('planned', 'running', 'ready_for_reduction');

CREATE TRIGGER asr_shard_plans_touch_updated_at
BEFORE UPDATE ON compute.asr_shard_plans
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.asr_shards (
    id uuid PRIMARY KEY,
    plan_id uuid NOT NULL REFERENCES compute.asr_shard_plans(id) ON DELETE CASCADE,
    execution_job_id uuid NOT NULL UNIQUE REFERENCES compute.jobs(id) ON DELETE CASCADE,
    shard_index integer NOT NULL CHECK (shard_index >= 0),
    shard_count integer NOT NULL CHECK (shard_count > 0),
    core_start_milliseconds bigint NOT NULL CHECK (core_start_milliseconds >= 0),
    core_end_milliseconds bigint NOT NULL CHECK (core_end_milliseconds > core_start_milliseconds),
    media_start_milliseconds bigint NOT NULL CHECK (media_start_milliseconds >= 0),
    media_end_milliseconds bigint NOT NULL CHECK (media_end_milliseconds > media_start_milliseconds),
    status text NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    current_attempt_id uuid,
    last_error_code text CHECK (
        last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
    result_artifact_id uuid REFERENCES compute.artifacts(id) ON DELETE RESTRICT,
    result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256) = 32),
    result_summary jsonb CHECK (
        result_summary IS NULL OR (
            jsonb_typeof(result_summary) = 'object'
            AND result_summary ?& ARRAY[
                'segmentCount', 'firstTimestampMilliseconds',
                'lastTimestampMilliseconds', 'languageCode', 'speakerCount'
            ]
        )
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    UNIQUE (plan_id, shard_index),
    CHECK (shard_index < shard_count),
    CHECK (media_start_milliseconds <= core_start_milliseconds),
    CHECK (media_end_milliseconds >= core_end_milliseconds),
    CHECK ((result_artifact_id IS NULL) = (result_sha256 IS NULL)),
    CHECK (
        (status = 'running' AND current_attempt_id IS NOT NULL)
        OR (status <> 'running' AND current_attempt_id IS NULL)
    ),
    CHECK (
        (status = 'succeeded' AND result_artifact_id IS NOT NULL
            AND result_summary IS NOT NULL AND completed_at IS NOT NULL)
        OR (status <> 'succeeded' AND result_artifact_id IS NULL
            AND result_summary IS NULL AND completed_at IS NULL)
    )
);

CREATE INDEX asr_shards_dispatch_idx
ON compute.asr_shards (status, plan_id, shard_index)
WHERE status IN ('queued', 'running');

CREATE TRIGGER asr_shards_touch_updated_at
BEFORE UPDATE ON compute.asr_shards
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.asr_shard_attempts (
    id uuid PRIMARY KEY,
    shard_id uuid NOT NULL REFERENCES compute.asr_shards(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    status text NOT NULL DEFAULT 'running' CHECK (
        status IN ('running', 'succeeded', 'failed', 'lost', 'cancelled')
    ),
    retryable boolean,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
    result_artifact_id uuid REFERENCES compute.artifacts(id) ON DELETE RESTRICT,
    result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256) = 32),
    claimed_at timestamptz NOT NULL,
    finished_at timestamptz,
    UNIQUE (shard_id, attempt_number),
    CHECK ((result_artifact_id IS NULL) = (result_sha256 IS NULL)),
    CHECK (
        (status = 'running' AND finished_at IS NULL AND retryable IS NULL)
        OR (status = 'succeeded' AND finished_at IS NOT NULL AND retryable = false
            AND result_artifact_id IS NOT NULL AND error_code IS NULL)
        OR (status IN ('failed', 'lost', 'cancelled') AND finished_at IS NOT NULL
            AND retryable IS NOT NULL AND result_artifact_id IS NULL)
    )
);

ALTER TABLE compute.asr_shards
ADD CONSTRAINT asr_shards_current_attempt_fk
FOREIGN KEY (current_attempt_id)
REFERENCES compute.asr_shard_attempts(id)
ON DELETE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX asr_shard_attempts_history_idx
ON compute.asr_shard_attempts (shard_id, attempt_number);
