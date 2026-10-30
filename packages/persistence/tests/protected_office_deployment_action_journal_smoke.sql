\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.protected_office_deployment_actions (
    run_id, action, action_id, idempotency_key, request_digest,
    action_state, created_at, updated_at
) VALUES (
    'protected-office-set-deployment-v5-20260905-a1', 'cold-boot',
    '00000000-0000-4000-8000-000000000101'::uuid,
    decode(repeat('a', 64), 'hex'), decode(repeat('b', 64), 'hex'),
    'running', '2026-09-05T04:00:00.000Z', '2026-09-05T04:00:00.000Z'
);

UPDATE compute.protected_office_deployment_actions
SET revision=2, action_state='recovering', recovery_count=1,
    updated_at='2026-09-05T04:01:00.000Z'
WHERE run_id='protected-office-set-deployment-v5-20260905-a1' AND action='cold-boot';

UPDATE compute.protected_office_deployment_actions
SET revision=3, action_state='running',
    updated_at='2026-09-05T04:02:00.000Z'
WHERE run_id='protected-office-set-deployment-v5-20260905-a1' AND action='cold-boot';

UPDATE compute.protected_office_deployment_actions
SET revision=4, action_state='succeeded',
    result_digest=decode(repeat('c', 64), 'hex'), result='{"status":"healthy"}'::jsonb,
    updated_at='2026-09-05T04:03:00.000Z', persisted_at='2026-09-05T04:03:00.000Z'
WHERE run_id='protected-office-set-deployment-v5-20260905-a1' AND action='cold-boot';

DO $$
BEGIN
    BEGIN
        UPDATE compute.protected_office_deployment_actions
        SET revision=5, updated_at='2026-09-05T04:04:00.000Z'
        WHERE run_id='protected-office-set-deployment-v5-20260905-a1' AND action='cold-boot';
        RAISE EXCEPTION 'terminal protected deployment action was rewritten';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        DELETE FROM compute.protected_office_deployment_actions
        WHERE run_id='protected-office-set-deployment-v5-20260905-a1' AND action='cold-boot';
        RAISE EXCEPTION 'protected deployment action was deleted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF NOT EXISTS (
        SELECT 1 FROM compute.protected_office_deployment_actions
        WHERE run_id='protected-office-set-deployment-v5-20260905-a1'
          AND action='cold-boot' AND action_state='succeeded'
          AND revision=4 AND recovery_count=1 AND result->>'status'='healthy'
    ) THEN RAISE EXCEPTION 'protected deployment action journal did not persist';
    END IF;
END;
$$;

ROLLBACK;
