DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM compute.cast_resource_reservations WHERE state = 'active') THEN
        RAISE EXCEPTION 'stop and reconcile active casting before rollback';
    END IF;
END $$;
DROP TRIGGER office_transaction_casting_fence ON compute.protected_office_set_transactions;
DROP TABLE compute.cast_resource_reservations;
DROP FUNCTION compute.fence_casting_and_office_maintenance();
DROP FUNCTION compute.guard_cast_resource_reservation();
DROP FUNCTION compute.cast_resource_numbers_valid(jsonb);
