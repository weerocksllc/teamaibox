\set ON_ERROR_STOP on
BEGIN;

WITH identity AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name,
        password_hash, status
    ) VALUES (
        'local_user', 'plugin-delegation-user', 'plugin-delegation-user',
        'Plugin Delegation User', 'argon2id:test-only-not-a-credential', 'active'
    ) RETURNING id, password_version
)
INSERT INTO iam.sessions (
    id, identity_id, token_hash, csrf_hash, password_version,
    user_agent_hash, network_hash, created_at, last_seen_at,
    idle_expires_at, expires_at
)
SELECT '00000000-0000-4000-8000-000000001801', id,
       decode(repeat('81', 32), 'hex'), decode(repeat('82', 32), 'hex'),
       password_version, decode(repeat('83', 32), 'hex'),
       decode(repeat('84', 32), 'hex'), '2026-08-11T04:00:00Z',
       '2026-08-11T04:00:00Z', '2026-08-11T05:00:00Z',
       '2026-08-11T06:00:00Z'
FROM identity;

INSERT INTO plugins.plugins (
    plugin_key, plugin_type, publisher, lifecycle_state, generation,
    active_slot, data_namespace
) VALUES
    ('example.access-app', 'application', 'example.publisher', 'staged', 1,
     NULL, 'plugin.example.access-app'),
    ('example.access-compute', 'compute', 'example.publisher', 'staged', 1,
     NULL, 'plugin.example.access-compute');

INSERT INTO plugins.plugin_versions (
    plugin_id, version, manifest, manifest_sha256, supply_chain_state,
    install_state, slot, health, staged_at, activated_at
)
SELECT id, '1.0.0',
       CASE plugin_type
         WHEN 'application' THEN '{"type":"ApplicationPlugin","permissions":{"delegatedUserToken":true,"platformApiScopes":["files:read"]}}'::jsonb
         ELSE '{"type":"ComputePlugin","permissions":{"delegatedUserToken":false,"platformApiScopes":["compute:report"]}}'::jsonb
       END,
       CASE plugin_type WHEN 'application' THEN decode(repeat('85', 32), 'hex') ELSE decode(repeat('86', 32), 'hex') END,
       'verified', 'healthy', 'blue', '{"healthy":true}'::jsonb,
       '2026-08-11T03:59:00Z', '2026-08-11T04:00:00Z'
FROM plugins.plugins
WHERE plugin_key IN ('example.access-app', 'example.access-compute');

UPDATE plugins.plugins AS plugin
SET current_version_id = version.id, lifecycle_state = 'enabled', active_slot = 'blue'
FROM plugins.plugin_versions AS version
WHERE version.plugin_id = plugin.id
  AND plugin.plugin_key IN ('example.access-app', 'example.access-compute');

INSERT INTO plugins.delegated_user_tokens (
    id, plugin_id, plugin_version_id, plugin_generation, audience,
    identity_id, session_id, token_hash, grants, issued_at, expires_at
)
SELECT '00000000-0000-4000-8000-000000001802', plugin.id, version.id,
       plugin.generation, 'plugin:example.access-app', session.identity_id,
       session.id, decode(repeat('87', 32), 'hex'),
       '[{"scope":"files:read","permission":"file:read","resource":{"kind":"team","key":"team-alpha"}}]'::jsonb,
       '2026-08-11T04:00:00Z', '2026-08-11T04:02:00Z'
FROM plugins.plugins AS plugin
JOIN plugins.plugin_versions AS version ON version.id = plugin.current_version_id
CROSS JOIN iam.sessions AS session
WHERE plugin.plugin_key = 'example.access-app'
  AND session.id = '00000000-0000-4000-8000-000000001801';

INSERT INTO compute.capabilities (
    id, capability_key, modality, contract_version, api_operations
) VALUES (
    '00000000-0000-4000-8000-000000001803', 'ocr.access-smoke', 'ocr', 'v1', '["ocr"]'::jsonb
);

INSERT INTO compute.nodes (
    id, node_key, architecture, trust_kind, lifecycle_state, generation
) VALUES (
    '00000000-0000-4000-8000-000000001804', 'node.access-smoke', 'arm64',
    'managed_appliance', 'ready', 1
);

INSERT INTO compute.model_profiles (
    id, profile_key, capability_id, source_model, source_revision, engine,
    engine_version, precision, artifact_digest, compatibility,
    declared_resources, measured_envelope, certification_state, exclusive
) VALUES (
    '00000000-0000-4000-8000-000000001805', 'ocr.access-smoke.nvfp4',
    '00000000-0000-4000-8000-000000001803', 'example/ocr', 'rev-1',
    'tensorrt-llm', '1.0.0', 'nvfp4', 'sha256:' || repeat('a', 64),
    '{"architectures":["linux/arm64/v8"]}'::jsonb,
    '{"cpuMillis":2000,"unifiedMemoryBytes":8589934592,"storageBytes":1073741824,"networkBitsPerSecond":100000000,"acceleratorUnits":1,"codecSessions":0}'::jsonb,
    '{"cpuMillis":1800,"unifiedMemoryBytes":7516192768,"storageBytes":1073741824,"networkBitsPerSecond":90000000,"acceleratorUnits":1,"codecSessions":0}'::jsonb,
    'certified', false
);

INSERT INTO compute.jobs (
    id, owner_identity_id, capability_id, requested_model_profile_id,
    status, operation, route, terminal_at, progress_value,
    progress_message_key
)
SELECT '00000000-0000-4000-8000-000000001809', session.identity_id,
       '00000000-0000-4000-8000-000000001803',
       '00000000-0000-4000-8000-000000001805', 'succeeded',
       'platform.worker.bootstrap', 'managed_node', '2026-08-11T04:00:00Z',
       1, 'tasks.state.succeeded'
FROM iam.sessions session
WHERE session.id='00000000-0000-4000-8000-000000001801';

INSERT INTO compute.attempts (
    id, job_id, attempt_number, status, node_id, model_profile_id,
    worker_instance_key, dispatch_fence, acceptance_state, retryable,
    dispatched_at, accepted_at, started_at, finished_at
) VALUES (
    '00000000-0000-4000-8000-000000001810',
    '00000000-0000-4000-8000-000000001809', 1, 'succeeded',
    '00000000-0000-4000-8000-000000001804',
    '00000000-0000-4000-8000-000000001805',
    '00000000-0000-4000-8000-000000001806', 1,
    'accepted_no_output', false, '2026-08-11T04:00:00Z',
    '2026-08-11T04:00:00Z', '2026-08-11T04:00:00Z',
    '2026-08-11T04:00:00Z'
);

INSERT INTO compute.worker_instances (
    id, node_id, compute_plugin_id, model_profile_id, image_reference,
    architecture, generation, node_generation, lifecycle_state, health_state,
    health_generation, resources, max_concurrent_attempts,
    control_lease_id, control_fencing_token, loaded_at, attempt_id
)
SELECT '00000000-0000-4000-8000-000000001806',
       '00000000-0000-4000-8000-000000001804', plugin.id,
       '00000000-0000-4000-8000-000000001805',
       'registry.example.test/ocr@sha256:' || repeat('b', 64),
       'linux/arm64/v8', 3, 1, 'ready', 'healthy', 3,
       '{"cpuMillis":1800,"unifiedMemoryBytes":7516192768,"storageBytes":1073741824,"networkBitsPerSecond":90000000,"acceleratorUnits":1,"codecSessions":0}'::jsonb,
       1, '00000000-0000-4000-8000-000000001807', 7,
       '2026-08-11T04:00:00Z',
       '00000000-0000-4000-8000-000000001810'
FROM plugins.plugins AS plugin
WHERE plugin.plugin_key = 'example.access-compute';

INSERT INTO plugins.compute_capability_registrations (
    id, plugin_id, plugin_version_id, plugin_generation,
    worker_instance_id, worker_generation, node_id, model_profile_id,
    capability_id, control_lease_id, control_fencing_token, operations,
    resource_envelope, registration_digest, observed_at, expires_at
)
SELECT '00000000-0000-4000-8000-000000001808', plugin.id,
       plugin.current_version_id, plugin.generation, worker.id,
       worker.generation, worker.node_id, worker.model_profile_id,
       profile.capability_id, worker.control_lease_id,
       worker.control_fencing_token, '["ocr"]'::jsonb,
       profile.measured_envelope, decode(repeat('88', 32), 'hex'),
       '2026-08-11T04:00:00Z', '2026-08-11T04:01:30Z'
FROM plugins.plugins AS plugin
JOIN compute.worker_instances AS worker ON worker.compute_plugin_id = plugin.id
JOIN compute.model_profiles AS profile ON profile.id = worker.model_profile_id
WHERE plugin.plugin_key = 'example.access-compute';

DO $smoke$
BEGIN
    IF (SELECT octet_length(token_hash) FROM plugins.delegated_user_tokens) <> 32
       OR EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'plugins' AND table_name = 'delegated_user_tokens'
            AND column_name ~ '(plaintext|raw_token|secret)'
       ) THEN
        RAISE EXCEPTION 'delegated token persistence is not hash-only';
    END IF;
    IF (SELECT jsonb_array_length(grants) FROM plugins.delegated_user_tokens) <> 1 THEN
        RAISE EXCEPTION 'delegated token exact grants were not retained';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM plugins.compute_capability_registrations registration
        JOIN compute.worker_instances worker
          ON worker.id = registration.worker_instance_id
         AND worker.generation = registration.worker_generation
         AND worker.control_lease_id = registration.control_lease_id
         AND worker.control_fencing_token = registration.control_fencing_token
        JOIN plugins.plugins plugin
          ON plugin.id = registration.plugin_id
         AND plugin.current_version_id = registration.plugin_version_id
         AND plugin.generation = registration.plugin_generation
        WHERE registration.registration_state = 'available'
          AND registration.operations = '["ocr"]'::jsonb
    ) THEN
        RAISE EXCEPTION 'scheduler-only compute registration lost fencing identity';
    END IF;
    BEGIN
        INSERT INTO plugins.delegated_user_tokens (
            id, plugin_id, plugin_version_id, plugin_generation, audience,
            identity_id, session_id, token_hash, grants, issued_at, expires_at
        )
        SELECT uuidv7(), plugin.id, plugin.current_version_id, plugin.generation,
               'plugin:example.access-compute', session.identity_id, session.id,
               decode(repeat('89', 32), 'hex'), '[]'::jsonb,
               '2026-08-11T04:00:00Z', '2026-08-11T04:02:00Z'
        FROM plugins.plugins plugin CROSS JOIN iam.sessions session
        WHERE plugin.plugin_key = 'example.access-compute';
        RAISE EXCEPTION 'expected empty delegation grant rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END
$smoke$;

ROLLBACK;
