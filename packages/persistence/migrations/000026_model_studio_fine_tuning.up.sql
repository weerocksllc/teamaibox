CREATE TABLE compute.fine_tuning_datasets (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    dataset_key text NOT NULL CHECK (dataset_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    version bigint NOT NULL CHECK (version > 0),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    object_id uuid NOT NULL,
    object_version bigint NOT NULL CHECK (object_version > 0),
    content_digest bytea NOT NULL CHECK (octet_length(content_digest) = 32),
    format text NOT NULL CHECK (format IN ('chat-jsonl', 'instruction-jsonl', 'text-jsonl')),
    sample_count bigint NOT NULL CHECK (sample_count > 0),
    validation_state text NOT NULL CHECK (validation_state IN ('valid', 'invalid')),
    validation jsonb NOT NULL CHECK (jsonb_typeof(validation) = 'object'),
    split_policy jsonb NOT NULL CHECK (jsonb_typeof(split_policy) = 'object'),
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (dataset_key, version),
    UNIQUE (dataset_key, content_digest)
);

CREATE INDEX fine_tuning_datasets_created_idx
ON compute.fine_tuning_datasets (created_at DESC, id DESC);

CREATE TABLE compute.fine_tuning_experiments (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    experiment_key text NOT NULL UNIQUE CHECK (experiment_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    dataset_id uuid NOT NULL REFERENCES compute.fine_tuning_datasets(id) ON DELETE RESTRICT,
    base_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    training_profile_key text NOT NULL CHECK (training_profile_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
    checkpoint_policy jsonb NOT NULL CHECK (jsonb_typeof(checkpoint_policy) = 'object'),
    evaluation_suite_key text NOT NULL CHECK (evaluation_suite_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    node_exclusive boolean NOT NULL DEFAULT true CHECK (node_exclusive),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'preparing', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
    scheduler_job_id uuid,
    resume_from_checkpoint_reference_id uuid,
    checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checkpoints) = 'array'),
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
    evaluation jsonb CHECK (evaluation IS NULL OR jsonb_typeof(evaluation) = 'object'),
    output_artifact_reference_id uuid,
    lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (state <> 'succeeded' OR (output_artifact_reference_id IS NOT NULL AND evaluation IS NOT NULL))
);

CREATE TRIGGER fine_tuning_experiments_touch_updated_at
BEFORE UPDATE ON compute.fine_tuning_experiments
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE INDEX fine_tuning_experiments_state_idx
ON compute.fine_tuning_experiments (state, updated_at DESC);

CREATE TABLE compute.fine_tuning_candidates (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    experiment_id uuid NOT NULL UNIQUE REFERENCES compute.fine_tuning_experiments(id) ON DELETE RESTRICT,
    candidate_profile_key text NOT NULL UNIQUE CHECK (candidate_profile_key ~ '^[a-z][a-z0-9_.-]{2,191}$'),
    output_artifact_reference_id uuid NOT NULL,
    lifecycle_state text NOT NULL DEFAULT 'experimental' CHECK (lifecycle_state = 'experimental'),
    evaluation jsonb NOT NULL CHECK (jsonb_typeof(evaluation) = 'object'),
    lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),
    registered_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE compute.fine_tuning_promotion_requests (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    candidate_id uuid NOT NULL REFERENCES compute.fine_tuning_candidates(id) ON DELETE RESTRICT,
    target_policy_key text NOT NULL CHECK (target_policy_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled')),
    reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 2000),
    requested_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    decided_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    decided_at timestamptz,
    decision_reason text,
    CHECK ((state = 'pending' AND decided_at IS NULL AND decided_by IS NULL)
        OR (state <> 'pending' AND decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX fine_tuning_one_pending_promotion_idx
ON compute.fine_tuning_promotion_requests (candidate_id, target_policy_key)
WHERE state = 'pending';
