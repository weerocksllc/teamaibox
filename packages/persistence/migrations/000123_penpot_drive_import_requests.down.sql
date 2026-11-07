DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM design.drive_import_requests) THEN
        RAISE EXCEPTION 'Design import requests exist; rollback would remove operation evidence';
    END IF;
END $$;
DROP TABLE design.drive_import_requests;
