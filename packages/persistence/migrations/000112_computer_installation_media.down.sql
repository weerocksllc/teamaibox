-- Roll back code, not customer data. Only a never-used schema can be removed.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM platform.computer_installations)
      OR EXISTS (SELECT 1 FROM platform.computer_installation_media) THEN
        RAISE EXCEPTION 'cannot remove persisted installation media or computer state';
    END IF;
END $$;
DROP TRIGGER installation_object_delete_guard ON objects.object_entries;
DROP FUNCTION platform.guard_installation_object_delete();
DROP TABLE platform.computer_installations;
DROP TABLE platform.computer_installation_media;
DROP FUNCTION platform.guard_computer_installation();
DROP FUNCTION platform.guard_computer_installation_media();
