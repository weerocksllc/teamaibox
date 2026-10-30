CREATE FUNCTION compute.fleet_target_set_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND jsonb_array_length(value) BETWEEN 1 AND 256
       AND (SELECT count(DISTINCT target->>'nodeId') FROM jsonb_array_elements(value) target)
           = jsonb_array_length(value)
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(value) target
           WHERE jsonb_typeof(target) <> 'object'
              OR coalesce(target->>'nodeId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              OR coalesce(target->>'nodeGeneration','') !~ '^[1-9][0-9]*$'
              OR coalesce(target->>'certificateFingerprint','') !~ '^sha256:[a-f0-9]{64}$'
              OR coalesce(target->>'desiredStateRevision','') !~ '^[1-9][0-9]*$'
              OR coalesce(target->>'maintenanceGeneration','') !~ '^[1-9][0-9]*$'
              OR coalesce(target->>'membershipDesiredStateRevision','') !~ '^[1-9][0-9]*$'
       );
$$;

CREATE TABLE compute.fleet_operations (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'),
    node_group_id uuid NOT NULL REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    operation_kind text NOT NULL CHECK (operation_kind IN (
        'artifact.distribute', 'workload.deploy', 'configuration.apply',
        'health.verify', 'node.drain', 'rolling.update', 'rollback',
        'certificate.rotate', 'node.remove'
    )),
    operation_state text NOT NULL CHECK (operation_state IN (
        'planned', 'running', 'succeeded', 'failed', 'partial', 'rolled-back'
    )),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    desired_state jsonb NOT NULL CHECK (
        jsonb_typeof(desired_state) = 'object' AND desired_state <> '{}'::jsonb
    ),
    desired_digest bytea NOT NULL CHECK (octet_length(desired_digest) = 32),
    frozen_target_set jsonb NOT NULL CHECK (compute.fleet_target_set_valid(frozen_target_set)),
    target_set_digest bytea NOT NULL CHECK (octet_length(target_set_digest) = 32),
    rollout_concurrency integer NOT NULL CHECK (rollout_concurrency BETWEEN 1 AND 16),
    actor_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    failure_code text CHECK (
        failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,127}$'
    ),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    CHECK (updated_at >= created_at),
    CHECK (expires_at > created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        (operation_state IN ('succeeded','failed','partial','rolled-back') AND completed_at IS NOT NULL)
        OR
        (operation_state NOT IN ('succeeded','failed','partial','rolled-back') AND completed_at IS NULL)
    ),
    CHECK (
        (operation_state IN ('failed','partial','rolled-back') AND failure_code IS NOT NULL)
        OR
        (operation_state NOT IN ('failed','partial','rolled-back'))
    )
);

CREATE UNIQUE INDEX fleet_operations_one_active_group_idx
ON compute.fleet_operations (node_group_id)
WHERE operation_state NOT IN ('succeeded','failed','partial','rolled-back');

CREATE INDEX fleet_operations_recovery_idx
ON compute.fleet_operations (operation_state, updated_at, node_group_id, id)
WHERE operation_state NOT IN ('succeeded','failed','partial','rolled-back');

CREATE TABLE compute.fleet_operation_targets (
    operation_id text NOT NULL REFERENCES compute.fleet_operations(id) ON DELETE RESTRICT,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    certificate_fingerprint bytea NOT NULL CHECK (octet_length(certificate_fingerprint) = 32),
    desired_state_revision bigint NOT NULL CHECK (desired_state_revision > 0),
    maintenance_generation bigint NOT NULL CHECK (maintenance_generation > 0),
    membership_desired_state_revision bigint NOT NULL CHECK (membership_desired_state_revision > 0),
    target_state text NOT NULL CHECK (target_state IN (
        'pending', 'preflighting', 'staging', 'draining', 'applying',
        'verifying', 'cleaning', 'succeeded', 'failed', 'rolling-back',
        'rolled-back', 'manual-recovery', 'orphaned', 'blocked'
    )),
    current_step text,
    previous_identity jsonb NOT NULL CHECK (jsonb_typeof(previous_identity) = 'object'),
    completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(completed_steps) = 'array'),
    observed_identity jsonb CHECK (
        observed_identity IS NULL OR jsonb_typeof(observed_identity) = 'object'
    ),
    mutated boolean NOT NULL DEFAULT false,
    failure_code text CHECK (
        failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,127}$'
    ),
    rollback_failure_code text CHECK (
        rollback_failure_code IS NULL OR rollback_failure_code ~ '^[a-z][a-z0-9_]{2,127}$'
    ),
    orphan_id text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    PRIMARY KEY (operation_id, node_id),
    UNIQUE (operation_id, ordinal),
    CHECK (updated_at >= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        (target_state IN ('succeeded','failed','rolled-back','manual-recovery','orphaned','blocked') AND completed_at IS NOT NULL)
        OR
        (target_state NOT IN ('succeeded','failed','rolled-back','manual-recovery','orphaned','blocked') AND completed_at IS NULL)
    ),
    CHECK (
        (target_state = 'succeeded' AND failure_code IS NULL AND rollback_failure_code IS NULL)
        OR target_state <> 'succeeded'
    )
);

CREATE INDEX fleet_operation_targets_progress_idx
ON compute.fleet_operation_targets (operation_id, target_state, ordinal);

CREATE TABLE compute.fleet_operation_orphans (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'),
    operation_id text NOT NULL REFERENCES compute.fleet_operations(id) ON DELETE RESTRICT,
    node_group_id uuid NOT NULL REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    target_set_digest bytea NOT NULL CHECK (octet_length(target_set_digest) = 32),
    desired_digest bytea NOT NULL CHECK (octet_length(desired_digest) = 32),
    orphan_state text NOT NULL CHECK (orphan_state IN ('pending-cleanup','resolved')),
    failure_code text NOT NULL CHECK (failure_code ~ '^[a-z][a-z0-9_]{2,127}$'),
    trust_revoked boolean NOT NULL CHECK (trust_revoked),
    generation_fenced boolean NOT NULL CHECK (generation_fenced),
    unscheduled boolean NOT NULL CHECK (unscheduled),
    reconciliation_id text,
    resolved_by_identity_id uuid REFERENCES iam.identities(id) ON DELETE RESTRICT,
    trust_restored boolean NOT NULL DEFAULT false CHECK (NOT trust_restored),
    scheduling_restored boolean NOT NULL DEFAULT false CHECK (NOT scheduling_restored),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    resolved_at timestamptz,
    CHECK (updated_at >= created_at),
    CHECK (
        (orphan_state = 'resolved' AND resolved_at IS NOT NULL
         AND reconciliation_id IS NOT NULL AND resolved_by_identity_id IS NOT NULL)
        OR
        (orphan_state = 'pending-cleanup' AND resolved_at IS NULL)
    )
);

CREATE INDEX fleet_operation_orphans_pending_idx
ON compute.fleet_operation_orphans (orphan_state, created_at, node_group_id, node_id)
WHERE orphan_state = 'pending-cleanup';

CREATE FUNCTION compute.enforce_fleet_operation_group()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM compute.node_groups group_state
        WHERE group_state.id = NEW.node_group_id
          AND group_state.role = 'extension-pool'
          AND group_state.lifecycle_state <> 'disabled'
          AND group_state.max_managed_nodes >= jsonb_array_length(NEW.frozen_target_set)
    ) THEN
        RAISE EXCEPTION 'fleet operation may target only an enabled extension pool within maxManagedNodes'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fleet_operations_group_guard
BEFORE INSERT ON compute.fleet_operations
FOR EACH ROW EXECUTE FUNCTION compute.enforce_fleet_operation_group();

CREATE FUNCTION compute.guard_terminal_fleet_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.operation_state IN ('succeeded','failed','partial','rolled-back') THEN
        RAISE EXCEPTION 'terminal fleet operation cannot change' USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'fleet operation revision is stale' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM compute.node_groups group_state
        WHERE group_state.id = NEW.node_group_id
          AND group_state.role = 'extension-pool'
          AND group_state.lifecycle_state <> 'disabled'
          AND group_state.max_managed_nodes >= jsonb_array_length(NEW.frozen_target_set)
    ) THEN
        RAISE EXCEPTION 'fleet operation may target only an enabled extension pool within maxManagedNodes'
            USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM compute.fleet_operation_targets target WHERE target.operation_id = NEW.id)
       <> jsonb_array_length(NEW.frozen_target_set) THEN
        RAISE EXCEPTION 'fleet operation target set is incomplete' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM compute.fleet_operation_targets target
        CROSS JOIN LATERAL (SELECT NEW.frozen_target_set->target.ordinal AS frozen) expected
        WHERE target.operation_id = NEW.id
          AND (expected.frozen IS NULL
            OR expected.frozen->>'nodeId' <> target.node_id::text
            OR (expected.frozen->>'nodeGeneration')::bigint <> target.node_generation
            OR expected.frozen->>'certificateFingerprint' <> 'sha256:' || encode(target.certificate_fingerprint,'hex')
            OR (expected.frozen->>'desiredStateRevision')::bigint <> target.desired_state_revision
            OR (expected.frozen->>'maintenanceGeneration')::bigint <> target.maintenance_generation
            OR (expected.frozen->>'membershipDesiredStateRevision')::bigint <> target.membership_desired_state_revision)
    ) THEN
        RAISE EXCEPTION 'fleet operation target identity differs from frozen set' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation_state = 'succeeded' AND EXISTS (
        SELECT 1 FROM compute.fleet_operation_targets target
        WHERE target.operation_id = NEW.id AND target.target_state <> 'succeeded'
    ) THEN
        RAISE EXCEPTION 'fleet group success requires every frozen target' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation_state = 'failed' AND EXISTS (
        SELECT 1 FROM compute.fleet_operation_targets target
        WHERE target.operation_id = NEW.id AND target.target_state = 'succeeded'
    ) THEN
        RAISE EXCEPTION 'mixed fleet result must remain partial' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation_state = 'partial' AND (
        NOT EXISTS (SELECT 1 FROM compute.fleet_operation_targets target WHERE target.operation_id = NEW.id AND target.target_state = 'succeeded')
        OR NOT EXISTS (SELECT 1 FROM compute.fleet_operation_targets target WHERE target.operation_id = NEW.id AND target.target_state <> 'succeeded')
    ) THEN
        RAISE EXCEPTION 'partial fleet result requires mixed target states' USING ERRCODE = '23514';
    END IF;
    IF NEW.node_group_id IS DISTINCT FROM OLD.node_group_id
       OR NEW.operation_kind IS DISTINCT FROM OLD.operation_kind
       OR NEW.desired_state IS DISTINCT FROM OLD.desired_state
       OR NEW.desired_digest IS DISTINCT FROM OLD.desired_digest
       OR NEW.frozen_target_set IS DISTINCT FROM OLD.frozen_target_set
       OR NEW.target_set_digest IS DISTINCT FROM OLD.target_set_digest
       OR NEW.rollout_concurrency IS DISTINCT FROM OLD.rollout_concurrency
       OR NEW.actor_identity_id IS DISTINCT FROM OLD.actor_identity_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'frozen fleet operation identity cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fleet_operations_terminal_guard
BEFORE UPDATE ON compute.fleet_operations
FOR EACH ROW EXECUTE FUNCTION compute.guard_terminal_fleet_operation();

CREATE FUNCTION compute.guard_fleet_target_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'fleet target revision is stale' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
       OR NEW.node_id IS DISTINCT FROM OLD.node_id
       OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
       OR NEW.node_generation IS DISTINCT FROM OLD.node_generation
       OR NEW.certificate_fingerprint IS DISTINCT FROM OLD.certificate_fingerprint
       OR NEW.desired_state_revision IS DISTINCT FROM OLD.desired_state_revision
       OR NEW.maintenance_generation IS DISTINCT FROM OLD.maintenance_generation
       OR NEW.membership_desired_state_revision IS DISTINCT FROM OLD.membership_desired_state_revision
       OR NEW.previous_identity IS DISTINCT FROM OLD.previous_identity
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'frozen fleet target identity cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fleet_operation_targets_identity_guard
BEFORE UPDATE ON compute.fleet_operation_targets
FOR EACH ROW EXECUTE FUNCTION compute.guard_fleet_target_identity();
