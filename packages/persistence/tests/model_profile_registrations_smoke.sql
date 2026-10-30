\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.capabilities (
    id, capability_key, modality, contract_version, api_operations
) VALUES (
    '00000000-0000-4000-8000-000000001901', 'llm.profile-registration-smoke',
    'chat', 'v1', '["responses"]'::jsonb
);

INSERT INTO compute.model_profiles (
    id, profile_key, capability_id, source_model, source_revision, engine,
    engine_version, precision, artifact_digest, quantization_recipe,
    compatibility, declared_resources, certification_state, exclusive,
    created_at
) VALUES (
    '00000000-0000-4000-8000-000000001902',
    'llm.profile-registration-smoke.nvfp4',
    '00000000-0000-4000-8000-000000001901',
    'example/large-instruct', 'revision-1', 'tensorrt-llm', '1.2.0',
    'nvfp4', 'sha256:' || repeat('a', 64),
    '{"scheme":"nvfp4","recipeDigest":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}'::jsonb,
    '{"architectures":["linux/arm64/v8"],"hardware":{"acceleratorFamilies":["nvidia-blackwell"]},"software":{"driverRange":">=580.0 <590.0"}}'::jsonb,
    '{"accountingMode":"observed","cpuMillis":8000,"unifiedMemoryBytes":120259084288,"storageBytes":85899345920,"networkBitsPerSecond":1000000000,"acceleratorUnits":1,"codecSessions":0}'::jsonb,
    'experimental', true, '2026-08-11T09:30:00.000Z'
);

INSERT INTO compute.model_profile_registrations (
    profile_id, profile_key, profile_fingerprint, profile_document,
    operation_key, created_at
) VALUES (
    '00000000-0000-4000-8000-000000001902',
    'llm.profile-registration-smoke.nvfp4', decode(repeat('f1', 32), 'hex'),
    '{
      "schemaVersion":1,
      "profileId":"00000000-0000-4000-8000-000000001902",
      "profileKey":"llm.profile-registration-smoke.nvfp4",
      "capabilityId":"00000000-0000-4000-8000-000000001901",
      "executionKind":"local",
      "source":{"model":"example/large-instruct","revision":"revision-1","license":{"name":"Example","reviewStatus":"approved"},"provenance":{"publisher":"Example"}},
      "artifacts":[{"name":"weights","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],
      "artifactDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "engine":{"name":"tensorrt-llm","version":"1.2.0","runtime":"cuda","runtimeVersion":"13.0","imageDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      "precision":"nvfp4",
      "quantizationRecipe":{"scheme":"nvfp4"},
      "compatibility":{"architectures":["linux/arm64/v8"]},
      "apiContracts":["openai.responses@v1"],
      "limits":{"maximumBatchSize":1,"maximumConcurrentRequests":1},
      "resourceEnvelope":{"accountingMode":"observed","cpuMillis":8000,"unifiedMemoryBytes":120259084288,"storageBytes":85899345920,"networkBitsPerSecond":1000000000,"acceleratorUnits":1,"codecSessions":0},
      "coldStart":{"estimatedMilliseconds":95000,"artifactReadBytes":68719476736},
      "dataPolicy":{"allowedDataClasses":["internal"],"externalProcessing":"forbidden"},
      "knownLimitations":[],
      "validationEvidence":[],
      "certification":{"state":"discovery","evidenceRefs":[]},
      "exclusive":true,
      "createdAt":"2026-08-11T09:30:00.000Z"
    }'::jsonb,
    'model-register-1901', '2026-08-11T09:30:00.000Z'
);

DO $smoke$
BEGIN
    IF (SELECT octet_length(profile_fingerprint) FROM compute.model_profile_registrations) <> 32
       OR (SELECT profile_document #>> '{source,license,reviewStatus}' FROM compute.model_profile_registrations) <> 'approved'
       OR (SELECT profile_document ->> 'precision' FROM compute.model_profile_registrations) <> 'nvfp4' THEN
        RAISE EXCEPTION 'immutable model profile facts were not retained';
    END IF;
    BEGIN
        UPDATE compute.model_profile_registrations
        SET profile_document = jsonb_set(profile_document, '{precision}', '"bf16"')
        WHERE profile_key = 'llm.profile-registration-smoke.nvfp4';
        RAISE EXCEPTION 'expected immutable update rejection';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
    BEGIN
        DELETE FROM compute.model_profile_registrations
        WHERE profile_key = 'llm.profile-registration-smoke.nvfp4';
        RAISE EXCEPTION 'expected immutable delete rejection';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
    BEGIN
        DELETE FROM compute.model_profiles
        WHERE profile_key = 'llm.profile-registration-smoke.nvfp4';
        RAISE EXCEPTION 'expected registered profile parent deletion rejection';
    EXCEPTION WHEN restrict_violation OR foreign_key_violation THEN NULL;
    END;
END
$smoke$;

ROLLBACK;
