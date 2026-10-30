-- Refuse rollback if retained operations no longer fit the former limits; never trim history.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM compute.fleet_operations WHERE jsonb_array_length(frozen_target_set)>256 OR rollout_concurrency>16)
 OR EXISTS (SELECT 1 FROM compute.fleet_operation_targets WHERE ordinal>255)
 THEN RAISE EXCEPTION 'fleet operation history exceeds legacy limits'; END IF;
END $$;

CREATE OR REPLACE FUNCTION compute.fleet_target_set_valid(value jsonb)
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

CREATE OR REPLACE FUNCTION compute.enforce_fleet_operation_group()
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

CREATE OR REPLACE FUNCTION compute.guard_terminal_fleet_operation()
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

ALTER TABLE compute.fleet_operations DROP CONSTRAINT fleet_operations_rollout_concurrency_check;
ALTER TABLE compute.fleet_operations ADD CONSTRAINT fleet_operations_rollout_concurrency_check CHECK (rollout_concurrency BETWEEN 1 AND 16);
ALTER TABLE compute.fleet_operation_targets DROP CONSTRAINT fleet_operation_targets_ordinal_check;
ALTER TABLE compute.fleet_operation_targets ADD CONSTRAINT fleet_operation_targets_ordinal_check CHECK (ordinal BETWEEN 0 AND 255);

