DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM platform.phone_camera_inputs WHERE source_kind='udp')
        OR EXISTS(SELECT 1 FROM platform.phone_udp_camera_policy) THEN
        RAISE EXCEPTION 'network camera policy or input history must not be erased by rollback' USING ERRCODE='23514';
    END IF;
END $$;
DROP TRIGGER phone_udp_camera_selection_guard ON platform.phone_camera_inputs;
DROP FUNCTION platform.guard_phone_udp_camera_selection();
DROP INDEX platform.phone_camera_udp_exclusive_idx;
ALTER TABLE platform.phone_camera_inputs DROP CONSTRAINT phone_camera_udp_policy_fk;
ALTER TABLE platform.phone_camera_inputs DROP CONSTRAINT phone_camera_udp_selection;
ALTER TABLE platform.phone_camera_inputs DROP COLUMN udp_node_id, DROP COLUMN udp_policy_id, DROP COLUMN udp_policy_revision;
DROP TABLE platform.phone_udp_camera_users;
DROP TABLE platform.phone_udp_camera_policy;
