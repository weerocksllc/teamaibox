-- Additive camera input metadata. No frames, accounts, host paths or new capacity ledger.
CREATE TABLE platform.phone_camera_inputs (
    id uuid PRIMARY KEY,
    source_id uuid NOT NULL,
    phone_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    run_id uuid NOT NULL,
    generation bigint NOT NULL,
    session_id uuid NOT NULL REFERENCES iam.sessions(id) ON DELETE RESTRICT,
    source_kind text NOT NULL CHECK (source_kind IN ('image','browser','usb','video','udp')),
    source_config jsonb NOT NULL CHECK (jsonb_typeof(source_config)='object' AND octet_length(source_config::text)<=2048),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    state text NOT NULL CHECK (state IN ('starting','active','stopping','stopped')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    stopped_at timestamptz,
    FOREIGN KEY (run_id,phone_id,owner_id,generation) REFERENCES platform.phone_runs(id,phone_id,owner_id,generation) ON DELETE RESTRICT,
    UNIQUE (phone_id,source_id),
    CHECK ((state='stopped')=(stopped_at IS NOT NULL))
);
CREATE UNIQUE INDEX phone_camera_one_input_idx ON platform.phone_camera_inputs(phone_id) WHERE state<>'stopped';
CREATE INDEX phone_camera_active_idx ON platform.phone_camera_inputs(updated_at,id) WHERE state<>'stopped';
CREATE FUNCTION platform.guard_phone_camera_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM iam.sessions s WHERE s.id=NEW.session_id AND s.identity_id=NEW.owner_id) THEN
        RAISE EXCEPTION 'phone camera login owner mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['state','updated_at','stopped_at']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['state','updated_at','stopped_at']) OR OLD.state='stopped'
        OR (OLD.state='stopping' AND NEW.state NOT IN ('stopping','stopped'))
        OR (OLD.state='active' AND NEW.state NOT IN ('active','stopping'))) THEN
        RAISE EXCEPTION 'phone camera input identity or lifetime is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_camera_input_guard BEFORE INSERT OR UPDATE ON platform.phone_camera_inputs
FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_camera_input();
