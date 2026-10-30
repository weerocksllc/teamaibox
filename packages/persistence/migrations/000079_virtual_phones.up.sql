-- Additive: no existing identity, storage, model or media rows are rewritten.
INSERT INTO iam.permissions (permission_key, description_key) VALUES
    ('phone:use', 'permissions.phone_use'), ('phone:manage', 'permissions.phone_manage');
INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, mapping.permission_key FROM iam.roles role
JOIN (VALUES ('owner','phone:use'), ('owner','phone:manage'), ('system_admin','phone:manage'),
    ('compute_admin','phone:use'), ('compute_admin','phone:manage'), ('application_admin','phone:use'),
    ('developer','phone:use'), ('team_admin','phone:use'), ('member','phone:use'))
AS mapping(role_key,permission_key) ON role.role_key=mapping.role_key;

CREATE TABLE platform.phone_quotas (
    owner_id uuid PRIMARY KEY REFERENCES iam.identities(id) ON DELETE RESTRICT,
    stored_limit integer NOT NULL CHECK (stored_limit BETWEEN 0 AND 100),
    running_limit integer NOT NULL CHECK (running_limit BETWEEN 0 AND 2 AND running_limit <= stored_limit),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE platform.phones (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64 AND name=btrim(name) AND name !~ '[[:cntrl:]]'),
    state text NOT NULL CHECK (state IN ('creating','stopped','starting','running','stopping','unavailable','error','deleting','deleted')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    spec_id text NOT NULL CHECK (spec_id='cuttlefish-arm64-office-v1'),
    base_build_id text NOT NULL CHECK (base_build_id='16102939'),
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    volume_id uuid NOT NULL UNIQUE,
    storage_bytes bigint NOT NULL CHECK (storage_bytes=17179869184),
    running_charged boolean NOT NULL DEFAULT false,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^phone_[a-z_]{2,55}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    UNIQUE (id,owner_id),
    CHECK ((state='deleted')=(deleted_at IS NOT NULL)),
    CHECK (state NOT IN ('stopped','deleted') OR NOT running_charged),
    CHECK (state NOT IN ('starting','running','stopping') OR running_charged)
);
CREATE INDEX phones_owner_list_idx ON platform.phones(owner_id,created_at,id) WHERE state<>'deleted';
CREATE INDEX phones_node_active_idx ON platform.phones(node_id,id) WHERE running_charged;

CREATE TABLE platform.phone_operations (
    id uuid PRIMARY KEY,
    phone_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('create','start','stop','restart','delete')),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','executing','succeeded','failed')),
    generation bigint NOT NULL CHECK (generation >= 0),
    start_after_create boolean NOT NULL DEFAULT false,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^phone_[a-z_]{2,55}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    FOREIGN KEY (phone_id,owner_id) REFERENCES platform.phones(id,owner_id) ON DELETE RESTRICT,
    UNIQUE (owner_id,action,idempotency_key),
    CHECK ((state IN ('succeeded','failed'))=(finished_at IS NOT NULL)),
    CHECK (state<>'failed' OR error_code IS NOT NULL),
    CHECK (NOT start_after_create OR action='create')
);
CREATE UNIQUE INDEX phone_operations_one_active_idx ON platform.phone_operations(phone_id)
WHERE state IN ('queued','executing');
CREATE INDEX phone_operations_reconcile_idx ON platform.phone_operations(updated_at,id)
WHERE state IN ('queued','executing');

CREATE TABLE platform.phone_runs (
    id uuid PRIMARY KEY,
    phone_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    reservation_id uuid NOT NULL UNIQUE,
    image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
    state text NOT NULL CHECK (state IN ('reserved','starting','running','stopping','unavailable','stopped')),
    memory_bytes bigint NOT NULL CHECK (memory_bytes=6442450944),
    cpu_millis integer NOT NULL CHECK (cpu_millis=2000),
    container_id text CHECK (container_id IS NULL OR container_id ~ '^[a-f0-9]{64}$'),
    clean_shutdown boolean,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    stopped_at timestamptz,
    FOREIGN KEY (phone_id,owner_id) REFERENCES platform.phones(id,owner_id) ON DELETE RESTRICT,
    UNIQUE (phone_id,generation), UNIQUE(id,phone_id,owner_id,generation),
    CHECK ((state='stopped')=(stopped_at IS NOT NULL)),
    CHECK (state='stopped' OR clean_shutdown IS NULL)
);
CREATE UNIQUE INDEX phone_runs_one_live_idx ON platform.phone_runs(phone_id) WHERE state<>'stopped';

-- A projection of durable runs, not another expiring lease or independent capacity ledger.
CREATE VIEW compute.phone_resource_reservations AS
SELECT reservation_id, id AS run_id, node_id, node_generation,
    jsonb_build_object('cpuMillis',cpu_millis,'unifiedMemoryBytes',memory_bytes,
        'acceleratorUnits',0,'codecSessions',0,'storageBytes',0,'networkBitsPerSecond',10000000) AS reservation
FROM platform.phone_runs WHERE state<>'stopped';

CREATE TABLE platform.phone_access_grants (
    id uuid PRIMARY KEY,
    phone_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    run_id uuid NOT NULL,
    generation bigint NOT NULL,
    session_id uuid NOT NULL REFERENCES iam.sessions(id) ON DELETE RESTRICT,
    kind text NOT NULL CHECK (kind IN ('control','adb')),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
    state text NOT NULL CHECK (state IN ('issued','connected','revoking','revoked','expired')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    ended_at timestamptz,
    FOREIGN KEY (run_id,phone_id,owner_id,generation) REFERENCES platform.phone_runs(id,phone_id,owner_id,generation) ON DELETE RESTRICT,
    CHECK (expires_at>created_at AND expires_at<=created_at+CASE WHEN kind='adb' THEN interval '15 minutes' ELSE interval '60 seconds' END),
    CHECK ((state IN ('revoked','expired'))=(ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX phone_grants_one_control_idx ON platform.phone_access_grants(phone_id)
WHERE kind='control' AND state IN ('issued','connected','revoking');
CREATE INDEX phone_grants_session_idx ON platform.phone_access_grants(session_id) WHERE state IN ('issued','connected','revoking');

CREATE FUNCTION platform.guard_phone_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        -- A plaintext Docker volume is not a fallback for an unavailable encrypted pool.
        IF NOT EXISTS (SELECT 1 FROM objects.storage_pools p WHERE p.pool_id=NEW.pool_id
            AND p.node_id=NEW.node_id AND p.backend_kind IN ('local-block','local-filesystem')
            AND p.encryption_mode='luks2' AND p.encryption_status='verified'
            AND p.compatibility_status='verified' AND p.health_state='healthy' AND p.lifecycle_state='active') THEN
            RAISE EXCEPTION 'phone encrypted storage unavailable' USING ERRCODE='23514';
        END IF;
    ELSE
        IF (NEW.id,NEW.owner_id,NEW.node_id,NEW.pool_id,NEW.volume_id,NEW.spec_id,NEW.base_build_id,NEW.storage_bytes)
            IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.node_id,OLD.pool_id,OLD.volume_id,OLD.spec_id,OLD.base_build_id,OLD.storage_bytes)
            OR OLD.state='deleted' OR NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation THEN
            RAISE EXCEPTION 'phone identity or revision is immutable' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_identity_guard BEFORE INSERT OR UPDATE ON platform.phones
FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_identity();

CREATE FUNCTION platform.guard_phone_grant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM iam.sessions s WHERE s.id=NEW.session_id AND s.identity_id=NEW.owner_id) THEN
        RAISE EXCEPTION 'phone grant login owner mismatch' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','consumed_at','ended_at']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['state','consumed_at','ended_at']) THEN
        RAISE EXCEPTION 'phone grant identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER phone_grant_identity_guard BEFORE INSERT OR UPDATE ON platform.phone_access_grants
FOR EACH ROW EXECUTE FUNCTION platform.guard_phone_grant_identity();
