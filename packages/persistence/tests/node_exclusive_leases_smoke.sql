\set ON_ERROR_STOP on
BEGIN;

WITH owner AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'exclusive-owner', 'exclusive-owner', 'Exclusive Owner',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), capability AS (
    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES ('exclusive-smoke.image', 'image', 'v1', '["images.generations"]')
    RETURNING id
), profile AS (
    INSERT INTO compute.model_profiles (
        profile_key, capability_id, source_model, source_revision,
        engine, engine_version, precision, artifact_digest,
        compatibility, declared_resources, measured_envelope,
        certification_state, exclusive
    )
    SELECT 'exclusive-smoke.profile', capability.id, 'local/exclusive-smoke',
           'v1', 'test-engine', '1.0.0', 'bf16',
           'sha256:' || repeat('ad', 32),
           '{"architectures":["linux/arm64/v8"]}',
           '{"cpuMillis":4000,"unifiedMemoryBytes":65536}',
           '{"cpuMillis":4000,"unifiedMemoryBytes":65536}',
           'certified', true
    FROM capability RETURNING id, capability_id
), compute_node AS (
    INSERT INTO compute.nodes (
        node_key, architecture, trust_kind, lifecycle_state, generation,
        capacity
    ) VALUES (
        'exclusive-smoke-node', 'arm64', 'managed_appliance', 'ready', 4,
        '{
          "cpuMillis":20000,
          "unifiedMemoryBytes":131072,
          "acceleratorUnits":1,
          "codecSessions":2,
          "storageBytes":1048576,
          "networkBitsPerSecond":10000000000
        }'
    ) RETURNING id, generation
), exclusive_job AS (
    INSERT INTO compute.jobs (
        owner_identity_id, capability_id, operation, status,
        requested_model_profile_id, correlation_key
    )
    SELECT owner.id, profile.capability_id, 'images.generations', 'queued',
           profile.id, 'request-exclusive-smoke'
    FROM owner, profile RETURNING id
), intent AS (
    INSERT INTO compute.node_exclusive_intents (
        id, node_id, job_id, requested_at, deadline_at
    )
    SELECT '00000000-0000-4000-8000-000000000801'::uuid,
           compute_node.id, exclusive_job.id, clock_timestamp(),
           clock_timestamp() + interval '5 minutes'
    FROM compute_node, exclusive_job
    RETURNING id, node_id, job_id
), attempt AS (
    INSERT INTO compute.attempts (
        job_id, attempt_number, status, node_id, model_profile_id,
        dispatch_fence, acceptance_state
    )
    SELECT intent.job_id, 1, 'pending', intent.node_id, profile.id,
           1, 'not_accepted'
    FROM intent, profile RETURNING id, job_id, node_id
), lease_set AS (
    INSERT INTO compute.lease_sets (
        acquisition_key, node_id, node_generation, job_id, attempt_id,
        model_profile_id, lease_token, fencing_token, reservation,
        acquired_at, heartbeat_at, expires_at, node_exclusive
    )
    SELECT uuidv7(), attempt.node_id, compute_node.generation,
           attempt.job_id, attempt.id, profile.id, uuidv7(), 1,
           '{
             "cpuMillis":4000,
             "unifiedMemoryBytes":65536,
             "acceleratorUnits":1,
             "codecSessions":0,
             "storageBytes":1024,
             "networkBitsPerSecond":1000000000
           }',
           clock_timestamp(), clock_timestamp(),
           clock_timestamp() + interval '1 minute', true
    FROM attempt, compute_node, profile RETURNING *
)
    INSERT INTO compute.leases (
        resource_kind, resource_key, job_id, attempt_id, lease_token,
        fencing_token, reservation, acquired_at, expires_at, heartbeat_at,
        lease_set_id, node_id, amount
    )
    SELECT 'exclusive', lease_set.node_id || ':exclusive', lease_set.job_id,
           lease_set.attempt_id, uuidv7(), lease_set.fencing_token,
           '{"resourceKey":"nodeExclusive","amount":1}',
           lease_set.acquired_at, lease_set.expires_at,
           lease_set.heartbeat_at, lease_set.id, lease_set.node_id, 1
    FROM lease_set;

UPDATE compute.node_exclusive_intents intent
SET state = 'acquired',
    lease_set_id = (
        SELECT lease_set.id
        FROM compute.lease_sets lease_set
        WHERE lease_set.job_id = intent.job_id
          AND lease_set.node_exclusive
          AND lease_set.state = 'active'
    )
WHERE intent.id = '00000000-0000-4000-8000-000000000801'::uuid
  AND intent.state = 'pending';

DO $$
DECLARE
    intent compute.node_exclusive_intents%ROWTYPE;
BEGIN
    SELECT * INTO intent FROM compute.node_exclusive_intents
    WHERE id = '00000000-0000-4000-8000-000000000801'::uuid;
    IF intent.state <> 'acquired' OR intent.lease_set_id IS NULL THEN
        RAISE EXCEPTION 'exclusive intent was not atomically linked to its lease';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM compute.lease_sets lease_set
        JOIN compute.leases lease ON lease.lease_set_id = lease_set.id
        WHERE lease_set.id = intent.lease_set_id
          AND lease_set.node_exclusive
          AND lease.resource_kind = 'exclusive'
          AND lease.state = 'active'
    ) THEN
        RAISE EXCEPTION 'exclusive lease resource was not persisted';
    END IF;

    BEGIN
        INSERT INTO compute.node_exclusive_intents (
            id, node_id, job_id, requested_at, deadline_at
        )
        SELECT uuidv7(), node_id, job_id, clock_timestamp(),
               clock_timestamp() + interval '1 minute'
        FROM compute.node_exclusive_intents WHERE id = intent.id;
        RAISE EXCEPTION 'second active exclusive intent was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;
