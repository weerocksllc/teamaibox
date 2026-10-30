CREATE SCHEMA IF NOT EXISTS security;

CREATE TABLE security.unlock_protection_transitions (
    plan_id uuid PRIMARY KEY,
    request_id uuid NOT NULL UNIQUE,
    actor_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    mode text NOT NULL CHECK (mode IN ('web_passphrase','usb_key')),
    volume_uuid text NOT NULL CHECK (volume_uuid ~ '^[A-Fa-f0-9-]{8,128}$'),
    header_revision_before bytea NOT NULL CHECK (octet_length(header_revision_before)=32),
    automatic_slot_id integer NOT NULL CHECK (automatic_slot_id BETWEEN 0 AND 31),
    recovery_slot_id integer NOT NULL CHECK (recovery_slot_id BETWEEN 0 AND 31),
    selected_slot_id integer NOT NULL CHECK (selected_slot_id BETWEEN 0 AND 31),
    backup_evidence_digest bytea NOT NULL CHECK (octet_length(backup_evidence_digest)=32),
    recovery_verification_id uuid NOT NULL,
    recovery_evidence_digest bytea NOT NULL CHECK (octet_length(recovery_evidence_digest)=32),
    selected_verification_id uuid NOT NULL,
    selected_evidence_digest bytea NOT NULL CHECK (octet_length(selected_evidence_digest)=32),
    drain_evidence_digest bytea NOT NULL CHECK (octet_length(drain_evidence_digest)=32),
    simulation_evidence_digest bytea NOT NULL CHECK (octet_length(simulation_evidence_digest)=32),
    state text NOT NULL CHECK (state IN ('prepared','committing','enabled','rolled_back','manual_recovery_required')),
    revision integer NOT NULL CHECK (revision > 0),
    prepared_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > prepared_at),
    header_backup_id uuid,
    header_backup_digest bytea CHECK (header_backup_digest IS NULL OR octet_length(header_backup_digest)=32),
    committed_at timestamptz,
    header_revision_after bytea CHECK (header_revision_after IS NULL OR octet_length(header_revision_after)=32),
    enabled_at timestamptz,
    rollback_passed boolean,
    failure_code text CHECK (failure_code IS NULL OR failure_code IN ('commit_failed_rolled_back','manual_recovery_required')),
    failed_at timestamptz,
    CHECK (automatic_slot_id<>recovery_slot_id AND automatic_slot_id<>selected_slot_id AND recovery_slot_id<>selected_slot_id),
    CHECK ((state='prepared')=(header_backup_id IS NULL AND header_backup_digest IS NULL AND committed_at IS NULL)),
    CHECK ((state IN ('committing','enabled','rolled_back','manual_recovery_required'))=(header_backup_id IS NOT NULL AND header_backup_digest IS NOT NULL AND committed_at IS NOT NULL)),
    CHECK ((state='enabled')=(header_revision_after IS NOT NULL AND enabled_at IS NOT NULL)),
    CHECK ((state IN ('rolled_back','manual_recovery_required'))=(rollback_passed IS NOT NULL AND failure_code IS NOT NULL AND failed_at IS NOT NULL))
);

CREATE TABLE security.unlock_protection_transition_events (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    plan_id uuid NOT NULL REFERENCES security.unlock_protection_transitions(plan_id) ON DELETE RESTRICT,
    event_kind text NOT NULL CHECK (event_kind IN ('prepared','committing','enabled','rolled_back','manual_recovery_required')),
    revision integer NOT NULL CHECK (revision > 0),
    occurred_at timestamptz NOT NULL,
    facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND NOT (facts ?| ARRAY['passphrase','key','keyBytes','secret','token','recoveryKey'])),
    UNIQUE (plan_id,revision)
);

CREATE FUNCTION security.enforce_unlock_transition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.plan_id,OLD.request_id,OLD.actor_identity_id,OLD.mode,OLD.volume_uuid,
        OLD.header_revision_before,OLD.automatic_slot_id,OLD.recovery_slot_id,OLD.selected_slot_id,
        OLD.backup_evidence_digest,OLD.recovery_verification_id,OLD.recovery_evidence_digest,
        OLD.selected_verification_id,OLD.selected_evidence_digest,OLD.drain_evidence_digest,
        OLD.simulation_evidence_digest,OLD.prepared_at,OLD.expires_at)
       IS DISTINCT FROM
       ROW(NEW.plan_id,NEW.request_id,NEW.actor_identity_id,NEW.mode,NEW.volume_uuid,
        NEW.header_revision_before,NEW.automatic_slot_id,NEW.recovery_slot_id,NEW.selected_slot_id,
        NEW.backup_evidence_digest,NEW.recovery_verification_id,NEW.recovery_evidence_digest,
        NEW.selected_verification_id,NEW.selected_evidence_digest,NEW.drain_evidence_digest,
        NEW.simulation_evidence_digest,NEW.prepared_at,NEW.expires_at) THEN
        RAISE EXCEPTION 'unlock transition prepared facts are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.revision<>OLD.revision+1 OR NOT (
        (OLD.state='prepared' AND NEW.state='committing') OR
        (OLD.state='committing' AND NEW.state IN ('enabled','rolled_back','manual_recovery_required'))
    ) THEN
        RAISE EXCEPTION 'unlock transition state or revision is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER unlock_protection_transition_mutation
BEFORE UPDATE ON security.unlock_protection_transitions
FOR EACH ROW EXECUTE FUNCTION security.enforce_unlock_transition_mutation();

CREATE FUNCTION security.reject_unlock_transition_delete()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unlock transition evidence is retained' USING ERRCODE='23514'; END; $$;

CREATE TRIGGER unlock_protection_transition_no_delete
BEFORE DELETE ON security.unlock_protection_transitions
FOR EACH ROW EXECUTE FUNCTION security.reject_unlock_transition_delete();

CREATE TRIGGER unlock_protection_transition_event_immutable
BEFORE UPDATE OR DELETE ON security.unlock_protection_transition_events
FOR EACH ROW EXECUTE FUNCTION security.reject_unlock_transition_delete();
