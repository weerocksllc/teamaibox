-- Additive only: no existing computer row, disk identity or runtime is changed.
CREATE TABLE platform.computer_installation_media (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    request_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    name text NOT NULL CHECK (length(name)>0),
    source jsonb NOT NULL CHECK (jsonb_typeof(source)='object' AND source->>'kind' IN ('upload','drive')),
    state text NOT NULL CHECK (state IN ('preparing','ready','failed','deleting','deleted')),
    object_id uuid,
    object_version integer,
    digest text CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
    size_bytes bigint CHECK (size_bytes>0),
    compatibility text CHECK (compatibility IN ('arm64','wrong-architecture','not-bootable','invalid','unverified')),
    error_code text,
    copied_bytes bigint NOT NULL DEFAULT 0 CHECK (copied_bytes>=0),
    claim_id uuid,
    claimed_until timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(id,owner_id),
    UNIQUE(owner_id,request_key),
    FOREIGN KEY(object_id,object_version) REFERENCES objects.object_versions(object_id,version) ON DELETE RESTRICT,
    CHECK ((object_id IS NULL)=(object_version IS NULL)),
    CHECK (state<>'ready' OR (object_id IS NOT NULL AND digest IS NOT NULL AND size_bytes IS NOT NULL AND compatibility IS NOT NULL))
);

-- Absence of a row means a legacy fixed-media computer, NOT a new empty disk.
CREATE TABLE platform.computer_installations (
    computer_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    phase text NOT NULL DEFAULT 'empty' CHECK (phase IN ('empty','installing','user-confirmed')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    observed_revision bigint NOT NULL DEFAULT 1 CHECK (observed_revision>=0 AND observed_revision<=revision),
    desired_media_id uuid,
    observed_media_id uuid,
    operation_id uuid,
    boot_request_id uuid,
    boot_media_id uuid,
    boot_generation bigint CHECK (boot_generation>0),
    boot_state text CHECK (boot_state IN ('pending','armed','consumed','cancelled')),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(computer_id,owner_id) REFERENCES platform.computers(id,owner_id) ON DELETE RESTRICT,
    FOREIGN KEY(desired_media_id,owner_id) REFERENCES platform.computer_installation_media(id,owner_id) ON DELETE RESTRICT,
    FOREIGN KEY(observed_media_id,owner_id) REFERENCES platform.computer_installation_media(id,owner_id) ON DELETE RESTRICT,
    FOREIGN KEY(boot_media_id,owner_id) REFERENCES platform.computer_installation_media(id,owner_id) ON DELETE RESTRICT,
    CHECK ((boot_request_id IS NULL AND boot_media_id IS NULL AND boot_generation IS NULL AND boot_state IS NULL)
      OR (boot_request_id IS NOT NULL AND boot_media_id IS NOT NULL AND boot_generation IS NOT NULL AND boot_state IS NOT NULL))
);

CREATE FUNCTION platform.guard_computer_installation_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'installation copies require explicit reference release before retention cleanup' USING ERRCODE='23514';
    END IF;
    IF (NEW.id,NEW.owner_id,NEW.request_key,NEW.request_fingerprint,NEW.source,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.request_key,OLD.request_fingerprint,OLD.source,OLD.created_at)
       OR NEW.revision<>OLD.revision+1 OR OLD.state='deleted' THEN
        RAISE EXCEPTION 'installation media identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.state='ready' AND ((NEW.digest,NEW.size_bytes,NEW.compatibility)
       IS DISTINCT FROM (OLD.digest,OLD.size_bytes,OLD.compatibility)
       OR ((NEW.object_id,NEW.object_version) IS DISTINCT FROM (OLD.object_id,OLD.object_version)
         AND NOT (NEW.state='deleted' AND NEW.object_id IS NULL AND NEW.object_version IS NULL))) THEN
        RAISE EXCEPTION 'ready installation bytes are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.state IN ('deleting','deleted') AND EXISTS (SELECT 1 FROM platform.computer_installations
       WHERE desired_media_id=OLD.id OR observed_media_id=OLD.id
       OR (boot_media_id=OLD.id AND boot_state IN ('pending','armed'))) THEN
        RAISE EXCEPTION 'installation media is still in use' USING ERRCODE='23514';
    END IF;
    IF NEW.state='ready' THEN
        PERFORM 1 FROM objects.object_entries WHERE id=NEW.object_id AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'installation object is unavailable' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER computer_installation_media_guard BEFORE UPDATE OR DELETE ON platform.computer_installation_media
FOR EACH ROW EXECUTE FUNCTION platform.guard_computer_installation_media();

CREATE FUNCTION platform.guard_computer_installation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE media_id uuid;
BEGIN
    IF TG_OP='UPDATE' AND ((NEW.computer_id,NEW.owner_id) IS DISTINCT FROM (OLD.computer_id,OLD.owner_id)
      OR NEW.revision<>OLD.revision+1) THEN
        RAISE EXCEPTION 'installation update requires the same computer and next revision' USING ERRCODE='23514';
    END IF;
    -- Same row locks serialize deletion versus a concurrent mount, not merely
    -- an application-level "is in use" check with a race between statements.
    FOR media_id IN SELECT DISTINCT v FROM unnest(ARRAY[NEW.desired_media_id,NEW.observed_media_id,
      CASE WHEN NEW.boot_state IN ('pending','armed') THEN NEW.boot_media_id ELSE NULL END]) v WHERE v IS NOT NULL ORDER BY v LOOP
        PERFORM 1 FROM platform.computer_installation_media WHERE id=media_id AND owner_id=NEW.owner_id AND state='ready' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'installation media is not ready or owned' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF TG_OP='UPDATE' AND NEW.boot_request_id=OLD.boot_request_id AND OLD.boot_state IN ('consumed','cancelled')
      AND NEW.boot_state IS DISTINCT FROM OLD.boot_state THEN
        RAISE EXCEPTION 'completed boot request cannot be replayed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER computer_installation_guard BEFORE INSERT OR UPDATE ON platform.computer_installations
FOR EACH ROW EXECUTE FUNCTION platform.guard_computer_installation();

CREATE INDEX computer_installation_media_owner ON platform.computer_installation_media(owner_id,created_at,id);

-- An ordinary object-delete request must not invalidate an ISO still in the
-- media library. Explicit library deletion first moves it to deleting.
CREATE FUNCTION platform.guard_installation_object_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS
       (SELECT 1 FROM platform.computer_installation_media WHERE object_id=OLD.id AND state='ready') THEN
        RAISE EXCEPTION 'installation object is still referenced' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER installation_object_delete_guard BEFORE UPDATE OF deleted_at ON objects.object_entries
FOR EACH ROW EXECUTE FUNCTION platform.guard_installation_object_delete();
