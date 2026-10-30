DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM platform.phone_camera_inputs WHERE source_kind='usb')
        OR EXISTS(SELECT 1 FROM platform.phone_usb_camera_policy) THEN
        RAISE EXCEPTION 'USB policy or input history must not be erased by rollback' USING ERRCODE='23514';
    END IF;
END $$;
DROP TRIGGER phone_usb_camera_selection_guard ON platform.phone_camera_inputs;
DROP FUNCTION platform.guard_phone_usb_camera_selection();
DROP INDEX platform.phone_camera_usb_exclusive_idx;
ALTER TABLE platform.phone_camera_inputs DROP CONSTRAINT phone_camera_usb_policy_fk;
ALTER TABLE platform.phone_camera_inputs DROP CONSTRAINT phone_camera_usb_selection;
ALTER TABLE platform.phone_camera_inputs DROP COLUMN usb_node_id, DROP COLUMN usb_device_id, DROP COLUMN usb_policy_revision;
DROP TABLE platform.phone_usb_camera_users;
DROP TABLE platform.phone_usb_camera_policy;
