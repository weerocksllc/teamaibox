-- Development rollback only: never remove live user phones to downgrade a service.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM platform.phones) THEN
        RAISE EXCEPTION 'phone data exists; rollback services without dropping phone storage' USING ERRCODE='23514';
    END IF;
END $$;
DROP TABLE platform.phone_access_grants;
DROP FUNCTION platform.guard_phone_grant_identity();
DROP VIEW compute.phone_resource_reservations;
DROP TABLE platform.phone_runs;
DROP TABLE platform.phone_operations;
DROP TABLE platform.phones;
DROP FUNCTION platform.guard_phone_identity();
DROP TABLE platform.phone_quotas;
DELETE FROM iam.role_permissions WHERE permission_key IN ('phone:use','phone:manage');
DELETE FROM iam.permissions WHERE permission_key IN ('phone:use','phone:manage');
