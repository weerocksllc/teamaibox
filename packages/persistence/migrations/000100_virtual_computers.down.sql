DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM platform.computers) OR EXISTS(SELECT 1 FROM platform.computer_profiles) THEN
        RAISE EXCEPTION 'cannot remove persisted virtual computers or profiles';
    END IF;
END $$;
DROP VIEW compute.computer_resource_reservations;
DROP TABLE compute.computer_runs;
DROP TABLE compute.computer_storage_reservations;
DROP TABLE platform.computer_operations;
DROP TABLE platform.computers;
DROP TABLE platform.computer_profiles;
DROP FUNCTION platform.guard_computer_operation();
DROP FUNCTION platform.guard_computer_identity();
DROP FUNCTION platform.guard_computer_profile();
DELETE FROM iam.role_permissions WHERE permission_key IN ('computer:use','computer:manage');
DELETE FROM iam.permissions WHERE permission_key IN ('computer:use','computer:manage');
