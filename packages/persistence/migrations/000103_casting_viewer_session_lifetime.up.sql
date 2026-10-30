-- An established viewer follows its casting session, not the short-lived join secret.
-- guard_cast_viewer_grant still rejects grants beyond the parent session expiry,
-- stale audience revisions and unauthorized viewers. Historical rows stay unchanged.
ALTER TABLE platform.cast_viewer_grants
    DROP CONSTRAINT cast_viewer_grants_check;
ALTER TABLE platform.cast_viewer_grants
    ADD CONSTRAINT cast_viewer_grants_time_order CHECK (expires_at > issued_at);
