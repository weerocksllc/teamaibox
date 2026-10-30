CREATE TABLE compute.protected_office_deployment_actions (
    run_id text NOT NULL CHECK (
        run_id ~ '^protected-office-set-deployment-[0-9]{8}-a[1-9][0-9]*$'
    ),
    action text NOT NULL CHECK (action IN (
        'preflight', 'cold-boot', 'concurrent-office', 'bounded-maintenance',
        'restart-verify', 'mid-sequence-failure', 'final-inspect', 'recover', 'cleanup'
    )),
    action_id uuid NOT NULL UNIQUE,
    idempotency_key bytea NOT NULL UNIQUE CHECK (octet_length(idempotency_key) = 32),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    action_state text NOT NULL CHECK (action_state IN (
        'running', 'recovering', 'succeeded', 'failed'
    )),
    recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count BETWEEN 0 AND 32),
    result_digest bytea CHECK (result_digest IS NULL OR octet_length(result_digest) = 32),
    result jsonb CHECK (
        result IS NULL OR (
            jsonb_typeof(result) = 'object'
            AND pg_column_size(result) BETWEEN 2 AND 4194304
        )
    ),
    failure_code text CHECK (
        failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,127}$'
    ),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    persisted_at timestamptz,
    PRIMARY KEY (run_id, action),
    CHECK (updated_at >= created_at),
    CHECK (persisted_at IS NULL OR persisted_at >= created_at),
    CHECK (
        (action_state = 'succeeded'
         AND result_digest IS NOT NULL AND result IS NOT NULL
         AND failure_code IS NULL AND persisted_at IS NOT NULL)
        OR
        (action_state = 'failed'
         AND result_digest IS NULL AND result IS NULL
         AND failure_code IS NOT NULL AND persisted_at IS NOT NULL)
        OR
        (action_state IN ('running','recovering')
         AND result_digest IS NULL AND result IS NULL
         AND failure_code IS NULL AND persisted_at IS NULL)
    )
);

CREATE INDEX protected_office_deployment_actions_recovery_idx
ON compute.protected_office_deployment_actions (action_state, created_at, run_id, action)
WHERE action_state IN ('running','recovering');

CREATE FUNCTION compute.guard_protected_office_deployment_action()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'protected deployment action journal rows cannot be deleted'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.revision <> 1 OR NEW.action_state <> 'running'
           OR NEW.recovery_count <> 0 OR NEW.result_digest IS NOT NULL
           OR NEW.result IS NOT NULL OR NEW.failure_code IS NOT NULL
           OR NEW.persisted_at IS NOT NULL OR NEW.updated_at <> NEW.created_at THEN
            RAISE EXCEPTION 'protected deployment action must begin as an empty running journal'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.action_state IN ('succeeded','failed') THEN
        RAISE EXCEPTION 'terminal protected deployment action cannot change'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'protected deployment action revision is stale'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.action_id IS DISTINCT FROM OLD.action_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'protected deployment action immutable identity changed'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.action_state = 'recovering' THEN
        IF OLD.action_state <> 'running' OR NEW.recovery_count <> OLD.recovery_count + 1 THEN
            RAISE EXCEPTION 'protected deployment action recovery must be journaled before replay'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.action_state = 'running' THEN
        IF OLD.action_state <> 'recovering' OR NEW.recovery_count <> OLD.recovery_count THEN
            RAISE EXCEPTION 'protected deployment action may resume only after recovery'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.action_state IN ('succeeded','failed') THEN
        IF OLD.action_state NOT IN ('running','recovering')
           OR NEW.recovery_count <> OLD.recovery_count THEN
            RAISE EXCEPTION 'protected deployment action terminal transition is invalid'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        RAISE EXCEPTION 'protected deployment action state transition is invalid'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protected_office_deployment_action_guard
BEFORE INSERT OR UPDATE OR DELETE ON compute.protected_office_deployment_actions
FOR EACH ROW EXECUTE FUNCTION compute.guard_protected_office_deployment_action();

