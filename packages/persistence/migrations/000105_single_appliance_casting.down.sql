-- Schema rollback is allowed only when every session has a historical mapping.
-- New single-appliance installations must not fabricate obsolete group records.
-- This schema-only recovery path does not authorize legacy physical playback.
LOCK TABLE platform.cast_sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE compute.nodes IN SHARE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.cast_sessions s LEFT JOIN compute.nodes n ON n.id=s.appliance_node_id
    WHERE n.node_group_id IS NULL) THEN
    RAISE EXCEPTION 'Single-appliance casting history cannot be downgraded without a historical mapping';
  END IF;
END $$;
ALTER TABLE platform.cast_sessions DISABLE TRIGGER cast_sessions_write_guard;
ALTER TABLE platform.cast_sessions DROP CONSTRAINT cast_sessions_appliance_node_id_fkey;
UPDATE platform.cast_sessions s SET appliance_node_id=n.node_group_id FROM compute.nodes n WHERE n.id=s.appliance_node_id;
ALTER TABLE platform.cast_sessions RENAME COLUMN appliance_node_id TO appliance_node_group_id;
ALTER TABLE platform.cast_sessions ADD CONSTRAINT cast_sessions_appliance_node_group_id_fkey
  FOREIGN KEY (appliance_node_group_id) REFERENCES compute.node_groups(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION platform.enforce_cast_session_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    appliance_role text;
    initiator_kind text;
    initiator_status text;
    valid_transition boolean;
    audience_changed boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'casting sessions are durable lifecycle records'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT role INTO appliance_role
        FROM compute.node_groups
        WHERE id = NEW.appliance_node_group_id;

        SELECT identity_kind, status
        INTO initiator_kind, initiator_status
        FROM iam.identities
        WHERE id = NEW.initiator_identity_id;

        IF appliance_role IS DISTINCT FROM 'appliance-core'
           OR initiator_kind IS DISTINCT FROM 'local_user'
           OR initiator_status IS DISTINCT FROM 'active'
           OR NOT platform.cast_identity_has_permission(
               NEW.initiator_identity_id, 'cast:use', NEW.created_at
           )
           OR (NEW.browser_audience IN ('selected_users', 'selected_team')
               AND NOT platform.cast_identity_has_permission(
                   NEW.initiator_identity_id, 'cast:share', NEW.created_at
               ))
           OR NEW.session_state <> 'requested'
           OR NEW.state_revision <> 1
           OR NEW.audience_revision <> 1 THEN
            RAISE EXCEPTION 'casting session creation is outside the appliance or initiator boundary'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.id <> OLD.id
       OR NEW.appliance_node_group_id <> OLD.appliance_node_group_id
       OR NEW.initiator_identity_id <> OLD.initiator_identity_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'immutable casting session identity fields cannot change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.session_state IN ('stopped', 'expired', 'failed') THEN
        RAISE EXCEPTION 'terminal casting sessions cannot change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.session_state IS DISTINCT FROM OLD.session_state THEN
        valid_transition := CASE OLD.session_state
            WHEN 'requested' THEN NEW.session_state IN ('starting', 'stopped', 'failed')
            WHEN 'starting' THEN NEW.session_state IN ('pairing', 'stopping', 'stopped', 'failed')
            WHEN 'pairing' THEN NEW.session_state IN ('paired', 'streaming', 'stopping', 'stopped', 'expired', 'failed')
            WHEN 'paired' THEN NEW.session_state IN ('streaming', 'stopping', 'stopped', 'expired', 'failed')
            WHEN 'streaming' THEN NEW.session_state IN ('stopping', 'stopped', 'expired', 'failed')
            WHEN 'stopping' THEN NEW.session_state IN ('stopped', 'failed')
            ELSE false
        END;
        IF NOT valid_transition OR NEW.state_revision <> OLD.state_revision + 1 THEN
            RAISE EXCEPTION 'invalid casting session state transition or revision'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.state_revision <> OLD.state_revision THEN
        RAISE EXCEPTION 'casting state revision changed without a state transition'
            USING ERRCODE = 'check_violation';
    END IF;

    audience_changed := NEW.output_sinks IS DISTINCT FROM OLD.output_sinks
        OR NEW.browser_audience IS DISTINCT FROM OLD.browser_audience;
    IF NEW.browser_audience IN ('selected_users', 'selected_team')
       AND NOT platform.cast_identity_has_permission(
           NEW.initiator_identity_id, 'cast:share', clock_timestamp()
       ) THEN
        RAISE EXCEPTION 'casting audience sharing requires current cast:share authority'
            USING ERRCODE = 'check_violation';
    END IF;
    IF audience_changed AND NEW.audience_revision <> OLD.audience_revision + 1 THEN
        RAISE EXCEPTION 'casting audience change must advance exactly one revision'
            USING ERRCODE = 'check_violation';
    ELSIF NOT audience_changed AND NEW.audience_revision <> OLD.audience_revision THEN
        RAISE EXCEPTION 'casting audience revision changed without an audience change'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.pairing_failed_attempts < OLD.pairing_failed_attempts
       OR (OLD.pairing_blocked_until IS NOT NULL
           AND (NEW.pairing_blocked_until IS NULL
                OR NEW.pairing_blocked_until < OLD.pairing_blocked_until))
       OR (OLD.paired_at IS NULL AND NEW.paired_at IS NOT NULL
           AND NEW.session_state NOT IN ('paired', 'streaming'))
       OR (OLD.started_at IS NULL AND NEW.started_at IS NOT NULL
           AND NEW.session_state <> 'streaming')
       OR (OLD.paired_at IS NOT NULL AND NEW.paired_at IS DISTINCT FROM OLD.paired_at)
       OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
       OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
       OR (OLD.terminal_reason_code IS NOT NULL
           AND NEW.terminal_reason_code IS DISTINCT FROM OLD.terminal_reason_code) THEN
        RAISE EXCEPTION 'casting security or lifecycle facts cannot be rewritten'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

ALTER TABLE platform.cast_sessions ENABLE TRIGGER cast_sessions_write_guard;
