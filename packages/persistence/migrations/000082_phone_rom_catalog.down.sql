-- Do not roll back a used multi-ROM catalog and mislabel Google phones as AOSP.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM platform.phones WHERE rom_version_id<>'aosp-17-16102939-v1') THEN
        RAISE EXCEPTION 'phone ROM downgrade requires explicit data migration';
    END IF;
END $$;
DROP TRIGGER phone_rom_binding_guard ON platform.phones;
DROP FUNCTION platform.guard_phone_rom_binding();
ALTER TABLE platform.phones DROP COLUMN rom_version_id;
DROP TABLE platform.phone_rom_versions;
DROP FUNCTION platform.guard_phone_rom_version();
