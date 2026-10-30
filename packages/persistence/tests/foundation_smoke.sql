\set ON_ERROR_STOP on
BEGIN;

DO $smoke$
DECLARE
    identity_id uuid;
    role_id uuid;
    plugin_id uuid;
    plugin_version_id uuid;
    capability_id uuid;
    node_id uuid;
    provider_id uuid;
    model_profile_id uuid;
    artifact_id uuid;
    job_id uuid;
    attempt_id uuid;
BEGIN
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'Owner', 'owner', 'Foundation Owner', 'argon2id:test-only-not-a-credential'
    ) RETURNING id INTO identity_id;

    INSERT INTO iam.roles (role_key, display_name_key, description_key, system_role)
    VALUES ('foundation-owner', 'roles.owner.name', 'roles.owner.description', true)
    RETURNING id INTO role_id;

    INSERT INTO iam.identity_roles (identity_id, role_id, granted_by)
    VALUES (identity_id, role_id, identity_id);

    INSERT INTO platform.configuration_versions (
        scope, config_key, version, document, sha256, active, created_by
    ) VALUES (
        'platform', 'compute.routing', 1, '{"mode":"internal_only"}',
        decode(repeat('01', 32), 'hex'), true, identity_id
    );

    INSERT INTO plugins.plugins (plugin_key, plugin_type, publisher, protected)
    VALUES ('official.assistant', 'application', 'teamaibox', true)
    RETURNING id INTO plugin_id;

    INSERT INTO plugins.plugin_versions (
        plugin_id, version, manifest, manifest_sha256, supply_chain_state
    ) VALUES (
        plugin_id, '0.1.0', '{"schemaVersion":1}',
        decode(repeat('02', 32), 'hex'), 'verified'
    ) RETURNING id INTO plugin_version_id;

    UPDATE plugins.plugins
    SET current_version_id = plugin_version_id,
        lifecycle_state = 'enabled',
        active_slot = 'blue',
        generation = 1
    WHERE id = plugin_id;

    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES (
        'llm.chat', 'chat', 'v1', '["responses","chat.completions"]'
    ) RETURNING id INTO capability_id;

    INSERT INTO compute.nodes (
        node_key, architecture, trust_kind, lifecycle_state, capacity
    ) VALUES (
        'dgx-spark-test', 'arm64', 'managed_appliance', 'ready',
        '{"unifiedMemoryBytes":130663170048}'
    ) RETURNING id INTO node_id;

    INSERT INTO compute.node_capabilities (node_id, capability_id)
    VALUES (node_id, capability_id);

    INSERT INTO compute.providers (
        provider_key, provider_kind, data_policy, lifecycle_state
    ) VALUES (
        'local.spark', 'managed_node', 'internal_only', 'healthy'
    ) RETURNING id INTO provider_id;

    INSERT INTO compute.model_profiles (
        profile_key, capability_id, source_model, source_revision,
        engine, engine_version, precision, artifact_digest,
        compatibility, declared_resources, created_by
    ) VALUES (
        'test.llm.nvfp4', capability_id, 'test/model', 'revision-1',
        'test-engine', '1.0.0', 'nvfp4',
        'sha256:' || repeat('a', 64),
        '{"architecture":["arm64"],"computeCapability":["12.1"]}',
        '{"unifiedMemoryBytes":1073741824}',
        identity_id
    ) RETURNING id INTO model_profile_id;

    INSERT INTO compute.provider_model_profiles (
        provider_id, model_profile_id, provider_model_name, enabled
    ) VALUES (
        provider_id, model_profile_id, 'test-model', true
    );

    INSERT INTO compute.artifacts (
        owner_identity_id, namespace, object_key, object_version,
        media_type, byte_size, sha256, lifecycle_state
    ) VALUES (
        identity_id, 'user-test', 'inputs/request', 'v1',
        'application/json', 2, decode(repeat('03', 32), 'hex'), 'verified'
    ) RETURNING id INTO artifact_id;

    INSERT INTO compute.jobs (
        owner_identity_id, submitted_by_plugin_id, capability_id,
        requested_model, idempotency_scope, idempotency_key
    ) VALUES (
        identity_id, plugin_id, capability_id, 'test.llm.nvfp4',
        'responses', 'foundation-smoke-1'
    ) RETURNING id INTO job_id;

    INSERT INTO compute.job_artifacts (job_id, artifact_id, relationship, label)
    VALUES (job_id, artifact_id, 'input', 'request');

    INSERT INTO compute.attempts (
        job_id, attempt_number, node_id, provider_id, model_profile_id, dispatch_fence
    ) VALUES (
        job_id, 1, node_id, provider_id, model_profile_id, 1
    ) RETURNING id INTO attempt_id;

    INSERT INTO compute.leases (
        resource_kind, resource_key, job_id, attempt_id,
        fencing_token, reservation, expires_at
    ) VALUES (
        'exclusive', 'node:dgx-spark-test', job_id, attempt_id,
        1, '{"exclusive":true}', clock_timestamp() + interval '1 minute'
    );

    INSERT INTO audit.audit_references (
        actor_identity_id, actor_kind, action, resource_kind,
        resource_id, event_hash, metadata
    ) VALUES (
        identity_id, 'administrator', 'foundation.created', 'job',
        job_id::text, decode(repeat('04', 32), 'hex'), '{"test":true}'
    );

    IF (SELECT count(*) FROM compute.jobs WHERE id = job_id) <> 1 THEN
        RAISE EXCEPTION 'foundation job did not persist';
    END IF;
    IF (SELECT current_version_id FROM plugins.plugins WHERE id = plugin_id) <> plugin_version_id THEN
        RAISE EXCEPTION 'deferred plugin version relationship failed';
    END IF;

    BEGIN
        INSERT INTO compute.jobs (
            owner_identity_id, capability_id, idempotency_scope, idempotency_key
        ) VALUES (
            identity_id, capability_id, 'responses', 'foundation-smoke-1'
        );
        RAISE EXCEPTION 'expected duplicate idempotency key rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO compute.leases (
            resource_kind, resource_key, job_id, attempt_id,
            fencing_token, reservation, expires_at
        ) VALUES (
            'exclusive', 'node:dgx-spark-test', job_id, attempt_id,
            2, '{"exclusive":true}', clock_timestamp() + interval '1 minute'
        );
        RAISE EXCEPTION 'expected active lease conflict';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO platform.configuration_versions (
            scope, config_key, version, document, sha256, active
        ) VALUES (
            'platform', 'compute.routing', 2, '{"mode":"any"}',
            decode(repeat('05', 32), 'hex'), true
        );
        RAISE EXCEPTION 'expected single active configuration conflict';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END;
$smoke$;

ROLLBACK;
