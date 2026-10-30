-- Refuse downgrade if it would make existing lineage invalid. Never discard
-- an input file or silently shorten a result's source list.
ALTER TABLE objects.artifact_provenance_sources
    DROP CONSTRAINT artifact_provenance_sources_source_ordinal_check;
ALTER TABLE objects.artifact_provenance_sources
    ADD CONSTRAINT artifact_provenance_sources_source_ordinal_check
    CHECK (source_ordinal >= 0 AND source_ordinal < 64);
