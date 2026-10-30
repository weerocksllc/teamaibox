DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM platform.phone_camera_inputs) THEN
        RAISE EXCEPTION 'refusing rollback with camera input history' USING ERRCODE='23514';
    END IF;
END $$;
DROP TABLE platform.phone_camera_inputs;
DROP FUNCTION platform.guard_phone_camera_input();
