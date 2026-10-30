CREATE TABLE compute.model_engine_build_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    build_key text NOT NULL UNIQUE CHECK (build_key ~ '^[a-z][a-z0-9_.-]{2,191}$'),
    specification_fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(specification_fingerprint) = 32),
    specification jsonb NOT NULL CHECK (
        jsonb_typeof(specification) = 'object'
        AND specification ->> 'schemaVersion' = '1'
        AND specification ->> 'buildKey' = build_key
        AND specification ?& ARRAY[
            'candidateId', 'source', 'builder', 'runtime', 'recipe',
            'outputs', 'environment', 'resources'
        ]
        AND specification #>> '{environment,networkMode}' = 'none'
        AND specification #>> '{runtime,architecture}' = 'linux/arm64/v8'
        AND specification #>> '{resources,exclusive}' = 'true'
    ),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    claimed_by_worker text CHECK (
        claimed_by_worker IS NULL OR claimed_by_worker ~ '^[a-z][a-z0-9._-]{2,191}$'
    ),
    claim_token_sha256 bytea CHECK (
        claim_token_sha256 IS NULL OR octet_length(claim_token_sha256) = 32
    ),
    claim_expires_at timestamptz,
    result jsonb CHECK (result IS NULL OR (
        jsonb_typeof(result) = 'object'
        AND result ->> 'schemaVersion' = '1'
        AND result ->> 'specificationFingerprint' = 'sha256:' || encode(specification_fingerprint, 'hex')
        AND result ?& ARRAY[
            'builderImage', 'runtime', 'recipeDigest', 'parametersDigest',
            'calibrationDatasetDigest', 'outputs', 'provenanceDigest',
            'sbomDigest', 'logDigest', 'environmentDigest', 'startedAt', 'finishedAt'
        ]
    )),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{2,127}$'),
    requested_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, specification_fingerprint),
    CHECK (
        (state = 'queued' AND claimed_by_worker IS NULL AND claim_token_sha256 IS NULL
            AND claim_expires_at IS NULL AND result IS NULL AND error_code IS NULL)
        OR (state = 'running' AND claimed_by_worker IS NOT NULL AND claim_token_sha256 IS NOT NULL
            AND claim_expires_at IS NOT NULL AND result IS NULL AND error_code IS NULL)
        OR (state = 'succeeded' AND claimed_by_worker IS NULL AND claim_token_sha256 IS NULL
            AND claim_expires_at IS NULL AND result IS NOT NULL AND error_code IS NULL)
        OR (state = 'failed' AND claimed_by_worker IS NULL AND claim_token_sha256 IS NULL
            AND claim_expires_at IS NULL AND result IS NULL AND error_code IS NOT NULL)
    )
);

CREATE INDEX model_engine_build_jobs_queue_idx
ON compute.model_engine_build_jobs (created_at, id)
WHERE state = 'queued';

CREATE TABLE compute.model_engine_build_operations (
    operation_key text PRIMARY KEY CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    build_job_id uuid NOT NULL,
    specification_fingerprint bytea NOT NULL CHECK (octet_length(specification_fingerprint) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (build_job_id, specification_fingerprint)
        REFERENCES compute.model_engine_build_jobs(id, specification_fingerprint) ON DELETE RESTRICT
);

CREATE TABLE compute.model_engine_deployment_jobs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    deployment_key text NOT NULL UNIQUE CHECK (deployment_key ~ '^[a-z][a-z0-9_.-]{2,191}$'),
    build_job_id uuid NOT NULL REFERENCES compute.model_engine_build_jobs(id) ON DELETE RESTRICT,
    specification_fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(specification_fingerprint) = 32),
    specification jsonb NOT NULL CHECK (
        jsonb_typeof(specification) = 'object'
        AND specification ->> 'schemaVersion' = '1'
        AND specification ->> 'deploymentKey' = deployment_key
        AND specification ->> 'buildJobId' = build_job_id::text
        AND specification ?& ARRAY[
            'buildFingerprint', 'outputs', 'servingImage', 'runtime',
            'configuration', 'configurationDigest', 'target', 'health'
        ]
        AND specification #>> '{runtime,architecture}' = 'linux/arm64/v8'
        AND specification #>> '{target,architecture}' = 'linux/arm64/v8'
    ),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    claimed_by_worker text CHECK (
        claimed_by_worker IS NULL OR claimed_by_worker ~ '^[a-z][a-z0-9._-]{2,191}$'
    ),
    claim_token_sha256 bytea CHECK (
        claim_token_sha256 IS NULL OR octet_length(claim_token_sha256) = 32
    ),
    claim_expires_at timestamptz,
    result jsonb CHECK (result IS NULL OR (
        jsonb_typeof(result) = 'object'
        AND result ->> 'schemaVersion' = '1'
        AND result ->> 'specificationFingerprint' = 'sha256:' || encode(specification_fingerprint, 'hex')
        AND result ?& ARRAY[
            'servingImage', 'runtime', 'configurationDigest', 'outputDigests',
            'deploymentManifestDigest', 'environmentDigest', 'healthEvidenceDigest',
            'startedAt', 'finishedAt'
        ]
    )),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{2,127}$'),
    requested_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, specification_fingerprint),
    CHECK (
        (state = 'queued' AND claimed_by_worker IS NULL AND claim_token_sha256 IS NULL
            AND claim_expires_at IS NULL AND result IS NULL AND error_code IS NULL)
        OR (state = 'running' AND claimed_by_worker IS NOT NULL AND claim_token_sha256 IS NOT NULL
            AND claim_expires_at IS NOT NULL AND result IS NULL AND error_code IS NULL)
        OR (state = 'succeeded' AND claimed_by_worker IS NULL AND claim_token_sha256 IS NULL
            AND claim_expires_at IS NULL AND result IS NOT NULL AND error_code IS NULL)
        OR (state = 'failed' AND claimed_by_worker IS NULL AND claim_token_sha256 IS NULL
            AND claim_expires_at IS NULL AND result IS NULL AND error_code IS NOT NULL)
    )
);

CREATE INDEX model_engine_deployment_jobs_queue_idx
ON compute.model_engine_deployment_jobs (created_at, id)
WHERE state = 'queued';

CREATE TABLE compute.model_engine_deployment_operations (
    operation_key text PRIMARY KEY CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    deployment_job_id uuid NOT NULL,
    specification_fingerprint bytea NOT NULL CHECK (octet_length(specification_fingerprint) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (deployment_job_id, specification_fingerprint)
        REFERENCES compute.model_engine_deployment_jobs(id, specification_fingerprint) ON DELETE RESTRICT
);

CREATE FUNCTION compute.enforce_model_engine_job_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.specification_fingerprint <> OLD.specification_fingerprint
       OR NEW.specification <> OLD.specification
       OR NEW.operation_key <> OLD.operation_key
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.created_at <> OLD.created_at
       OR (TG_TABLE_NAME = 'model_engine_build_jobs'
            AND to_jsonb(NEW) ->> 'build_key' <> to_jsonb(OLD) ->> 'build_key')
       OR (TG_TABLE_NAME = 'model_engine_deployment_jobs' AND (
            to_jsonb(NEW) ->> 'deployment_key' <> to_jsonb(OLD) ->> 'deployment_key'
            OR to_jsonb(NEW) ->> 'build_job_id' <> to_jsonb(OLD) ->> 'build_job_id'
       )) THEN
        RAISE EXCEPTION 'immutable model engine job facts cannot change'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD.state IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION 'terminal model engine job cannot change'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NOT ((OLD.state = 'queued' AND NEW.state = 'running')
        OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed'))) THEN
        RAISE EXCEPTION 'invalid model engine job transition'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'model engine job time cannot move backwards'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_engine_build_job_transition
BEFORE UPDATE ON compute.model_engine_build_jobs
FOR EACH ROW EXECUTE FUNCTION compute.enforce_model_engine_job_transition();

CREATE TRIGGER model_engine_deployment_job_transition
BEFORE UPDATE ON compute.model_engine_deployment_jobs
FOR EACH ROW EXECUTE FUNCTION compute.enforce_model_engine_job_transition();

CREATE FUNCTION compute.enforce_reproducible_deployment_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    build_record compute.model_engine_build_jobs%ROWTYPE;
BEGIN
    SELECT * INTO build_record
    FROM compute.model_engine_build_jobs
    WHERE id = NEW.build_job_id
    FOR SHARE;
    IF build_record.id IS NULL OR build_record.state <> 'succeeded'
       OR NEW.specification ->> 'buildFingerprint'
            <> 'sha256:' || encode(build_record.specification_fingerprint, 'hex')
       OR NEW.specification -> 'outputs' <> build_record.result -> 'outputs' THEN
        RAISE EXCEPTION 'deployment requires exact outputs from a successful reproducible build'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_engine_deployment_reproducible_source
BEFORE INSERT ON compute.model_engine_deployment_jobs
FOR EACH ROW EXECUTE FUNCTION compute.enforce_reproducible_deployment_source();
