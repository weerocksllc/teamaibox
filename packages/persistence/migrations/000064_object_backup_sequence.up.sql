ALTER TABLE objects.object_versions
    ADD COLUMN backup_sequence bigint GENERATED ALWAYS AS IDENTITY,
    ADD COLUMN backup_version_id uuid NOT NULL DEFAULT uuidv7();

ALTER TABLE objects.object_versions
    ADD CONSTRAINT object_versions_backup_sequence_unique UNIQUE (backup_sequence),
    ADD CONSTRAINT object_versions_backup_version_id_unique UNIQUE (backup_version_id),
    ADD CONSTRAINT object_versions_backup_sequence_positive CHECK (backup_sequence > 0);

CREATE INDEX object_versions_backup_sequence_idx
ON objects.object_versions (backup_sequence, object_id, version);
