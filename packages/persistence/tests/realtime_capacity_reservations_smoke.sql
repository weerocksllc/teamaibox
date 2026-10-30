\set ON_ERROR_STOP on
BEGIN;

WITH owner AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'realtime-owner', 'realtime-owner', 'Realtime Owner',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), capability AS (
    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES ('realtime-smoke.translation', 'realtime', 'v1', '["realtime.sessions"]')
    RETURNING id
), profile AS (
    INSERT INTO compute.model_profiles (
        profile_key, capability_id, source_model, source_revision,
        engine, engine_version, precision, artifact_digest,
        compatibility, declared_resources, measured_envelope,
        certification_state
    )
    SELECT 'realtime-smoke.profile', capability.id,
           'local/realtime-translation', 'v1', 'test-engine', '1.0.0',
           'nvfp4', 'sha256:' || repeat('bc', 32),
           '{"architectures":["linux/arm64/v8"]}',
           '{"cpuMillis":1000,"unifiedMemoryBytes":2048}',
           '{"cpuMillis":1000,"unifiedMemoryBytes":2048}', 'certified'
    FROM capability RETURNING id
), compute_node AS (
    INSERT INTO compute.nodes (
        node_key, architecture, trust_kind, lifecycle_state, generation, capacity
    ) VALUES (
        'realtime-smoke-node', 'arm64', 'managed_appliance', 'ready', 7,
        '{
          "cpuMillis":8000,
          "unifiedMemoryBytes":16384,
          "acceleratorUnits":1,
          "codecSessions":4,
          "storageBytes":1048576,
          "networkBitsPerSecond":10000000000,
          "codec":{"encodeSessions":2,"decodeSessions":4}
        }'
    ) RETURNING id, generation
)
INSERT INTO compute.realtime_sessions (
    id, admission_key, owner_identity_id, correlation_id, capability_key,
    requested_model, model_profile_id, node_id, node_generation, route,
    latency_budget_milliseconds, reservation, codec_directions,
    lease_token, fencing_token, admitted_at, connection_deadline_at,
    expires_at, heartbeat_at
)
SELECT '00000000-0000-4000-8000-000000000901'::uuid,
       '00000000-0000-4000-8000-000000000902'::uuid,
       owner.id, 'request-realtime-smoke', 'translation',
       'local/realtime-translation', profile.id, compute_node.id,
       compute_node.generation, 'local', 250,
       '{
         "cpuMillis":1000,
         "unifiedMemoryBytes":2048,
         "acceleratorUnits":0,
         "codecSessions":1,
         "storageBytes":0,
         "networkBitsPerSecond":100000000
       }',
       '{"encodeSessions":0,"decodeSessions":1}',
       '00000000-0000-4000-8000-000000000903'::uuid, 9,
       clock_timestamp(), clock_timestamp() + interval '30 seconds',
       clock_timestamp() + interval '5 minutes', clock_timestamp()
FROM owner, profile, compute_node;

DO $$
DECLARE
    session compute.realtime_sessions%ROWTYPE;
BEGIN
    SELECT * INTO session FROM compute.realtime_sessions
    WHERE id = '00000000-0000-4000-8000-000000000901'::uuid;
    IF session.state <> 'admitted'
       OR session.priority_class <> 'latency'
       OR session.scheduler_priority <> 100
       OR (session.reservation->>'networkBitsPerSecond')::bigint <> 100000000
       OR (session.codec_directions->>'decodeSessions')::bigint <> 1 THEN
        RAISE EXCEPTION 'realtime latency reservation was not persisted exactly';
    END IF;

    BEGIN
        INSERT INTO compute.realtime_sessions (
            id, admission_key, owner_identity_id, capability_key,
            node_id, node_generation, route, latency_budget_milliseconds,
            reservation, codec_directions, lease_token, fencing_token,
            admitted_at, connection_deadline_at, expires_at, heartbeat_at
        ) VALUES (
            uuidv7(), session.admission_key, session.owner_identity_id, 'translation',
            session.node_id, session.node_generation, 'local', 250,
            session.reservation, session.codec_directions, uuidv7(), 10,
            clock_timestamp(), clock_timestamp() + interval '30 seconds',
            clock_timestamp() + interval '5 minutes', clock_timestamp()
        );
        RAISE EXCEPTION 'duplicate realtime admission key was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO compute.realtime_sessions (
            id, admission_key, owner_identity_id, capability_key,
            node_id, node_generation, route, latency_budget_milliseconds,
            reservation, codec_directions, lease_token, fencing_token,
            admitted_at, connection_deadline_at, expires_at, heartbeat_at
        ) VALUES (
            uuidv7(), uuidv7(), session.owner_identity_id, 'translation',
            session.node_id, session.node_generation, 'local', 250,
            session.reservation, '{"encodeSessions":-1,"decodeSessions":0}',
            uuidv7(), 11, clock_timestamp(),
            clock_timestamp() + interval '30 seconds',
            clock_timestamp() + interval '5 minutes', clock_timestamp()
        );
        RAISE EXCEPTION 'negative codec direction was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

UPDATE compute.realtime_sessions
SET state = 'connected',
    connection_id = '00000000-0000-4000-8000-000000000904'::uuid,
    connected_at = clock_timestamp(),
    heartbeat_at = clock_timestamp()
WHERE id = '00000000-0000-4000-8000-000000000901'::uuid;

UPDATE compute.realtime_sessions
SET state = 'released', released_at = clock_timestamp(),
    release_reason = 'websocket_disconnect'
WHERE id = '00000000-0000-4000-8000-000000000901'::uuid;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM compute.realtime_sessions
        WHERE id = '00000000-0000-4000-8000-000000000901'::uuid
          AND state IN ('admitted','connected')
    ) THEN
        RAISE EXCEPTION 'disconnect did not leave active capacity accounting';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM compute.realtime_sessions
        WHERE id = '00000000-0000-4000-8000-000000000901'::uuid
          AND state = 'released'
          AND release_reason = 'websocket_disconnect'
          AND released_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'disconnect release evidence was not retained';
    END IF;
END;
$$;

ROLLBACK;
