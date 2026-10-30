\set ON_ERROR_STOP on
BEGIN;

WITH owner AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'lease-owner', 'lease-owner', 'Lease Owner',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), capability AS (
    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES ('lease-smoke.chat', 'chat', 'v1', '["responses"]')
    RETURNING id
), profile AS (
    INSERT INTO compute.model_profiles (
        profile_key, capability_id, source_model, source_revision,
        engine, engine_version, precision, artifact_digest,
        compatibility, declared_resources, measured_envelope,
        certification_state
    )
    SELECT 'lease-smoke.profile', capability.id, 'local/lease-smoke', 'v1',
           'test-engine', '1.0.0', 'nvfp4', 'sha256:' || repeat('ab', 32),
           '{"architectures":["linux/arm64/v8"]}',
           '{"cpuMillis":1000,"unifiedMemoryBytes":4096}',
           '{"cpuMillis":1000,"unifiedMemoryBytes":4096}', 'certified'
    FROM capability RETURNING id, capability_id
), compute_node AS (
    INSERT INTO compute.nodes (
        node_key, architecture, trust_kind, lifecycle_state, generation,
        labels, capacity
    ) VALUES (
        'lease-smoke-node', 'arm64', 'managed_appliance', 'ready', 7,
        '{"localAppliance":true}',
        '{
          "cpuMillis":10000,
          "unifiedMemoryBytes":32768,
          "acceleratorUnits":2,
          "codecSessions":2,
          "storageBytes":1048576,
          "networkBitsPerSecond":1000000000
        }'
    ) RETURNING id, generation
), first_job AS (
    INSERT INTO compute.jobs (
        owner_identity_id, capability_id, operation, status,
        requested_model_profile_id, correlation_key
    )
    SELECT owner.id, profile.capability_id, 'responses', 'queued', profile.id,
           'request-lease-smoke-first'
    FROM owner, profile RETURNING id
), second_job AS (
    INSERT INTO compute.jobs (
        owner_identity_id, capability_id, operation, status,
        requested_model_profile_id, correlation_key
    )
    SELECT owner.id, profile.capability_id, 'responses', 'queued', profile.id,
           'request-lease-smoke-second'
    FROM owner, profile RETURNING id
), first_attempt AS (
    INSERT INTO compute.attempts (
        job_id, attempt_number, status, node_id, model_profile_id,
        dispatch_fence, acceptance_state
    )
    SELECT first_job.id, 1, 'pending', compute_node.id, profile.id,
           1, 'not_accepted'
    FROM first_job, compute_node, profile RETURNING id, job_id
), second_attempt AS (
    INSERT INTO compute.attempts (
        job_id, attempt_number, status, node_id, model_profile_id,
        dispatch_fence, acceptance_state
    )
    SELECT second_job.id, 1, 'pending', compute_node.id, profile.id,
           2, 'not_accepted'
    FROM second_job, compute_node, profile RETURNING id, job_id
), first_lease AS (
    INSERT INTO compute.lease_sets (
        acquisition_key, node_id, node_generation, job_id, attempt_id,
        model_profile_id, lease_token, fencing_token, reservation,
        acquired_at, heartbeat_at, expires_at
    )
    SELECT uuidv7(), compute_node.id, compute_node.generation,
           first_attempt.job_id, first_attempt.id, profile.id,
           uuidv7(), 1,
           '{
             "cpuMillis":2000,
             "unifiedMemoryBytes":8192,
             "acceleratorUnits":1,
             "codecSessions":0,
             "storageBytes":1024,
             "networkBitsPerSecond":100
           }',
           clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 seconds'
    FROM compute_node, first_attempt, profile RETURNING *
), second_lease AS (
    INSERT INTO compute.lease_sets (
        acquisition_key, node_id, node_generation, job_id, attempt_id,
        model_profile_id, lease_token, fencing_token, reservation,
        acquired_at, heartbeat_at, expires_at
    )
    SELECT uuidv7(), compute_node.id, compute_node.generation,
           second_attempt.job_id, second_attempt.id, profile.id,
           uuidv7(), 2,
           '{
             "cpuMillis":2000,
             "unifiedMemoryBytes":8192,
             "acceleratorUnits":1,
             "codecSessions":0,
             "storageBytes":1024,
             "networkBitsPerSecond":100
           }',
           clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 seconds'
    FROM compute_node, second_attempt, profile RETURNING *
), first_resource AS (
    INSERT INTO compute.leases (
        resource_kind, resource_key, job_id, attempt_id, lease_token,
        fencing_token, reservation, acquired_at, expires_at, heartbeat_at,
        lease_set_id, node_id, amount
    )
    SELECT 'cpu', first_lease.node_id || ':cpu', first_lease.job_id,
           first_lease.attempt_id, uuidv7(), first_lease.fencing_token,
           '{"resourceKey":"cpuMillis","amount":2000}',
           first_lease.acquired_at, first_lease.expires_at,
           first_lease.heartbeat_at, first_lease.id, first_lease.node_id, 2000
    FROM first_lease RETURNING resource_key
)
INSERT INTO compute.leases (
    resource_kind, resource_key, job_id, attempt_id, lease_token,
    fencing_token, reservation, acquired_at, expires_at, heartbeat_at,
    lease_set_id, node_id, amount
)
SELECT 'cpu', second_lease.node_id || ':cpu', second_lease.job_id,
       second_lease.attempt_id, uuidv7(), second_lease.fencing_token,
       '{"resourceKey":"cpuMillis","amount":2000}',
       second_lease.acquired_at, second_lease.expires_at,
       second_lease.heartbeat_at, second_lease.id, second_lease.node_id, 2000
FROM second_lease, first_resource;

DO $$
DECLARE
    first_set compute.lease_sets%ROWTYPE;
    second_set compute.lease_sets%ROWTYPE;
    next_fence bigint;
    claimed_dispatch uuid;
BEGIN
    SELECT * INTO first_set FROM compute.lease_sets
    WHERE fencing_token = 1 AND state = 'active';
    SELECT * INTO second_set FROM compute.lease_sets
    WHERE fencing_token = 2 AND state = 'active';

    IF first_set.id IS NULL OR second_set.id IS NULL THEN
        RAISE EXCEPTION 'transactional lease sets were not created';
    END IF;
    IF (SELECT count(*) FROM compute.leases
        WHERE resource_key = first_set.node_id || ':cpu' AND state = 'active') <> 2 THEN
        RAISE EXCEPTION 'shared additive resource leases were incorrectly serialized';
    END IF;

    INSERT INTO compute.node_lease_fences (node_id, next_fencing_token)
    VALUES (first_set.node_id, 2)
    ON CONFLICT (node_id) DO UPDATE
    SET next_fencing_token = compute.node_lease_fences.next_fencing_token + 1
    RETURNING next_fencing_token - 1 INTO next_fence;
    IF next_fence <> 1 THEN
        RAISE EXCEPTION 'first fencing token was not monotonic';
    END IF;

    INSERT INTO compute.node_lease_fences (node_id, next_fencing_token)
    VALUES (first_set.node_id, 2)
    ON CONFLICT (node_id) DO UPDATE
    SET next_fencing_token = compute.node_lease_fences.next_fencing_token + 1
    RETURNING next_fencing_token - 1 INTO next_fence;
    IF next_fence <> 2 THEN
        RAISE EXCEPTION 'second fencing token was not monotonic';
    END IF;

    UPDATE compute.lease_sets
    SET heartbeat_at = acquired_at + interval '5 seconds',
        expires_at = acquired_at + interval '35 seconds'
    WHERE id = first_set.id;
    UPDATE compute.leases
    SET heartbeat_at = acquired_at + interval '5 seconds',
        expires_at = acquired_at + interval '35 seconds'
    WHERE lease_set_id = first_set.id;

    UPDATE compute.lease_sets
    SET dispatch_state = 'claimed', dispatch_id = uuidv7(),
        dispatched_at = acquired_at + interval '6 seconds'
    WHERE id = first_set.id
    RETURNING dispatch_id INTO claimed_dispatch;
    UPDATE compute.lease_sets
    SET dispatch_state = 'accepted', accepted_at = acquired_at + interval '7 seconds'
    WHERE id = first_set.id;

    BEGIN
        UPDATE compute.lease_sets
        SET dispatch_state = 'claimed', dispatch_id = claimed_dispatch,
            dispatched_at = acquired_at + interval '6 seconds'
        WHERE id = second_set.id;
        RAISE EXCEPTION 'expected duplicate dispatch identity rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO compute.leases (
            resource_kind, resource_key, job_id, attempt_id, lease_token,
            fencing_token, reservation, expires_at,
            lease_set_id, node_id, amount
        ) VALUES (
            'exclusive', first_set.node_id || ':exclusive', first_set.job_id,
            first_set.attempt_id, uuidv7(), first_set.fencing_token,
            '{"amount":1}', clock_timestamp() + interval '30 seconds',
            first_set.id, first_set.node_id, 1
        );
        INSERT INTO compute.leases (
            resource_kind, resource_key, job_id, attempt_id, lease_token,
            fencing_token, reservation, expires_at,
            lease_set_id, node_id, amount
        ) VALUES (
            'exclusive', first_set.node_id || ':exclusive', second_set.job_id,
            second_set.attempt_id, uuidv7(), second_set.fencing_token,
            '{"amount":1}', clock_timestamp() + interval '30 seconds',
            second_set.id, second_set.node_id, 1
        );
        RAISE EXCEPTION 'expected active exclusive resource conflict';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE compute.lease_sets
        SET expires_at = acquired_at
        WHERE id = second_set.id;
        RAISE EXCEPTION 'expected invalid lease expiry rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    UPDATE compute.lease_sets
    SET state = 'expired', dispatch_state = 'cancelled',
        released_at = clock_timestamp(), release_reason = 'lease_expired'
    WHERE id = second_set.id;
    UPDATE compute.leases
    SET state = 'expired', released_at = clock_timestamp()
    WHERE lease_set_id = second_set.id;

    IF EXISTS (
        SELECT 1 FROM compute.lease_sets
        WHERE id = second_set.id AND (state <> 'expired' OR released_at IS NULL)
    ) THEN
        RAISE EXCEPTION 'expired lease was not durably fenced';
    END IF;
END;
$$;

ROLLBACK;
