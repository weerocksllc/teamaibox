-- Remove a development sample count. Audience, session expiry and the locked
-- transition remain mandatory; this is not an authorization change.
CREATE OR REPLACE FUNCTION platform.enforce_cast_viewer_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    session_state text;
    session_expires_at timestamptz;
    has_browser boolean;
BEGIN
    IF NEW.grant_state <> 'joined' OR OLD.grant_state = 'joined' THEN
        RETURN NEW;
    END IF;
    SELECT session.session_state, session.expires_at,
           session.output_sinks @> ARRAY['browser']::text[]
    INTO session_state, session_expires_at, has_browser
    FROM platform.cast_sessions session WHERE session.id = NEW.session_id FOR UPDATE;
    IF session_state NOT IN ('requested', 'starting', 'pairing', 'paired', 'streaming')
       OR session_expires_at <= clock_timestamp()
       OR NEW.expires_at <= clock_timestamp() OR NOT has_browser
       OR NOT platform.cast_identity_in_current_audience(NEW.session_id, NEW.viewer_identity_id) THEN
        RAISE EXCEPTION 'casting viewer cannot join the current session' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
ALTER TABLE platform.cast_session_events DROP CONSTRAINT cast_session_events_active_viewer_count_check;
ALTER TABLE platform.cast_session_events ADD CONSTRAINT cast_session_events_active_viewer_count_check CHECK (active_viewer_count >= 0);
