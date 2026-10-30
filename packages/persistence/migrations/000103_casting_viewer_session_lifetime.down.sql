-- Never shorten, resurrect or rewrite historical grants to force a downgrade.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM platform.cast_viewer_grants
               WHERE expires_at > issued_at + interval '5 minutes') THEN
        RAISE EXCEPTION 'viewer lifetime downgrade requires an explicit compatible data migration';
    END IF;
END $$;
ALTER TABLE platform.cast_viewer_grants
    DROP CONSTRAINT cast_viewer_grants_time_order;
ALTER TABLE platform.cast_viewer_grants
    ADD CONSTRAINT cast_viewer_grants_check
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes');
