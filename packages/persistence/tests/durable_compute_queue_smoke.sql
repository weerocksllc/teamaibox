\set ON_ERROR_STOP on
BEGIN;

WITH owner AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'queue-owner', 'queue-owner', 'Queue Owner',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), capability AS (
    INSERT INTO compute.capabilities (
        capability_key, modality, contract_version, api_operations
    ) VALUES (
        'queue-smoke.chat', 'chat', 'v1', '["responses","chat.completions"]'
    ) RETURNING id
), job AS (
    INSERT INTO compute.jobs (
        owner_identity_id, capability_id, requested_model, operation,
        response_id, route, status, priority, idempotency_scope, idempotency_key,
        request_digest, request_size_bytes, request_artifact, data_class,
        correlation_key, deadline_at
    )
    SELECT owner.id, capability.id, 'local/reasoning', 'responses',
           'resp_queue_smoke_0001', 'unassigned', 'queued', 70,
           'responses', 'queue-smoke-idempotency', decode(repeat('ab', 32), 'hex'),
           128,
           jsonb_build_object(
               'schemaVersion', 1,
               'artifactId', uuidv7(),
               'object', jsonb_build_object(
                   'objectId', uuidv7(), 'objectVersion', 1, 'referenceId', uuidv7()
               ),
               'integrity', jsonb_build_object('algorithm', 'sha256', 'digest', repeat('ab', 32))
           ),
           'confidential', 'request-queue-smoke-0001', clock_timestamp() + interval '1 hour'
    FROM owner, capability
    RETURNING id
)
INSERT INTO compute.job_events (
    job_id, event_kind, public_state, progress, progress_revision, message_key
)
SELECT id, 'state', 'queued', 0, 1, 'tasks.state.queued' FROM job;

DO $$
DECLARE
    queue_job_id uuid;
BEGIN
    SELECT id INTO queue_job_id FROM compute.jobs
    WHERE idempotency_key = 'queue-smoke-idempotency';

    IF NOT EXISTS (
        SELECT 1 FROM compute.job_quota_policies
        WHERE scope_kind = 'appliance' AND scope_key = '*'
          AND enabled AND max_request_bytes = 1048576
    ) THEN
        RAISE EXCEPTION 'default durable queue quota policy is missing';
    END IF;

    IF EXISTS (
        SELECT 1 FROM compute.jobs
        WHERE request_metadata::text LIKE '%launch plan%'
           OR request_artifact::text LIKE '%launch plan%'
           OR result_metadata::text LIKE '%launch plan%'
    ) THEN
        RAISE EXCEPTION 'compute job metadata contains user payload plaintext';
    END IF;

    UPDATE compute.jobs
    SET status = 'preparing', waiting_reason = 'worker_preparing',
        progress_sequence = 1, progress_value = 0.2,
        progress_message_key = 'tasks.compute.loading'
    WHERE id = queue_job_id;

    INSERT INTO compute.job_events (
        job_id, event_kind, public_state, progress, progress_revision,
        message_key, payload
    ) VALUES (
        queue_job_id, 'progress', 'preparing', 20, 1,
        'tasks.compute.loading', '{"stage":"model_load"}'::jsonb
    );

    UPDATE compute.jobs
    SET status = 'running', waiting_reason = NULL,
        progress_sequence = 2, progress_value = 0.7,
        progress_message_key = 'tasks.compute.executing',
        cancel_requested_at = clock_timestamp()
    WHERE id = queue_job_id;

    UPDATE compute.jobs
    SET status = 'succeeded', progress_sequence = 3, progress_value = 1,
        result_schema = 'teamaibox.ai.response.v1',
        result_artifact = jsonb_build_object(
            'schemaVersion', 1,
            'artifactId', uuidv7(),
            'object', jsonb_build_object(
                'objectId', uuidv7(), 'objectVersion', 1, 'referenceId', uuidv7()
            )
        ),
        retry_classification = 'terminal', terminal_at = clock_timestamp()
    WHERE id = queue_job_id;

    INSERT INTO compute.job_events (
        job_id, event_kind, public_state, progress, progress_revision, message_key
    ) VALUES (
        queue_job_id, 'result', 'completed', 100, 1, 'tasks.state.completed'
    );

    IF (SELECT status FROM compute.jobs WHERE id = queue_job_id) <> 'succeeded'
       OR (SELECT count(*) FROM compute.job_events WHERE job_id = queue_job_id) <> 3 THEN
        RAISE EXCEPTION 'durable job state or resumable events were not persisted';
    END IF;

    BEGIN
        INSERT INTO compute.jobs (
            owner_identity_id, capability_id, operation,
            idempotency_scope, idempotency_key
        )
        SELECT owner_identity_id, capability_id, 'responses',
               'responses', 'queue-smoke-idempotency'
        FROM compute.jobs WHERE id = queue_job_id;
        RAISE EXCEPTION 'expected duplicate idempotency rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO compute.jobs (
            owner_identity_id, capability_id, operation, response_id
        )
        SELECT owner_identity_id, capability_id, 'responses', 'resp_queue_smoke_0001'
        FROM compute.jobs WHERE id = queue_job_id;
        RAISE EXCEPTION 'expected duplicate response identity rejection';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO compute.job_quota_policies (
            scope_kind, scope_key, max_queued, max_active,
            max_daily_submissions, max_request_bytes
        ) VALUES ('owner', 'invalid', 0, 1, 1, 1);
        RAISE EXCEPTION 'expected invalid quota rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE compute.jobs SET progress_value = 1.1 WHERE id = queue_job_id;
        RAISE EXCEPTION 'expected invalid progress rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;
