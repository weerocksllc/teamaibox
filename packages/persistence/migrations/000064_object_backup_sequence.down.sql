DROP INDEX IF EXISTS objects.object_versions_backup_sequence_idx;

ALTER TABLE objects.object_versions
    DROP CONSTRAINT IF EXISTS object_versions_backup_sequence_positive,
    DROP CONSTRAINT IF EXISTS object_versions_backup_sequence_unique,
    DROP CONSTRAINT IF EXISTS object_versions_backup_version_id_unique,
    DROP COLUMN IF EXISTS backup_sequence,
    DROP COLUMN IF EXISTS backup_version_id;
