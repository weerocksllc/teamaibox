-- Version metadata only. No disk, runtime, account or writable phone data changes.
CREATE TABLE platform.phone_rom_versions (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9.-]{2,127}$'),
    family_id text NOT NULL CHECK (family_id IN ('aosp','google-experimental')),
    display_name text NOT NULL,
    version_label text NOT NULL,
    base_build_id text NOT NULL CHECK (base_build_id='16102939'),
    runtime_image_digest text NOT NULL CHECK (runtime_image_digest ~ '^sha256:[a-f0-9]{64}$'),
    google_play boolean NOT NULL,
    experimental boolean NOT NULL,
    camera_capability text NOT NULL DEFAULT 'unavailable' CHECK (camera_capability IN ('unavailable','verified')),
    create_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (NOT google_play OR experimental)
);
INSERT INTO platform.phone_rom_versions
    (id,family_id,display_name,version_label,base_build_id,runtime_image_digest,google_play,experimental,create_enabled)
VALUES ('aosp-17-16102939-v1','aosp','Android AOSP','Android 17 · 16102939 · v1','16102939',
    'sha256:93e913dd5435577deab64a626c4cf75a40a72bedde188b240f212e913c1276ac',false,false,true),
    ('google-experimental-17-16102939-v1','google-experimental','Android + Google Play','Android 17 · 16102939 · v1','16102939',
    'sha256:35352deb21f8b66330140c550f19730e37ad65c5049aadc42be6e3fadf15bc4b',true,true,false);

-- Old phones are all the fixed AOSP build, but may have used an older wrapper.
-- Preserve that actual last runtime as an unavailable-for-create historical
-- version; never silently relabel it as the current image or replace its disk.
INSERT INTO platform.phone_rom_versions
    (id,family_id,display_name,version_label,base_build_id,runtime_image_digest,google_play,experimental)
SELECT DISTINCT 'aosp-17-runtime-'||substr(r.image_digest,8),'aosp','Android AOSP',
    'Android 17 · 16102939 · existing runtime','16102939',r.image_digest,false,false
FROM platform.phones p JOIN LATERAL (SELECT image_digest FROM platform.phone_runs
    WHERE phone_id=p.id ORDER BY generation DESC LIMIT 1) r ON true
WHERE r.image_digest<>'sha256:93e913dd5435577deab64a626c4cf75a40a72bedde188b240f212e913c1276ac';

ALTER TABLE platform.phones ADD COLUMN rom_version_id text NOT NULL DEFAULT 'aosp-17-16102939-v1'
    REFERENCES platform.phone_rom_versions(id) ON DELETE RESTRICT;
-- The old identity trigger prohibits any update of deletion tombstones. This
-- transaction only adds their version metadata and restores the same guard.
ALTER TABLE platform.phones DISABLE TRIGGER phone_identity_guard;
UPDATE platform.phones p SET rom_version_id='aosp-17-runtime-'||substr(r.image_digest,8)
FROM (SELECT DISTINCT ON(phone_id) phone_id,image_digest FROM platform.phone_runs ORDER BY phone_id,generation DESC) r
WHERE p.id=r.phone_id AND r.image_digest<>'sha256:93e913dd5435577deab64a626c4cf75a40a72bedde188b240f212e913c1276ac';
ALTER TABLE platform.phones ENABLE TRIGGER phone_identity_guard;

CREATE FUNCTION platform.guard_phone_rom_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' OR (to_jsonb(NEW)-'create_enabled') IS DISTINCT FROM (to_jsonb(OLD)-'create_enabled') THEN
        RAISE EXCEPTION 'phone ROM version is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_rom_version_guard BEFORE UPDATE OR DELETE ON platform.phone_rom_versions
FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_rom_version();
CREATE FUNCTION platform.guard_phone_rom_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.rom_version_id IS DISTINCT FROM OLD.rom_version_id THEN
        RAISE EXCEPTION 'phone ROM cannot be replaced' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_rom_binding_guard BEFORE UPDATE ON platform.phones
FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_rom_binding();
