ALTER TABLE compute.fleet_operation_orphans
ADD CONSTRAINT fleet_operation_orphans_reconciliation_id_format CHECK (
    reconciliation_id IS NULL
    OR reconciliation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
);

CREATE FUNCTION compute.guard_fleet_orphan_reconciliation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fleet orphan journal rows cannot be deleted'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.revision <> 1
           OR NEW.orphan_state <> 'pending-cleanup'
           OR NEW.reconciliation_id IS NOT NULL
           OR NEW.resolved_by_identity_id IS NOT NULL
           OR NEW.resolved_at IS NOT NULL
           OR NEW.trust_revoked IS DISTINCT FROM true
           OR NEW.generation_fenced IS DISTINCT FROM true
           OR NEW.unscheduled IS DISTINCT FROM true
           OR NEW.trust_restored IS DISTINCT FROM false
           OR NEW.scheduling_restored IS DISTINCT FROM false THEN
            RAISE EXCEPTION 'fleet orphan must begin as a safely fenced pending journal row'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.orphan_state = 'resolved' THEN
        RAISE EXCEPTION 'resolved fleet orphan journal rows cannot change'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'fleet orphan revision is stale'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
       OR NEW.node_group_id IS DISTINCT FROM OLD.node_group_id
       OR NEW.node_id IS DISTINCT FROM OLD.node_id
       OR NEW.node_generation IS DISTINCT FROM OLD.node_generation
       OR NEW.target_set_digest IS DISTINCT FROM OLD.target_set_digest
       OR NEW.desired_digest IS DISTINCT FROM OLD.desired_digest
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.trust_revoked IS DISTINCT FROM OLD.trust_revoked
       OR NEW.generation_fenced IS DISTINCT FROM OLD.generation_fenced
       OR NEW.unscheduled IS DISTINCT FROM OLD.unscheduled
       OR NEW.trust_restored IS DISTINCT FROM OLD.trust_restored
       OR NEW.scheduling_restored IS DISTINCT FROM OLD.scheduling_restored
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'frozen fleet orphan identity cannot change'
            USING ERRCODE = '23514';
    END IF;

    IF OLD.reconciliation_id IS NULL THEN
        IF NEW.orphan_state <> 'pending-cleanup'
           OR NEW.reconciliation_id IS NULL
           OR NEW.resolved_by_identity_id IS NOT NULL
           OR NEW.resolved_at IS NOT NULL THEN
            RAISE EXCEPTION 'fleet orphan reconciliation identity must be persisted before cleanup'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id THEN
            RAISE EXCEPTION 'fleet orphan reconciliation identity cannot change'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.orphan_state <> 'resolved'
           OR NEW.resolved_by_identity_id IS NULL
           OR NEW.resolved_at IS NULL THEN
            RAISE EXCEPTION 'fleet orphan cleanup may only advance to resolved'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fleet_operation_orphans_identity_guard
BEFORE INSERT OR UPDATE OR DELETE ON compute.fleet_operation_orphans
FOR EACH ROW EXECUTE FUNCTION compute.guard_fleet_orphan_reconciliation_identity();
