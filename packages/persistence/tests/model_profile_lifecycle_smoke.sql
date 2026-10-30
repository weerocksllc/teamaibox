\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    test_identity uuid;
    test_capability uuid;
    test_profile uuid;
BEGIN
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'model-lifecycle-smoke', 'model-lifecycle-smoke',
        'Model Lifecycle Smoke', 'argon2id:test-only-not-a-credential'
    )
    RETURNING id INTO test_identity;

    INSERT INTO compute.capabilities (capability_key, modality, contract_version, api_operations)
    VALUES ('model-lifecycle-smoke.chat', 'chat', 'v1', '["responses"]')
    RETURNING id INTO test_capability;

    INSERT INTO compute.model_profiles (
        profile_key, capability_id, source_model, source_revision, engine,
        engine_version, precision, artifact_digest, compatibility,
        declared_resources, certification_state, created_by
    ) VALUES (
        'model-lifecycle-smoke.profile', test_capability, 'local/smoke', 'v1',
        'smoke-engine', '1.0.0', 'nvfp4',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '{"architectures":["linux/arm64/v8"]}',
        '{"cpuMillis":1000,"unifiedMemoryBytes":4096}',
        'experimental', test_identity
    ) RETURNING id INTO test_profile;

    UPDATE compute.model_profiles
    SET certification_state = 'validating', lifecycle_revision = 2,
        lifecycle_reason_key = 'model.lifecycle.validation_started',
        lifecycle_updated_at = clock_timestamp()
    WHERE id = test_profile;

    INSERT INTO compute.model_profile_lifecycle_events (
        model_profile_id, profile_revision, from_state, to_state, reason_key,
        evidence_refs, actor_identity_id
    ) VALUES (
        test_profile, 2, 'experimental', 'validating',
        'model.lifecycle.validation_started', '[]', test_identity
    );

    INSERT INTO compute.model_experimental_routing_opt_ins (
        policy_key, environment, model_profile_id, enabled, reason_key,
        expires_at, set_by
    ) VALUES (
        'lab.spark', 'validation', test_profile, true,
        'model.routing.experimental_validation', clock_timestamp() + interval '1 day',
        test_identity
    );

    IF (SELECT certification_state FROM compute.model_profiles WHERE id = test_profile) <> 'validating'
       OR (SELECT count(*) FROM compute.model_profile_lifecycle_events WHERE model_profile_id = test_profile) <> 1
       OR (SELECT count(*) FROM compute.model_experimental_routing_opt_ins WHERE model_profile_id = test_profile AND enabled) <> 1 THEN
        RAISE EXCEPTION 'model profile lifecycle projection failed';
    END IF;
END $$;

ROLLBACK;
