\set ON_ERROR_STOP on
BEGIN;

WITH task_owner AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'task-owner', 'task-owner', 'Task Owner',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), capability AS (
    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES ('task-smoke.asr', 'asr', 'v1', '["audio.transcriptions"]')
    RETURNING id
), job AS (
    INSERT INTO compute.jobs (
        owner_identity_id, capability_id, idempotency_scope, idempotency_key
    )
    SELECT task_owner.id, capability.id, 'task-smoke', 'task-smoke-1'
    FROM task_owner, capability
    RETURNING id
), queued_event AS (
    INSERT INTO compute.job_events (
        job_id, event_kind, public_state, progress, message_key
    )
    SELECT id, 'state', 'queued', 0, 'tasks.state.queued' FROM job
    RETURNING sequence_id, job_id
), progress_event AS (
    INSERT INTO compute.job_events (
        job_id, event_kind, public_state, progress, message_key, payload
    )
    SELECT job_id, 'progress', 'running', 68, 'tasks.asr.transcribing',
           '{"shard":7,"shards":10}'::jsonb
    FROM queued_event
    RETURNING sequence_id
), confirmation AS (
    INSERT INTO platform.agent_operation_confirmations (
        owner_identity_id, agent_session_key, operation_kind,
        title_key, operation_scope, expires_at
    )
    SELECT id, 'agent-session-smoke', 'filesystem_write',
           'agent.confirm.write_file', '{"path":"/workspace/report.md"}'::jsonb,
           clock_timestamp() + interval '5 minutes'
    FROM task_owner
    RETURNING id
)
SELECT 1;

DO $$
DECLARE
    confirmation_id uuid;
    owner_id uuid;
BEGIN
    IF (SELECT count(*) FROM compute.job_events) <> 2 THEN
        RAISE EXCEPTION 'task events were not persisted';
    END IF;
    IF (SELECT max(progress) FROM compute.job_events) <> 68 THEN
        RAISE EXCEPTION 'task progress was not persisted';
    END IF;
    IF (SELECT count(*) FROM platform.agent_operation_confirmations WHERE status = 'pending') <> 1 THEN
        RAISE EXCEPTION 'Agent operation confirmation was not persisted separately';
    END IF;

    SELECT id, owner_identity_id INTO confirmation_id, owner_id
    FROM platform.agent_operation_confirmations LIMIT 1;
    UPDATE platform.agent_operation_confirmations
    SET status = 'approved', decided_at = clock_timestamp(), decided_by_identity_id = owner_id
    WHERE id = confirmation_id;

    BEGIN
        INSERT INTO compute.job_events (
            job_id, event_kind, public_state, progress, message_key
        )
        SELECT id, 'progress', 'running', 101, 'tasks.progress.invalid'
        FROM compute.jobs LIMIT 1;
        RAISE EXCEPTION 'expected invalid progress rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO platform.agent_operation_confirmations (
            owner_identity_id, agent_session_key, operation_kind,
            title_key, operation_scope, status, expires_at
        ) VALUES (
            owner_id, 'agent-session-invalid', 'filesystem_write',
            'agent.confirm.write_file', '{}'::jsonb, 'approved',
            clock_timestamp() + interval '5 minutes'
        );
        RAISE EXCEPTION 'expected undecided approved confirmation rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;

