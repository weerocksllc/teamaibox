-- Updating the host program is not reinstalling Windows. Keep every guest
-- identity and system artifact immutable; allow only the runtime image to
-- advance when a stopped computer begins a fresh, exactly recorded run.
CREATE OR REPLACE FUNCTION platform.guard_computer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id,NEW.owner_id,NEW.node_id,NEW.pool_id,NEW.profile_id,NEW.volume_id,NEW.firmware_id,NEW.tpm_id,NEW.resources)
        IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.node_id,OLD.pool_id,OLD.profile_id,OLD.volume_id,OLD.firmware_id,OLD.tpm_id,OLD.resources)
        OR OLD.state='deleted' OR NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation THEN
        RAISE EXCEPTION 'computer identity is immutable; update must advance revision' USING ERRCODE='23514';
    END IF;
    IF NEW.profile IS DISTINCT FROM OLD.profile AND NOT COALESCE((
        NEW.profile - 'runtimeImage' = OLD.profile - 'runtimeImage'
        AND COALESCE(NEW.profile->>'runtimeImage','') ~ '^sha256:[a-f0-9]{64}$'
        AND OLD.state='stopped' AND OLD.run IS NULL AND NEW.state='starting'
        AND NEW.generation=OLD.generation+1 AND NEW.run IS NOT NULL
        AND NEW.run->>'runtimeImage'=NEW.profile->>'runtimeImage'
        AND (NEW.run->>'generation')::bigint=NEW.generation
    ),false) THEN
        RAISE EXCEPTION 'computer identity is immutable; runtime update requires a new stopped start' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
