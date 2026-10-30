-- Retire advance resource bookkeeping only. Guest/session identity, ownership,
-- encrypted data, actual virtual disk sizes and operation fencing stay intact.
DROP TRIGGER office_transaction_casting_fence ON compute.protected_office_set_transactions;
DROP TABLE compute.cast_resource_reservations;
DROP FUNCTION compute.guard_cast_resource_reservation();
DROP FUNCTION compute.cast_resource_numbers_valid(jsonb);
DROP FUNCTION compute.fence_casting_and_office_maintenance();
DROP VIEW compute.phone_resource_reservations;
DROP VIEW compute.computer_resource_reservations;
DROP TABLE compute.computer_storage_reservations;

-- Maintenance serialization is a lifecycle safety rule, not a capacity gate.
CREATE FUNCTION compute.fence_runtime_maintenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_node uuid;
BEGIN
    IF TG_TABLE_NAME = 'cast_sessions' THEN target_node := NEW.appliance_node_id;
    ELSE target_node := NEW.node_id; END IF;
    PERFORM id FROM compute.nodes WHERE id=target_node FOR UPDATE;
    IF TG_TABLE_NAME = 'cast_sessions' THEN
        IF EXISTS (SELECT 1 FROM compute.protected_office_set_transactions
            WHERE node_id=target_node AND transaction_state NOT IN ('succeeded','rolled-back')) THEN
            RAISE EXCEPTION 'office maintenance is active' USING ERRCODE='23514';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM platform.cast_sessions
            WHERE appliance_node_id=target_node AND terminal_at IS NULL
              AND session_state IN ('requested','starting','pairing','paired','streaming','stopping')) THEN
            RAISE EXCEPTION 'receiver must stop before office maintenance' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER office_transaction_runtime_fence BEFORE INSERT ON compute.protected_office_set_transactions
FOR EACH ROW EXECUTE FUNCTION compute.fence_runtime_maintenance();
CREATE TRIGGER cast_session_maintenance_fence BEFORE INSERT ON platform.cast_sessions
FOR EACH ROW EXECUTE FUNCTION compute.fence_runtime_maintenance();
