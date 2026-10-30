-- Restoring the old guard does not rewrite any guest, completed run or image.
CREATE OR REPLACE FUNCTION platform.guard_computer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id,NEW.owner_id,NEW.node_id,NEW.pool_id,NEW.profile_id,NEW.volume_id,NEW.firmware_id,NEW.tpm_id,NEW.profile,NEW.resources)
        IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.node_id,OLD.pool_id,OLD.profile_id,OLD.volume_id,OLD.firmware_id,OLD.tpm_id,OLD.profile,OLD.resources)
        OR OLD.state='deleted' OR NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation THEN
        RAISE EXCEPTION 'computer identity is immutable; update must advance revision' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
