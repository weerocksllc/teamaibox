\set ON_ERROR_STOP on
BEGIN;

WITH identity AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name
    ) VALUES (
        'service_account', 'worker-lifecycle-smoke',
        'worker-lifecycle-smoke', 'Worker lifecycle smoke'
    ) RETURNING id
), plugin AS (
    INSERT INTO plugins.plugins (
        plugin_key, plugin_type, publisher, lifecycle_state
    ) VALUES (
        'worker-lifecycle-smoke', 'compute', 'Team AI Box', 'discovered'
    ) RETURNING id
), capability AS (
    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES (
        'worker-lifecycle-smoke.chat', 'chat', 'v1', '["responses"]'
    ) RETURNING id
), profile AS (
    INSERT INTO compute.model_profiles (
        profile_key, capability_id, source_model, source_revision,
        engine, engine_version, precision, artifact_digest,
        compatibility, declared_resources, measured_envelope,
        certification_state
    )
    SELECT 'worker-lifecycle-smoke.profile', capability.id,
           'local/worker-lifecycle-smoke', 'v1', 'test-engine', '1.0.0',
           'nvfp4', 'sha256:' || repeat('cd', 32),
           '{"architectures":["linux/arm64/v8"]}',
           '{"cpuMillis":1000,"unifiedMemoryBytes":8192}',
           '{"cpuMillis":1000,"unifiedMemoryBytes":8192}', 'certified'
    FROM capability RETURNING id
), compute_node AS (
    INSERT INTO compute.nodes (
        node_key, architecture, trust_kind, lifecycle_state, generation
    ) VALUES (
        'worker-lifecycle-smoke-node', 'arm64', 'managed_appliance', 'ready', 3
    ) RETURNING id, generation
), job AS (
    INSERT INTO compute.jobs (
        id, owner_identity_id, capability_id, requested_model_profile_id,
        status, operation, route, terminal_at, progress_value,
        progress_message_key
    )
    SELECT '00000000-0000-4000-8000-000000000704'::uuid,
           identity.id, capability.id, profile.id, 'succeeded',
           'platform.worker.bootstrap', 'managed_node', clock_timestamp(),
           1, 'tasks.state.succeeded'
    FROM identity, capability, profile
    RETURNING id
), attempt AS (
    INSERT INTO compute.attempts (
        id, job_id, attempt_number, status, node_id, model_profile_id,
        worker_instance_key, dispatch_fence, acceptance_state, retryable,
        dispatched_at, accepted_at, started_at, finished_at
    )
    SELECT '00000000-0000-4000-8000-000000000705'::uuid,
           job.id, 1, 'succeeded', compute_node.id, profile.id,
           '00000000-0000-4000-8000-000000000701', 1,
           'accepted_no_output', false, clock_timestamp(), clock_timestamp(),
           clock_timestamp(), clock_timestamp()
    FROM job, compute_node, profile
    RETURNING id
)
INSERT INTO compute.worker_instances (
    id, node_id, compute_plugin_id, model_profile_id, image_reference,
    architecture, generation, node_generation, lifecycle_state, health_state,
    health_observed_at, health_generation, resources,
    max_concurrent_attempts, control_lease_id, control_fencing_token,
    attempt_id
)
SELECT '00000000-0000-4000-8000-000000000701'::uuid,
       compute_node.id, plugin.id, profile.id,
       'registry.local/worker@sha256:' || repeat('ef', 32),
       'linux/arm64/v8', 1, compute_node.generation, 'stopped', 'unknown',
       clock_timestamp(), 1,
       '{
         "cpuMillis":1000,
         "unifiedMemoryBytes":8192,
         "storageBytes":1024,
         "networkBitsPerSecond":1000000,
         "acceleratorUnits":1,
         "codecSessions":0
       }',
       1, '00000000-0000-4000-8000-000000000702'::uuid, 5, attempt.id
FROM plugin, profile, compute_node, attempt;

UPDATE compute.worker_instances
SET generation = 2,
    lifecycle_state = 'preparing',
    health_state = 'starting',
    health_generation = 2
WHERE id = '00000000-0000-4000-8000-000000000701'::uuid;

UPDATE compute.worker_instances
SET lifecycle_state = 'ready',
    health_state = 'healthy',
    loaded_at = clock_timestamp(),
    idle_since = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000000701'::uuid;

UPDATE compute.worker_instances
SET lifecycle_state = 'busy',
    active_attempt_ids = ARRAY['00000000-0000-4000-8000-000000000703'::uuid],
    attempt_states = '{"00000000-0000-4000-8000-000000000703":"running"}',
    attempt_bindings = '{"00000000-0000-4000-8000-000000000703":{"leaseId":"00000000-0000-4000-8000-000000000706","fencingToken":6,"revision":1,"boundAt":"2026-08-15T00:00:00.000Z"}}',
    binding_revision = 1,
    idle_since = NULL
WHERE id = '00000000-0000-4000-8000-000000000701'::uuid;

DO $$
DECLARE
    worker compute.worker_instances%ROWTYPE;
BEGIN
    SELECT * INTO worker FROM compute.worker_instances
    WHERE id = '00000000-0000-4000-8000-000000000701'::uuid;
    IF worker.lifecycle_state <> 'busy'
       OR cardinality(worker.active_attempt_ids) <> 1
       OR worker.attempt_bindings -> '00000000-0000-4000-8000-000000000703' ->> 'leaseId'
          <> '00000000-0000-4000-8000-000000000706'
       OR worker.binding_revision <> 1
       OR worker.control_fencing_token <> 5 THEN
        RAISE EXCEPTION 'worker lifecycle projection did not persist';
    END IF;

    BEGIN
        UPDATE compute.worker_instances
        SET lifecycle_state = 'circuit_open',
            active_attempt_ids = '{}'::uuid[],
            attempt_states = '{}'::jsonb
        WHERE id = '00000000-0000-4000-8000-000000000701'::uuid;
        RAISE EXCEPTION 'circuit without expiry was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

UPDATE compute.worker_instances
SET lifecycle_state = 'circuit_open',
    health_state = 'unhealthy',
    health_reason_code = 'model_load_crash',
    active_attempt_ids = '{}'::uuid[],
    attempt_states = '{}'::jsonb,
    attempt_bindings = '{}'::jsonb,
    binding_revision = 2,
    loaded_at = NULL,
    crash_timestamps = ARRAY[clock_timestamp()],
    crash_count = 1,
    next_retry_at = moment.until,
    circuit_open_until = moment.until,
    last_failure_code = 'model_load_crash'
FROM (SELECT clock_timestamp() + interval '5 minutes' AS until) AS moment
WHERE id = '00000000-0000-4000-8000-000000000701'::uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM compute.worker_instances
        WHERE lifecycle_state = 'circuit_open'
          AND crash_count = 1
          AND next_retry_at = circuit_open_until
    ) THEN
        RAISE EXCEPTION 'valid circuit state was not persisted';
    END IF;
END;
$$;

ROLLBACK;
