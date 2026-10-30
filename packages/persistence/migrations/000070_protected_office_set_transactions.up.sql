CREATE FUNCTION compute.protected_office_identity_array_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND (SELECT count(DISTINCT identity->>'workerId')
            FROM jsonb_array_elements(value) identity) = jsonb_array_length(value)
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(value) identity
           WHERE jsonb_typeof(identity) <> 'object'
              OR coalesce(identity->>'workerId', '') = ''
              OR coalesce(identity->>'modelProfileId', '') = ''
              OR coalesce(identity->>'imageDigest', '') !~ '^sha256:[a-f0-9]{64}$'
              OR coalesce(identity->>'configurationDigest', '') !~ '^sha256:[a-f0-9]{64}$'
              OR coalesce(identity->>'placementClass', '') <> 'protected-resident'
              OR coalesce(identity->>'maintenanceGeneration', '') !~ '^[1-9][0-9]*$'
              OR coalesce(identity->>'residentBytes', '') !~ '^[0-9]+$'
              OR coalesce(jsonb_typeof(identity->'healthy'), '') <> 'boolean'
              OR coalesce(identity->>'state', '') = ''
       );
$$;

CREATE FUNCTION compute.protected_office_previous_identities_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'object'
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_each(value) identity(worker_id, facts)
           WHERE worker_id = ''
              OR (facts <> 'null'::jsonb AND jsonb_typeof(facts) <> 'object')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'workerId', '') <> worker_id)
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'placementClass', '') <> 'protected-resident')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'maintenanceGeneration', '') !~ '^[1-9][0-9]*$')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'modelProfileId', '') = '')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'imageDigest', '') !~ '^sha256:[a-f0-9]{64}$')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'configurationDigest', '') !~ '^sha256:[a-f0-9]{64}$')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'state', '') = '')
              OR (facts <> 'null'::jsonb
                  AND coalesce(jsonb_typeof(facts->'healthy'), '') <> 'boolean')
              OR (facts <> 'null'::jsonb
                  AND coalesce(facts->>'residentBytes', '') !~ '^[0-9]+$')
       );
$$;

CREATE FUNCTION compute.protected_office_manifest_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'object'
       AND coalesce(value->>'setId', '') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$'
       AND coalesce(value->>'nodeId', '') <> ''
       AND coalesce(value->>'desiredStateRevision', '') ~ '^[1-9][0-9]*$'
       AND coalesce(value->>'maintenanceGeneration', '') ~ '^[1-9][0-9]*$'
       AND jsonb_typeof(value->'profiles') = 'array'
       AND jsonb_array_length(value->'profiles') > 0
       AND jsonb_typeof(value->'requiredModelProfileIds') = 'array'
       AND jsonb_array_length(value->'requiredModelProfileIds') =
           jsonb_array_length(value->'profiles')
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(value->'profiles') profile
           WHERE jsonb_typeof(profile) <> 'object'
              OR coalesce(profile->>'workerId', '') = ''
              OR coalesce(profile->>'modelProfileId', '') = ''
              OR coalesce(profile->>'imageDigest', '') !~ '^sha256:[a-f0-9]{64}$'
              OR coalesce(profile->>'configurationDigest', '') !~ '^sha256:[a-f0-9]{64}$'
              OR coalesce(profile->>'placementClass', '') <> 'protected-resident'
              OR coalesce(profile->>'maintenanceGeneration', '') <> value->>'maintenanceGeneration'
              OR coalesce(profile->>'declaredResidentBytes', '') !~ '^[1-9][0-9]*$'
              OR coalesce(profile->>'stageOrder', '') !~ '^[0-9]+$'
              OR coalesce(jsonb_typeof(profile->'dependsOnWorkerIds'), '') <> 'array'
              OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(profile->'dependsOnWorkerIds') dependency
                  WHERE jsonb_typeof(dependency) <> 'string'
                     OR dependency #>> '{}' = ''
              )
       )
       AND (SELECT count(DISTINCT profile->>'workerId')
            FROM jsonb_array_elements(value->'profiles') profile) =
           jsonb_array_length(value->'profiles')
       AND (SELECT count(DISTINCT profile->>'modelProfileId')
            FROM jsonb_array_elements(value->'profiles') profile) =
           jsonb_array_length(value->'profiles')
       AND (SELECT count(DISTINCT required #>> '{}')
            FROM jsonb_array_elements(value->'requiredModelProfileIds') required
            WHERE jsonb_typeof(required) = 'string' AND required #>> '{}' <> '') =
           jsonb_array_length(value->'requiredModelProfileIds')
       AND NOT EXISTS (
           SELECT profile->>'modelProfileId'
           FROM jsonb_array_elements(value->'profiles') profile
           EXCEPT
           SELECT required #>> '{}'
           FROM jsonb_array_elements(value->'requiredModelProfileIds') required
       );
$$;

CREATE FUNCTION compute.protected_office_steps_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND (SELECT count(DISTINCT step->>'workerId')
            FROM jsonb_array_elements(value) step) = jsonb_array_length(value)
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(value) step
           WHERE jsonb_typeof(step) <> 'object'
              OR coalesce(step->>'workerId', '') = ''
              OR coalesce(step->>'state', '') NOT IN (
                  'staging', 'staged', 'healthy'
              )
              OR (step->>'state' = 'healthy'
                  AND NOT compute.protected_office_identity_array_valid(
                      jsonb_build_array(step->'identity')
                  ))
       );
$$;

CREATE FUNCTION compute.protected_office_recovery_steps_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND (SELECT count(DISTINCT concat(step->>'workerId', ':', step->>'attempt'))
            FROM jsonb_array_elements(value) step) = jsonb_array_length(value)
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(value) step
           WHERE jsonb_typeof(step) <> 'object'
              OR coalesce(step->>'workerId', '') = ''
              OR coalesce(step->>'attempt', '') !~ '^[1-9][0-9]*$'
              OR coalesce(step->>'state', '') NOT IN ('restored', 'failed')
              OR (step->>'state' = 'failed'
                  AND coalesce(step->>'errorCode', '') = '')
       );
$$;

CREATE TABLE compute.protected_office_set_transactions (
    id text PRIMARY KEY CHECK (
        id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    ),
    set_id text NOT NULL CHECK (
        set_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$'
    ),
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    desired_state_revision bigint NOT NULL CHECK (desired_state_revision > 0),
    maintenance_generation bigint NOT NULL CHECK (maintenance_generation > 0),
    transaction_state text NOT NULL CHECK (
        transaction_state IN (
            'admitting', 'staging', 'probing', 'rolling-back',
            'recovery-required', 'succeeded', 'rolled-back'
        )
    ),
    manifest jsonb NOT NULL CHECK (
        compute.protected_office_manifest_valid(manifest)
    ),
    previous_identities jsonb NOT NULL CHECK (
        compute.protected_office_previous_identities_valid(previous_identities)
    ),
    maintenance_authorization jsonb CHECK (
        maintenance_authorization IS NULL
        OR jsonb_typeof(maintenance_authorization) = 'object'
    ),
    admission jsonb NOT NULL CHECK (jsonb_typeof(admission) = 'object'),
    steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        compute.protected_office_steps_valid(steps)
    ),
    recovery_steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        compute.protected_office_recovery_steps_valid(recovery_steps)
    ),
    observed_identities jsonb CHECK (
        observed_identities IS NULL
        OR compute.protected_office_identity_array_valid(observed_identities)
    ),
    failure_code text CHECK (
        failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,127}$'
    ),
    recovery_failures jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(recovery_failures) = 'array'
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    CHECK (updated_at >= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        (transaction_state IN ('succeeded', 'rolled-back')
         AND completed_at IS NOT NULL)
        OR
        (transaction_state NOT IN ('succeeded', 'rolled-back')
         AND completed_at IS NULL)
    ),
    CHECK (
        transaction_state <> 'succeeded'
        OR observed_identities IS NOT NULL
    ),
    CHECK (
        transaction_state NOT IN ('rolling-back', 'recovery-required', 'rolled-back')
        OR failure_code IS NOT NULL
    )
);

CREATE UNIQUE INDEX protected_office_set_transactions_one_active_idx
ON compute.protected_office_set_transactions (set_id)
WHERE transaction_state NOT IN ('succeeded', 'rolled-back');

CREATE INDEX protected_office_set_transactions_recovery_idx
ON compute.protected_office_set_transactions (
    transaction_state, updated_at, set_id, id
)
WHERE transaction_state NOT IN ('succeeded', 'rolled-back');

CREATE TABLE compute.protected_office_sets (
    set_id text PRIMARY KEY CHECK (
        set_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$'
    ),
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    desired_state_revision bigint NOT NULL CHECK (desired_state_revision > 0),
    observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
        AND observed_state_revision <= desired_state_revision
    ),
    maintenance_generation bigint NOT NULL CHECK (maintenance_generation > 0),
    recovery_state text NOT NULL CHECK (
        recovery_state IN ('healthy', 'degraded', 'recovering', 'manual-recovery')
    ),
    recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,127}$'
    ),
    healthy_identities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        compute.protected_office_identity_array_valid(healthy_identities)
    ),
    aggregate_resident_bytes bigint NOT NULL DEFAULT 0 CHECK (
        aggregate_resident_bytes >= 0
        AND aggregate_resident_bytes <= 68719476736
    ),
    last_transaction_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (updated_at >= created_at),
    CHECK (
        (recovery_state = 'healthy'
         AND recovery_reason_code IS NULL
         AND observed_state_revision = desired_state_revision)
        OR
        (recovery_state <> 'healthy' AND recovery_reason_code IS NOT NULL)
    ),
    CONSTRAINT protected_office_sets_last_transaction_fk
        FOREIGN KEY (last_transaction_id)
        REFERENCES compute.protected_office_set_transactions(id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX protected_office_sets_recovery_idx
ON compute.protected_office_sets (recovery_state, updated_at, set_id)
WHERE recovery_state <> 'healthy';

CREATE FUNCTION compute.enforce_protected_office_transaction_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    node_role text;
    valid_transition boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'protected office transaction journals cannot be deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT appliance_role INTO node_role
    FROM compute.nodes
    WHERE id = NEW.node_id;
    IF node_role IS DISTINCT FROM 'appliance-core' THEN
        RAISE EXCEPTION 'protected office transaction requires appliance-core node'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.transaction_state <> 'admitting' OR NEW.revision <> 1 THEN
            RAISE EXCEPTION 'protected office transaction must begin at admitting revision one'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.manifest->>'setId' IS DISTINCT FROM NEW.set_id
           OR NEW.manifest->>'nodeId' IS DISTINCT FROM NEW.node_id::text
           OR NEW.manifest->>'desiredStateRevision' IS DISTINCT FROM NEW.desired_state_revision::text
           OR NEW.manifest->>'maintenanceGeneration' IS DISTINCT FROM NEW.maintenance_generation::text
           OR (SELECT count(*) FROM jsonb_object_keys(NEW.previous_identities)) <>
              jsonb_array_length(NEW.manifest->'profiles')
           OR EXISTS (
               SELECT previous.worker_id
               FROM jsonb_each(NEW.previous_identities) previous(worker_id, facts)
               EXCEPT
               SELECT profile->>'workerId'
               FROM jsonb_array_elements(NEW.manifest->'profiles') profile
           )
           OR EXISTS (
               SELECT step->>'workerId' FROM jsonb_array_elements(NEW.steps) step
               EXCEPT
               SELECT profile->>'workerId'
               FROM jsonb_array_elements(NEW.manifest->'profiles') profile
           )
           OR EXISTS (
               SELECT step->>'workerId' FROM jsonb_array_elements(NEW.recovery_steps) step
               EXCEPT
               SELECT profile->>'workerId'
               FROM jsonb_array_elements(NEW.manifest->'profiles') profile
           ) THEN
            RAISE EXCEPTION 'protected office transaction facts do not match its exact manifest'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.maintenance_authorization IS NOT NULL AND (
            NEW.maintenance_authorization->>'transactionId' IS DISTINCT FROM NEW.id
            OR coalesce(NEW.maintenance_authorization->>'maintenanceGeneration', '')
               <> NEW.maintenance_generation::text
            OR coalesce(jsonb_typeof(NEW.maintenance_authorization->'workerIds'), '') <> 'array'
            OR jsonb_array_length(NEW.maintenance_authorization->'workerIds') = 0
            OR (SELECT count(DISTINCT worker_id #>> '{}')
                FROM jsonb_array_elements(NEW.maintenance_authorization->'workerIds') worker_id
                WHERE jsonb_typeof(worker_id) = 'string' AND worker_id #>> '{}' <> '')
               <> jsonb_array_length(NEW.maintenance_authorization->'workerIds')
            OR NEW.maintenance_authorization->'allowedOperations'
               IS DISTINCT FROM '["protected-set.maintenance"]'::jsonb
            OR coalesce(NEW.maintenance_authorization->>'issuedAt', '') = ''
            OR coalesce(NEW.maintenance_authorization->>'expiresAt', '') = ''
            OR (NEW.maintenance_authorization->>'expiresAt')::timestamptz
               <= (NEW.maintenance_authorization->>'issuedAt')::timestamptz
            OR (NEW.maintenance_authorization->>'expiresAt')::timestamptz
               > (NEW.maintenance_authorization->>'issuedAt')::timestamptz + interval '15 minutes'
        ) THEN
            RAISE EXCEPTION 'protected office maintenance authorization is not exact or bounded'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.transaction_state IN ('succeeded', 'rolled-back') THEN
        RAISE EXCEPTION 'terminal protected office transaction cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.set_id <> OLD.set_id
       OR NEW.node_id <> OLD.node_id
       OR NEW.desired_state_revision <> OLD.desired_state_revision
       OR NEW.maintenance_generation <> OLD.maintenance_generation
       OR NEW.manifest <> OLD.manifest
       OR NEW.previous_identities <> OLD.previous_identities
       OR NEW.maintenance_authorization IS DISTINCT FROM OLD.maintenance_authorization
       OR NEW.admission <> OLD.admission
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable protected office transaction facts cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'protected office transaction revision is stale'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT step->>'workerId' FROM jsonb_array_elements(NEW.steps) step
        EXCEPT
        SELECT profile->>'workerId'
        FROM jsonb_array_elements(NEW.manifest->'profiles') profile
    ) OR EXISTS (
        SELECT step->>'workerId' FROM jsonb_array_elements(NEW.recovery_steps) step
        EXCEPT
        SELECT profile->>'workerId'
        FROM jsonb_array_elements(NEW.manifest->'profiles') profile
    ) THEN
        RAISE EXCEPTION 'protected office transaction stage is outside its exact manifest'
            USING ERRCODE = 'check_violation';
    END IF;

    valid_transition := CASE OLD.transaction_state
        WHEN 'admitting' THEN NEW.transaction_state IN ('admitting', 'staging', 'rolling-back')
        WHEN 'staging' THEN NEW.transaction_state IN ('staging', 'probing', 'succeeded', 'rolling-back')
        WHEN 'probing' THEN NEW.transaction_state IN ('probing', 'staging', 'succeeded', 'rolling-back')
        WHEN 'rolling-back' THEN NEW.transaction_state IN ('rolling-back', 'recovery-required', 'rolled-back')
        WHEN 'recovery-required' THEN NEW.transaction_state IN ('recovery-required', 'rolling-back')
        ELSE false
    END;
    IF NOT valid_transition THEN
        RAISE EXCEPTION 'invalid protected office transaction state transition'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.transaction_state = 'succeeded' AND (
        jsonb_array_length(NEW.observed_identities) <>
            jsonb_array_length(NEW.manifest->'profiles')
        OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(NEW.observed_identities) observed
            LEFT JOIN LATERAL (
                SELECT profile
                FROM jsonb_array_elements(NEW.manifest->'profiles') profile
                WHERE profile->>'workerId' = observed->>'workerId'
            ) desired ON true
            WHERE desired.profile IS NULL
               OR observed->>'modelProfileId' IS DISTINCT FROM desired.profile->>'modelProfileId'
               OR observed->>'imageDigest' IS DISTINCT FROM desired.profile->>'imageDigest'
               OR observed->>'configurationDigest' IS DISTINCT FROM desired.profile->>'configurationDigest'
               OR observed->>'maintenanceGeneration' IS DISTINCT FROM desired.profile->>'maintenanceGeneration'
               OR observed->>'placementClass' IS DISTINCT FROM 'protected-resident'
               OR observed->>'healthy' IS DISTINCT FROM 'true'
        )
    ) THEN
        RAISE EXCEPTION 'successful protected office transaction lacks its exact observed set'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protected_office_transaction_write_guard
BEFORE INSERT OR UPDATE OR DELETE
ON compute.protected_office_set_transactions
FOR EACH ROW EXECUTE FUNCTION compute.enforce_protected_office_transaction_write();

CREATE FUNCTION compute.enforce_protected_office_set_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    node_role text;
    transaction_set_id text;
    transaction_node_id uuid;
    transaction_generation bigint;
    transaction_desired_revision bigint;
    journal_state text;
    transaction_observed_identities jsonb;
    prior_journal_state text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'protected office set states cannot be deleted'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT appliance_role INTO node_role
    FROM compute.nodes
    WHERE id = NEW.node_id;
    SELECT journal.set_id, journal.node_id, journal.maintenance_generation,
           journal.desired_state_revision, journal.transaction_state,
           journal.observed_identities
    INTO transaction_set_id, transaction_node_id, transaction_generation,
         transaction_desired_revision, journal_state,
         transaction_observed_identities
    FROM compute.protected_office_set_transactions journal
    WHERE journal.id = NEW.last_transaction_id;
    IF node_role IS DISTINCT FROM 'appliance-core'
       OR transaction_set_id IS DISTINCT FROM NEW.set_id
       OR transaction_node_id IS DISTINCT FROM NEW.node_id
       OR transaction_generation IS DISTINCT FROM NEW.maintenance_generation
       OR transaction_desired_revision IS DISTINCT FROM NEW.desired_state_revision THEN
        RAISE EXCEPTION 'protected office set state is outside its node or transaction boundary'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.aggregate_resident_bytes IS DISTINCT FROM (
        SELECT coalesce(sum((identity->>'residentBytes')::bigint), 0)
        FROM jsonb_array_elements(NEW.healthy_identities) identity
    ) THEN
        RAISE EXCEPTION 'protected office set aggregate residency is not exact'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.recovery_state = 'healthy' AND (
            journal_state <> 'succeeded'
            OR NEW.healthy_identities <> transaction_observed_identities
        ))
       OR (NEW.recovery_state = 'degraded' AND journal_state <> 'rolled-back')
       OR (NEW.recovery_state = 'manual-recovery'
           AND journal_state <> 'recovery-required')
       OR (NEW.recovery_state = 'recovering'
           AND journal_state NOT IN ('admitting', 'staging', 'probing', 'rolling-back')) THEN
        RAISE EXCEPTION 'protected office set recovery projection does not match its transaction'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.revision <> 1 THEN
            RAISE EXCEPTION 'protected office set state must begin at revision one'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    SELECT journal.transaction_state INTO prior_journal_state
    FROM compute.protected_office_set_transactions journal
    WHERE journal.id = OLD.last_transaction_id;
    IF OLD.recovery_state IN ('healthy', 'degraded')
       AND prior_journal_state IN ('succeeded', 'rolled-back')
       AND NEW.last_transaction_id = OLD.last_transaction_id THEN
        RAISE EXCEPTION 'terminal protected office set projection cannot change without a new transaction'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.set_id <> OLD.set_id
       OR NEW.node_id <> OLD.node_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.revision <> OLD.revision + 1
       OR NEW.desired_state_revision < OLD.desired_state_revision
       OR NEW.maintenance_generation < OLD.maintenance_generation
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'protected office set state revision or identity is stale'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protected_office_set_write_guard
BEFORE INSERT OR UPDATE OR DELETE
ON compute.protected_office_sets
FOR EACH ROW EXECUTE FUNCTION compute.enforce_protected_office_set_write();
