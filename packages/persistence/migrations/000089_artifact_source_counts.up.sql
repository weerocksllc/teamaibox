-- A file derived from many inputs is valid; ownership and exact object
-- version foreign keys still apply independently to every source.
ALTER TABLE objects.artifact_provenance_sources
    DROP CONSTRAINT artifact_provenance_sources_source_ordinal_check;
ALTER TABLE objects.artifact_provenance_sources
    ADD CONSTRAINT artifact_provenance_sources_source_ordinal_check
    CHECK (source_ordinal >= 0);
