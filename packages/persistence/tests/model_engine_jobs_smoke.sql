\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.model_engine_build_jobs (
    id, build_key, specification_fingerprint, specification, operation_key
) VALUES (
    '00000000-0000-4000-8000-000000002101',
    'qwen.nvfp4.engine.smoke', decode(repeat('aa', 32), 'hex'),
    '{
      "schemaVersion":1,
      "buildKey":"qwen.nvfp4.engine.smoke",
      "candidateId":"qwen-nvfp4",
      "source":{"model":"Qwen/example","revision":"revision-1","artifactDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},
      "builder":{"image":"registry.example/model-builder@sha256:2222222222222222222222222222222222222222222222222222222222222222","entrypointDigest":"sha256:3333333333333333333333333333333333333333333333333333333333333333"},
      "runtime":{"architecture":"linux/arm64/v8","cudaVersion":"13.0","engine":"tensorrt-llm","engineVersion":"1.2.0"},
      "recipe":{"kind":"quantize-export","scheme":"nvfp4","recipeDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444","parametersDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555","calibrationDatasetDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666"},
      "outputs":[{"name":"engine","role":"engine","mediaType":"application/vnd.nvidia.trtllm.engine"}],
      "environment":{"networkMode":"none","sourceDateEpoch":1700000000,"locale":"C.UTF-8","timezone":"UTC"},
      "resources":{"exclusive":true,"cpuMillis":8000,"unifiedMemoryBytes":103079215104,"storageBytes":42949672960}
    }'::jsonb,
    'model-engine-build-smoke-2101'
);

INSERT INTO compute.model_engine_build_operations (
    operation_key, build_job_id, specification_fingerprint
) VALUES (
    'model-engine-build-smoke-2101',
    '00000000-0000-4000-8000-000000002101', decode(repeat('aa', 32), 'hex')
);

UPDATE compute.model_engine_build_jobs
SET state = 'running', claimed_by_worker = 'worker.spark.smoke',
    claim_token_sha256 = decode(repeat('bb', 32), 'hex'),
    claim_expires_at = '2099-01-01T00:00:00.000Z', updated_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000002101';

UPDATE compute.model_engine_build_jobs
SET state = 'succeeded', claimed_by_worker = NULL, claim_token_sha256 = NULL,
    claim_expires_at = NULL,
    result = '{
      "schemaVersion":1,
      "specificationFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "builderImage":"registry.example/model-builder@sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "runtime":{"architecture":"linux/arm64/v8","cudaVersion":"13.0","engine":"tensorrt-llm","engineVersion":"1.2.0"},
      "recipeDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "parametersDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555",
      "calibrationDatasetDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666",
      "outputs":[{"name":"engine","role":"engine","mediaType":"application/vnd.nvidia.trtllm.engine","digest":"sha256:7777777777777777777777777777777777777777777777777777777777777777","sizeBytes":80}],
      "provenanceDigest":"sha256:8888888888888888888888888888888888888888888888888888888888888888",
      "sbomDigest":"sha256:9999999999999999999999999999999999999999999999999999999999999999",
      "logDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "environmentDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "startedAt":"2026-08-11T10:00:00.000Z","finishedAt":"2026-08-11T10:30:00.000Z"
    }'::jsonb,
    updated_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000002101';

INSERT INTO compute.model_engine_deployment_jobs (
    id, deployment_key, build_job_id, specification_fingerprint,
    specification, operation_key
) VALUES (
    '00000000-0000-4000-8000-000000002102',
    'qwen.nvfp4.spark.smoke', '00000000-0000-4000-8000-000000002101',
    decode(repeat('cc', 32), 'hex'),
    '{
      "schemaVersion":1,
      "deploymentKey":"qwen.nvfp4.spark.smoke",
      "buildJobId":"00000000-0000-4000-8000-000000002101",
      "buildFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "outputs":[{"name":"engine","role":"engine","mediaType":"application/vnd.nvidia.trtllm.engine","digest":"sha256:7777777777777777777777777777777777777777777777777777777777777777","sizeBytes":80}],
      "servingImage":"registry.example/model-server@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "runtime":{"architecture":"linux/arm64/v8","cudaVersion":"13.0","engine":"tensorrt-llm","engineVersion":"1.2.0"},
      "configuration":{"batchSize":1},
      "configurationDigest":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "target":{"architecture":"linux/arm64/v8","acceleratorFamily":"nvidia-blackwell","resourceClass":"spark-large","executionMode":"exclusive"},
      "health":{"path":"/health/ready","startupTimeoutSeconds":300,"successThreshold":3}
    }'::jsonb,
    'model-engine-deploy-smoke-2102'
);

INSERT INTO compute.model_engine_deployment_operations (
    operation_key, deployment_job_id, specification_fingerprint
) VALUES (
    'model-engine-deploy-smoke-2102',
    '00000000-0000-4000-8000-000000002102', decode(repeat('cc', 32), 'hex')
);

UPDATE compute.model_engine_deployment_jobs
SET state = 'running', claimed_by_worker = 'worker.spark.smoke',
    claim_token_sha256 = decode(repeat('dd', 32), 'hex'),
    claim_expires_at = '2099-01-01T00:00:00.000Z', updated_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000002102';

UPDATE compute.model_engine_deployment_jobs
SET state = 'succeeded', claimed_by_worker = NULL, claim_token_sha256 = NULL,
    claim_expires_at = NULL,
    result = '{
      "schemaVersion":1,
      "specificationFingerprint":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "servingImage":"registry.example/model-server@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "runtime":{"architecture":"linux/arm64/v8","cudaVersion":"13.0","engine":"tensorrt-llm","engineVersion":"1.2.0"},
      "configurationDigest":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "outputDigests":["sha256:7777777777777777777777777777777777777777777777777777777777777777"],
      "deploymentManifestDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "environmentDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "healthEvidenceDigest":"sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "startedAt":"2026-08-11T10:31:00.000Z","finishedAt":"2026-08-11T10:35:00.000Z"
    }'::jsonb,
    updated_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000002102';

DO $smoke$
BEGIN
    IF (SELECT state FROM compute.model_engine_build_jobs WHERE id = '00000000-0000-4000-8000-000000002101') <> 'succeeded'
       OR (SELECT result ->> 'recipeDigest' FROM compute.model_engine_build_jobs WHERE id = '00000000-0000-4000-8000-000000002101') <> 'sha256:' || repeat('44', 32)
       OR (SELECT state FROM compute.model_engine_deployment_jobs WHERE id = '00000000-0000-4000-8000-000000002102') <> 'succeeded'
       OR (SELECT count(*) FROM compute.model_engine_build_operations) <> 1
       OR (SELECT count(*) FROM compute.model_engine_deployment_operations) <> 1 THEN
        RAISE EXCEPTION 'reproducible model engine job facts were not retained';
    END IF;
    BEGIN
        UPDATE compute.model_engine_build_jobs
        SET specification = jsonb_set(specification, '{runtime,cudaVersion}', '"99.0"')
        WHERE id = '00000000-0000-4000-8000-000000002101';
        RAISE EXCEPTION 'expected terminal immutable build rejection';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
END
$smoke$;

ROLLBACK;
