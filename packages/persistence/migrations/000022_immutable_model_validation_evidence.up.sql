CREATE TABLE compute.model_validation_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    run_key text NOT NULL UNIQUE CHECK (run_key ~ '^[a-z][a-z0-9_.-]{2,191}$'),
    plan_fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(plan_fingerprint) = 32),
    profile_key text NOT NULL REFERENCES compute.model_profile_registrations(profile_key) ON DELETE RESTRICT,
    build_job_id uuid NOT NULL REFERENCES compute.model_engine_build_jobs(id) ON DELETE RESTRICT,
    deployment_job_id uuid NOT NULL REFERENCES compute.model_engine_deployment_jobs(id) ON DELETE RESTRICT,
    plan jsonb NOT NULL CHECK (
        jsonb_typeof(plan) = 'object'
        AND plan ->> 'schemaVersion' = '1'
        AND plan ->> 'runKey' = run_key
        AND plan #>> '{profile,profileKey}' = profile_key
        AND plan #>> '{build,jobId}' = build_job_id::text
        AND plan #>> '{deployment,jobId}' = deployment_job_id::text
        AND plan ?& ARRAY['corpusDigest', 'policyDigest', 'stages']
        AND jsonb_typeof(plan -> 'stages') = 'array'
        AND jsonb_array_length(plan -> 'stages') = 10
        AND plan #>> '{stages,0,stage}' = 'discovery'
        AND plan #>> '{stages,1,stage}' = 'build'
        AND plan #>> '{stages,2,stage}' = 'smoke'
        AND plan #>> '{stages,3,stage}' = 'conformance'
        AND plan #>> '{stages,4,stage}' = 'quality'
        AND plan #>> '{stages,5,stage}' = 'benchmark'
        AND plan #>> '{stages,6,stage}' = 'stress_soak'
        AND plan #>> '{stages,7,stage}' = 'coexistence_cluster'
        AND plan #>> '{stages,8,stage}' = 'security'
        AND plan #>> '{stages,9,stage}' = 'certification'
    ),
    state text NOT NULL DEFAULT 'validating' CHECK (state IN ('validating', 'certified', 'failed')),
    current_ordinal smallint NOT NULL DEFAULT 0 CHECK (current_ordinal BETWEEN 0 AND 9),
    requested_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (id, plan_fingerprint)
);

CREATE TABLE compute.model_validation_operations (
    operation_key text PRIMARY KEY CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    run_id uuid NOT NULL,
    plan_fingerprint bytea NOT NULL CHECK (octet_length(plan_fingerprint) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (run_id, plan_fingerprint)
        REFERENCES compute.model_validation_runs(id, plan_fingerprint) ON DELETE RESTRICT
);

CREATE TABLE compute.model_validation_stages (
    run_id uuid NOT NULL REFERENCES compute.model_validation_runs(id) ON DELETE RESTRICT,
    ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
    stage text NOT NULL CHECK (stage IN (
        'discovery', 'build', 'smoke', 'conformance', 'quality', 'benchmark',
        'stress_soak', 'coexistence_cluster', 'security', 'certification'
    )),
    specification jsonb NOT NULL CHECK (
        jsonb_typeof(specification) = 'object'
        AND specification ->> 'stage' = stage
        AND specification ?& ARRAY[
            'executorImage', 'suiteDigest', 'configurationDigest',
            'timeoutSeconds', 'exclusive', 'evidenceKinds'
        ]
    ),
    state text NOT NULL CHECK (state IN (
        'pending', 'queued', 'running', 'passed', 'failed', 'incomplete', 'blocked'
    )),
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
        AND result ->> 'stage' = stage
        AND result ->> 'outcome' = state
        AND result ?& ARRAY[
            'planFingerprint', 'executorImage', 'suiteDigest',
            'configurationDigest', 'environmentDigest', 'evidence',
            'metricsDigest', 'logDigest', 'startedAt', 'finishedAt'
        ]
    )),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id, ordinal),
    UNIQUE (run_id, stage),
    CHECK (
        (state IN ('pending', 'queued', 'blocked') AND claimed_by_worker IS NULL
            AND claim_token_sha256 IS NULL AND claim_expires_at IS NULL AND result IS NULL)
        OR (state = 'running' AND claimed_by_worker IS NOT NULL
            AND claim_token_sha256 IS NOT NULL AND claim_expires_at IS NOT NULL AND result IS NULL)
        OR (state IN ('passed', 'failed', 'incomplete') AND claimed_by_worker IS NULL
            AND claim_token_sha256 IS NULL AND claim_expires_at IS NULL AND result IS NOT NULL)
    )
);

CREATE INDEX model_validation_stage_queue_idx
ON compute.model_validation_stages (updated_at, run_id, ordinal)
WHERE state = 'queued';

CREATE FUNCTION compute.enforce_model_validation_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    profile_record compute.model_profile_registrations%ROWTYPE;
    build_record compute.model_engine_build_jobs%ROWTYPE;
    deployment_record compute.model_engine_deployment_jobs%ROWTYPE;
BEGIN
    SELECT * INTO profile_record FROM compute.model_profile_registrations
    WHERE profile_key = NEW.profile_key;
    SELECT * INTO build_record FROM compute.model_engine_build_jobs
    WHERE id = NEW.build_job_id FOR SHARE;
    SELECT * INTO deployment_record FROM compute.model_engine_deployment_jobs
    WHERE id = NEW.deployment_job_id FOR SHARE;
    IF profile_record.profile_key IS NULL
       OR NEW.plan #>> '{profile,fingerprint}' <> 'sha256:' || encode(profile_record.profile_fingerprint, 'hex')
       OR build_record.id IS NULL OR build_record.state <> 'succeeded'
       OR NEW.plan #>> '{build,fingerprint}' <> 'sha256:' || encode(build_record.specification_fingerprint, 'hex')
       OR deployment_record.id IS NULL OR deployment_record.state <> 'succeeded'
       OR NEW.plan #>> '{deployment,fingerprint}' <> 'sha256:' || encode(deployment_record.specification_fingerprint, 'hex')
       OR deployment_record.build_job_id <> build_record.id THEN
        RAISE EXCEPTION 'model validation requires exact immutable successful lineage'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_validation_run_lineage
BEFORE INSERT ON compute.model_validation_runs
FOR EACH ROW EXECUTE FUNCTION compute.enforce_model_validation_lineage();

CREATE FUNCTION compute.enforce_model_validation_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.run_key <> OLD.run_key OR NEW.plan_fingerprint <> OLD.plan_fingerprint
       OR NEW.profile_key <> OLD.profile_key OR NEW.build_job_id <> OLD.build_job_id
       OR NEW.deployment_job_id <> OLD.deployment_job_id OR NEW.plan <> OLD.plan
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.operation_key <> OLD.operation_key OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable model validation run facts cannot change'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD.state IN ('certified', 'failed') THEN
        RAISE EXCEPTION 'terminal model validation run cannot change'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.state = 'validating' AND NEW.current_ordinal <> OLD.current_ordinal + 1 THEN
        RAISE EXCEPTION 'model validation ordinal must advance by one'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF NEW.state = 'certified' AND OLD.current_ordinal <> 9 THEN
        RAISE EXCEPTION 'certification requires the final stage'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF NEW.state NOT IN ('validating', 'certified', 'failed') THEN
        RAISE EXCEPTION 'invalid model validation run transition'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_validation_run_transition
BEFORE UPDATE ON compute.model_validation_runs
FOR EACH ROW EXECUTE FUNCTION compute.enforce_model_validation_run_transition();

CREATE FUNCTION compute.enforce_model_validation_stage_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.run_id <> OLD.run_id OR NEW.ordinal <> OLD.ordinal OR NEW.stage <> OLD.stage
       OR NEW.specification <> OLD.specification OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable model validation stage facts cannot change'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF OLD.state IN ('passed', 'failed', 'incomplete', 'blocked') THEN
        RAISE EXCEPTION 'terminal model validation stage cannot change'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NOT ((OLD.state = 'pending' AND NEW.state IN ('queued', 'blocked'))
        OR (OLD.state = 'queued' AND NEW.state = 'running')
        OR (OLD.state = 'running' AND NEW.state IN ('passed', 'failed', 'incomplete'))) THEN
        RAISE EXCEPTION 'invalid model validation stage transition'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_validation_stage_transition
BEFORE UPDATE ON compute.model_validation_stages
FOR EACH ROW EXECUTE FUNCTION compute.enforce_model_validation_stage_transition();

CREATE FUNCTION compute.complete_model_validation_stage(
    requested_run_id uuid,
    requested_ordinal smallint,
    requested_worker text,
    requested_claim_sha256 bytea,
    requested_result jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    run_record compute.model_validation_runs%ROWTYPE;
    stage_record compute.model_validation_stages%ROWTYPE;
    outcome text;
BEGIN
    SELECT * INTO run_record FROM compute.model_validation_runs
    WHERE id = requested_run_id FOR UPDATE;
    SELECT * INTO stage_record FROM compute.model_validation_stages
    WHERE run_id = requested_run_id AND ordinal = requested_ordinal FOR UPDATE;
    outcome := requested_result ->> 'outcome';
    IF run_record.id IS NULL OR run_record.state <> 'validating'
       OR run_record.current_ordinal <> requested_ordinal
       OR stage_record.state <> 'running'
       OR stage_record.claimed_by_worker <> requested_worker
       OR stage_record.claim_token_sha256 <> requested_claim_sha256
       OR stage_record.claim_expires_at <= clock_timestamp()
       OR requested_result ->> 'planFingerprint' <> 'sha256:' || encode(run_record.plan_fingerprint, 'hex')
       OR requested_result ->> 'stage' <> stage_record.stage
       OR outcome NOT IN ('passed', 'failed', 'incomplete') THEN
        RAISE EXCEPTION 'model validation stage completion is fenced or inconsistent'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE compute.model_validation_stages
    SET state = outcome, claimed_by_worker = NULL, claim_token_sha256 = NULL,
        claim_expires_at = NULL, result = requested_result,
        updated_at = clock_timestamp()
    WHERE run_id = requested_run_id AND ordinal = requested_ordinal;
    IF outcome = 'passed' AND requested_ordinal = 9 THEN
        UPDATE compute.model_validation_runs
        SET state = 'certified', updated_at = clock_timestamp()
        WHERE id = requested_run_id;
    ELSIF outcome = 'passed' THEN
        UPDATE compute.model_validation_runs
        SET current_ordinal = current_ordinal + 1, updated_at = clock_timestamp()
        WHERE id = requested_run_id;
        UPDATE compute.model_validation_stages
        SET state = 'queued', updated_at = clock_timestamp()
        WHERE run_id = requested_run_id AND ordinal = requested_ordinal + 1;
    ELSE
        UPDATE compute.model_validation_runs
        SET state = 'failed', updated_at = clock_timestamp()
        WHERE id = requested_run_id;
        UPDATE compute.model_validation_stages
        SET state = 'blocked', updated_at = clock_timestamp()
        WHERE run_id = requested_run_id AND ordinal > requested_ordinal AND state = 'pending';
    END IF;
END;
$$;
