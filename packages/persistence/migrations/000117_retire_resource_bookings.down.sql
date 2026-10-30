-- Restore empty compatibility metadata only; user disks and rows are untouched.
DROP TRIGGER office_transaction_runtime_fence ON compute.protected_office_set_transactions;
DROP TRIGGER cast_session_maintenance_fence ON platform.cast_sessions;
DROP FUNCTION compute.fence_runtime_maintenance();
-- A receiver with an uncertain stop remains charged even after session TTL.
-- Only the trusted control path may release after confirmed media withdrawal.
CREATE FUNCTION compute.cast_resource_numbers_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN jsonb_typeof(value) <> 'object' THEN false ELSE
        value ?& ARRAY['cpuMillis','unifiedMemoryBytes','acceleratorUnits',
            'codecSessions','storageBytes','networkBitsPerSecond']
        AND value - ARRAY['cpuMillis','unifiedMemoryBytes','acceleratorUnits',
            'codecSessions','storageBytes','networkBitsPerSecond'] = '{}'::jsonb
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(value) field
            WHERE jsonb_typeof(field.value) <> 'number'
               OR field.value::text !~ '^(0|[1-9][0-9]{0,15})$'
               OR field.value::text::numeric > 9007199254740991)
    END;
$$;
CREATE TABLE compute.cast_resource_reservations (
    session_id uuid PRIMARY KEY REFERENCES platform.cast_sessions(id) ON DELETE RESTRICT,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    profile_digest text NOT NULL CHECK (profile_digest ~ '^sha256:[0-9a-f]{64}$'),
    output_sinks text[] NOT NULL CHECK (platform.cast_output_sinks_valid(output_sinks)),
    reservation jsonb NOT NULL CHECK (compute.cast_resource_numbers_valid(reservation)
        AND (reservation->>'cpuMillis')::numeric > 0
        AND (reservation->>'unifiedMemoryBytes')::numeric > 0
        AND (reservation->>'networkBitsPerSecond')::numeric > 0),
    codec_directions jsonb NOT NULL CHECK (codec_directions =
        jsonb_build_object('decodeSessions',1,'encodeSessions',
            CASE WHEN 'browser'=ANY(output_sinks) THEN 1 ELSE 0 END)),
    display_sessions integer NOT NULL CHECK (display_sessions IN (0, 1)),
    audio_sessions integer NOT NULL CHECK (audio_sessions IN (0, 1)),
    state text NOT NULL CHECK (state IN ('active', 'released')),
    created_at timestamptz NOT NULL,
    released_at timestamptz,
    CHECK ((state = 'active' AND released_at IS NULL)
        OR (state = 'released' AND released_at IS NOT NULL AND released_at >= created_at)),
    CHECK ((reservation->>'codecSessions')::numeric =
        CASE WHEN 'browser'=ANY(output_sinks) THEN 2 ELSE 1 END),
    CHECK (display_sessions = CASE WHEN 'hdmi'=ANY(output_sinks) THEN 1 ELSE 0 END
        AND audio_sessions = display_sessions)
);

CREATE UNIQUE INDEX cast_resource_one_active_node_idx
ON compute.cast_resource_reservations(node_id) WHERE state = 'active';

CREATE FUNCTION compute.guard_cast_resource_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'casting reservation history cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> 'active' OR NEW.state <> 'released'
       OR (to_jsonb(NEW) - 'state' - 'released_at') IS DISTINCT FROM
          (to_jsonb(OLD) - 'state' - 'released_at') THEN
        RAISE EXCEPTION 'casting reservation identity or terminal state cannot change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER cast_resource_reservation_guard
BEFORE UPDATE OR DELETE ON compute.cast_resource_reservations
FOR EACH ROW EXECUTE FUNCTION compute.guard_cast_resource_reservation();

-- Both sides lock the scheduler node before admission. This also fences an
-- expired session whose receiver has not yet acknowledged withdrawal.
CREATE FUNCTION compute.fence_casting_and_office_maintenance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM id FROM compute.nodes WHERE id=NEW.node_id FOR UPDATE;
    IF TG_TABLE_NAME = 'protected_office_set_transactions' THEN
        IF EXISTS (SELECT 1 FROM compute.cast_resource_reservations
                   WHERE node_id=NEW.node_id AND state='active') THEN
            RAISE EXCEPTION 'casting cleanup is required before office maintenance' USING ERRCODE='23514';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM compute.protected_office_set_transactions
                   WHERE node_id=NEW.node_id AND transaction_state NOT IN ('succeeded','rolled-back')) THEN
            RAISE EXCEPTION 'office maintenance is active; casting cannot start' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER cast_reservation_office_fence BEFORE INSERT ON compute.cast_resource_reservations
FOR EACH ROW EXECUTE FUNCTION compute.fence_casting_and_office_maintenance();
CREATE TRIGGER office_transaction_casting_fence BEFORE INSERT ON compute.protected_office_set_transactions
FOR EACH ROW EXECUTE FUNCTION compute.fence_casting_and_office_maintenance();

CREATE VIEW compute.phone_resource_reservations AS
SELECT reservation_id, id AS run_id, node_id, node_generation,
    jsonb_build_object('cpuMillis',cpu_millis,'unifiedMemoryBytes',memory_bytes,
        'acceleratorUnits',0,'codecSessions',0,'storageBytes',0,'networkBitsPerSecond',10000000) AS reservation
FROM platform.phone_runs WHERE state<>'stopped';
CREATE TABLE compute.computer_storage_reservations (
    computer_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    node_id uuid NOT NULL REFERENCES compute.nodes(id),
    pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id),
    volume_id uuid NOT NULL UNIQUE,
    bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=9007199254740991),
    state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','released')),
    FOREIGN KEY(computer_id,owner_id) REFERENCES platform.computers(id,owner_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE VIEW compute.computer_resource_reservations AS
SELECT id AS reservation_id,id AS run_id,node_id,node_generation,
    jsonb_build_object('cpuMillis',cpu_millis,'unifiedMemoryBytes',memory_bytes,
        'acceleratorUnits',0,'codecSessions',0,'storageBytes',0,'networkBitsPerSecond',0) AS reservation
FROM compute.computer_runs WHERE state='active';
