\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.capabilities (id, capability_key, modality, contract_version, api_operations)
VALUES ('00000000-0000-4000-8000-000000002201', 'model.validation.smoke', 'chat', 'v1', '["responses"]');
INSERT INTO compute.model_profiles (
    id, profile_key, capability_id, source_model, source_revision, engine,
    engine_version, precision, artifact_digest, quantization_recipe,
    compatibility, declared_resources, certification_state, exclusive
) VALUES (
    '00000000-0000-4000-8000-000000002202', 'model.validation.profile.smoke',
    '00000000-0000-4000-8000-000000002201', 'example/model', 'revision-1',
    'tensorrt-llm', '1.2.0', 'nvfp4', 'sha256:' || repeat('11', 32),
    '{"scheme":"nvfp4"}', '{}', '{}', 'validating', true
);
INSERT INTO compute.model_profile_registrations (
    profile_id, profile_key, profile_fingerprint, profile_document,
    operation_key, created_at
) VALUES (
    '00000000-0000-4000-8000-000000002202', 'model.validation.profile.smoke',
    decode(repeat('aa', 32), 'hex'),
    '{
      "schemaVersion":1,"profileId":"00000000-0000-4000-8000-000000002202",
      "profileKey":"model.validation.profile.smoke","capabilityId":"00000000-0000-4000-8000-000000002201",
      "executionKind":"local","source":{},"artifacts":[],"artifactDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "engine":{},"precision":"nvfp4","quantizationRecipe":{},"compatibility":{},
      "apiContracts":[],"limits":{},"resourceEnvelope":{},"coldStart":{},"dataPolicy":{},
      "knownLimitations":[],"validationEvidence":[],"certification":{},"exclusive":true,
      "createdAt":"2026-08-11T12:00:00.000Z"
    }',
    'model-validation-profile-2201', '2026-08-11T12:00:00.000Z'
);

INSERT INTO compute.model_engine_build_jobs (
    id, build_key, specification_fingerprint, specification, operation_key
) VALUES (
    '00000000-0000-4000-8000-000000002203', 'model.validation.build.smoke',
    decode(repeat('bb', 32), 'hex'),
    '{
      "schemaVersion":1,"buildKey":"model.validation.build.smoke","candidateId":"example",
      "source":{},"builder":{},"runtime":{"architecture":"linux/arm64/v8"},"recipe":{},
      "outputs":[],"environment":{"networkMode":"none"},"resources":{"exclusive":true}
    }', 'model-validation-build-2202'
);
UPDATE compute.model_engine_build_jobs SET
    state='running', claimed_by_worker='worker.validation.smoke',
    claim_token_sha256=decode(repeat('01',32),'hex'), claim_expires_at='2099-01-01',
    updated_at=clock_timestamp()
WHERE id='00000000-0000-4000-8000-000000002203';
UPDATE compute.model_engine_build_jobs SET
    state='succeeded', claimed_by_worker=NULL, claim_token_sha256=NULL, claim_expires_at=NULL,
    result='{
      "schemaVersion":1,"specificationFingerprint":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "builderImage":"example@sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "runtime":{},"recipeDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "parametersDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "calibrationDatasetDigest":null,"outputs":[],
      "provenanceDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "sbomDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "logDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "environmentDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "startedAt":"2026-08-11T10:00:00.000Z","finishedAt":"2026-08-11T10:01:00.000Z"
    }', updated_at=clock_timestamp()
WHERE id='00000000-0000-4000-8000-000000002203';

INSERT INTO compute.model_engine_deployment_jobs (
    id, deployment_key, build_job_id, specification_fingerprint, specification, operation_key
) VALUES (
    '00000000-0000-4000-8000-000000002204', 'model.validation.deployment.smoke',
    '00000000-0000-4000-8000-000000002203', decode(repeat('cc', 32), 'hex'),
    '{
      "schemaVersion":1,"deploymentKey":"model.validation.deployment.smoke",
      "buildJobId":"00000000-0000-4000-8000-000000002203",
      "buildFingerprint":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "outputs":[],"servingImage":"example@sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "runtime":{"architecture":"linux/arm64/v8"},"configuration":{},
      "configurationDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "target":{"architecture":"linux/arm64/v8"},"health":{}
    }', 'model-validation-deploy-2203'
);
UPDATE compute.model_engine_deployment_jobs SET
    state='running', claimed_by_worker='worker.validation.smoke',
    claim_token_sha256=decode(repeat('02',32),'hex'), claim_expires_at='2099-01-01',
    updated_at=clock_timestamp()
WHERE id='00000000-0000-4000-8000-000000002204';
UPDATE compute.model_engine_deployment_jobs SET
    state='succeeded', claimed_by_worker=NULL, claim_token_sha256=NULL, claim_expires_at=NULL,
    result='{
      "schemaVersion":1,"specificationFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "servingImage":"example@sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "runtime":{},"configurationDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "outputDigests":[],"deploymentManifestDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "environmentDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "healthEvidenceDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "startedAt":"2026-08-11T10:02:00.000Z","finishedAt":"2026-08-11T10:03:00.000Z"
    }', updated_at=clock_timestamp()
WHERE id='00000000-0000-4000-8000-000000002204';

WITH stage_names(stage, ordinal) AS (VALUES
    ('discovery',0),('build',1),('smoke',2),('conformance',3),('quality',4),
    ('benchmark',5),('stress_soak',6),('coexistence_cluster',7),('security',8),('certification',9)
), plan_document AS (
    SELECT jsonb_build_object(
        'schemaVersion',1,'runKey','model.validation.run.smoke',
        'profile',jsonb_build_object('profileKey','model.validation.profile.smoke','fingerprint','sha256:' || repeat('aa',32)),
        'build',jsonb_build_object('jobId','00000000-0000-4000-8000-000000002203','fingerprint','sha256:' || repeat('bb',32)),
        'deployment',jsonb_build_object('jobId','00000000-0000-4000-8000-000000002204','fingerprint','sha256:' || repeat('cc',32)),
        'corpusDigest','sha256:' || repeat('dd',32),'policyDigest','sha256:' || repeat('ee',32),
        'stages',jsonb_agg(jsonb_build_object(
            'stage',stage,'executorImage','example@sha256:' || repeat('33',32),
            'suiteDigest','sha256:' || repeat('44',32),'configurationDigest','sha256:' || repeat('55',32),
            'timeoutSeconds',3600,'exclusive',false,'evidenceKinds',jsonb_build_array(stage || '.report')
        ) ORDER BY ordinal)
    ) AS document FROM stage_names
), inserted AS (
    INSERT INTO compute.model_validation_runs (
        id, run_key, plan_fingerprint, profile_key, build_job_id,
        deployment_job_id, plan, operation_key
    ) SELECT
        '00000000-0000-4000-8000-000000002205','model.validation.run.smoke',
        decode(repeat('ff',32),'hex'),'model.validation.profile.smoke',
        '00000000-0000-4000-8000-000000002203','00000000-0000-4000-8000-000000002204',
        document,'model-validation-run-2204'
    FROM plan_document RETURNING id, plan
)
INSERT INTO compute.model_validation_stages (run_id, ordinal, stage, specification, state)
SELECT inserted.id, item.ordinality - 1, item.value ->> 'stage', item.value,
       CASE WHEN item.ordinality = 1 THEN 'queued' ELSE 'pending' END
FROM inserted, jsonb_array_elements(inserted.plan -> 'stages') WITH ORDINALITY AS item(value, ordinality);

INSERT INTO compute.model_validation_operations (operation_key, run_id, plan_fingerprint)
VALUES ('model-validation-run-2204','00000000-0000-4000-8000-000000002205',decode(repeat('ff',32),'hex'));

UPDATE compute.model_validation_stages SET
    state='running',claimed_by_worker='worker.validation.smoke',
    claim_token_sha256=decode(repeat('03',32),'hex'),claim_expires_at='2099-01-01',updated_at=clock_timestamp()
WHERE run_id='00000000-0000-4000-8000-000000002205' AND ordinal=0;
SELECT compute.complete_model_validation_stage(
    '00000000-0000-4000-8000-000000002205',0::smallint,'worker.validation.smoke',decode(repeat('03',32),'hex'),
    '{
      "schemaVersion":1,"planFingerprint":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "stage":"discovery","outcome":"passed","executorImage":"example@sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "suiteDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "configurationDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555",
      "environmentDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666",
      "evidence":[],"metricsDigest":"sha256:7777777777777777777777777777777777777777777777777777777777777777",
      "logDigest":"sha256:8888888888888888888888888888888888888888888888888888888888888888",
      "startedAt":"2026-08-11T10:04:00.000Z","finishedAt":"2026-08-11T10:05:00.000Z"
    }'::jsonb
);

UPDATE compute.model_validation_stages SET
    state='running',claimed_by_worker='worker.validation.smoke',
    claim_token_sha256=decode(repeat('04',32),'hex'),claim_expires_at='2099-01-01',updated_at=clock_timestamp()
WHERE run_id='00000000-0000-4000-8000-000000002205' AND ordinal=1;
SELECT compute.complete_model_validation_stage(
    '00000000-0000-4000-8000-000000002205',1::smallint,'worker.validation.smoke',decode(repeat('04',32),'hex'),
    '{
      "schemaVersion":1,"planFingerprint":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "stage":"build","outcome":"failed","executorImage":"example@sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "suiteDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "configurationDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555",
      "environmentDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666",
      "evidence":[],"metricsDigest":"sha256:7777777777777777777777777777777777777777777777777777777777777777",
      "logDigest":"sha256:8888888888888888888888888888888888888888888888888888888888888888",
      "startedAt":"2026-08-11T10:06:00.000Z","finishedAt":"2026-08-11T10:07:00.000Z"
    }'::jsonb
);

DO $smoke$
BEGIN
    IF (SELECT state FROM compute.model_validation_runs WHERE id='00000000-0000-4000-8000-000000002205') <> 'failed'
       OR (SELECT state FROM compute.model_validation_stages WHERE run_id='00000000-0000-4000-8000-000000002205' AND ordinal=0) <> 'passed'
       OR (SELECT state FROM compute.model_validation_stages WHERE run_id='00000000-0000-4000-8000-000000002205' AND ordinal=1) <> 'failed'
       OR (SELECT count(*) FROM compute.model_validation_stages WHERE run_id='00000000-0000-4000-8000-000000002205' AND state='blocked') <> 8 THEN
        RAISE EXCEPTION 'model validation evidence state machine did not fail closed';
    END IF;
    BEGIN
        UPDATE compute.model_validation_stages SET result=NULL
        WHERE run_id='00000000-0000-4000-8000-000000002205' AND ordinal=0;
        RAISE EXCEPTION 'expected immutable validation evidence rejection';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
END
$smoke$;

ROLLBACK;
