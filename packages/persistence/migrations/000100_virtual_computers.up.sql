-- Separate Windows guests from Android ROMs; reuse identity, node and pool IDs.
-- No live guest, profile or capacity policy is enabled by migration.
INSERT INTO iam.permissions(permission_key,description_key) VALUES
    ('computer:use','permissions.computer_use'),('computer:manage','permissions.computer_manage');
INSERT INTO iam.role_permissions(role_id,permission_key)
SELECT r.id,p.permission_key FROM iam.roles r JOIN (VALUES
    ('owner','computer:use'),('owner','computer:manage'),('system_admin','computer:manage'),
    ('compute_admin','computer:use'),('compute_admin','computer:manage'),('application_admin','computer:use'),
    ('developer','computer:use'),('team_admin','computer:use'),('member','computer:use')) p(role_key,permission_key)
    ON r.role_key=p.role_key;
CREATE TABLE platform.computer_profiles (
    id text PRIMARY KEY,
    profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object' AND profile->>'id'=id),
    create_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE platform.computers (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    profile_id text NOT NULL REFERENCES platform.computer_profiles(id) ON DELETE RESTRICT,
    volume_id uuid NOT NULL UNIQUE,
    firmware_id uuid NOT NULL UNIQUE,
    tpm_id uuid UNIQUE,
    name text NOT NULL CHECK (length(btrim(name))>0 AND name=btrim(name) AND name !~ '[[:cntrl:]]'),
    state text NOT NULL CHECK (state IN ('creating','stopped','starting','running','stopping','unavailable','error','deleting','deleted')),
    revision bigint NOT NULL CHECK (revision>0),
    generation bigint NOT NULL CHECK (generation>=0),
    profile jsonb NOT NULL CHECK (jsonb_typeof(profile)='object' AND profile->>'id'=profile_id),
    resources jsonb NOT NULL CHECK (jsonb_typeof(resources)='object'),
    run jsonb CHECK (run IS NULL OR jsonb_typeof(run)='object'),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(id,owner_id),
    CHECK (state NOT IN ('stopped','deleting','deleted') OR run IS NULL),
    CHECK (state NOT IN ('starting','running','stopping') OR run IS NOT NULL)
);
CREATE INDEX computers_owner_idx ON platform.computers(owner_id,created_at,id) WHERE state<>'deleted';
CREATE INDEX computers_node_idx ON platform.computers(node_id) WHERE run IS NOT NULL;
CREATE TABLE platform.computer_operations (
    id uuid PRIMARY KEY,
    computer_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    action text NOT NULL CHECK(action IN ('create','start','shutdown','delete')),
    request_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
    state text NOT NULL CHECK(state IN ('queued','executing','succeeded','failed')),
    generation bigint NOT NULL CHECK(generation>=0),
    command jsonb NOT NULL CHECK(jsonb_typeof(command)='object'),
    error_code text,
    claim_id uuid,
    claimed_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    FOREIGN KEY(computer_id,owner_id) REFERENCES platform.computers(id,owner_id) ON DELETE RESTRICT,
    UNIQUE(owner_id,action,request_key),
    CHECK ((state IN ('succeeded','failed'))=(finished_at IS NOT NULL)),
    CHECK ((claim_id IS NULL)=(claimed_until IS NULL))
);
CREATE UNIQUE INDEX computer_operations_one_active_idx ON platform.computer_operations(computer_id) WHERE state IN ('queued','executing');
CREATE INDEX computer_operations_pending_idx ON platform.computer_operations(updated_at,id) WHERE state IN ('queued','executing');

-- Commitments survive API/Agent disconnection. A timeout does not prove a
-- guest stopped and must never silently free its memory or disk reservation.
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
CREATE TABLE compute.computer_runs (
    id uuid PRIMARY KEY,
    computer_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    node_id uuid NOT NULL REFERENCES compute.nodes(id),
    node_generation bigint NOT NULL CHECK(node_generation>0),
    generation bigint NOT NULL CHECK(generation>0),
    memory_bytes bigint NOT NULL CHECK(memory_bytes>0 AND memory_bytes<=9007199254740991),
    cpu_millis bigint NOT NULL CHECK(cpu_millis>0 AND cpu_millis<=9007199254740991),
    cpu_ids jsonb NOT NULL CHECK(jsonb_typeof(cpu_ids)='array' AND jsonb_array_length(cpu_ids)>0),
    state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','released')),
    FOREIGN KEY(computer_id,owner_id) REFERENCES platform.computers(id,owner_id),
    UNIQUE(computer_id,generation)
);
CREATE UNIQUE INDEX computer_runs_one_active ON compute.computer_runs(computer_id) WHERE state='active';
CREATE VIEW compute.computer_resource_reservations AS
SELECT id AS reservation_id,id AS run_id,node_id,node_generation,
    jsonb_build_object('cpuMillis',cpu_millis,'unifiedMemoryBytes',memory_bytes,
        'acceleratorUnits',0,'codecSessions',0,'storageBytes',0,'networkBitsPerSecond',0) AS reservation
FROM compute.computer_runs WHERE state='active';

CREATE FUNCTION platform.guard_computer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id,NEW.owner_id,NEW.node_id,NEW.pool_id,NEW.profile_id,NEW.volume_id,NEW.firmware_id,NEW.tpm_id,NEW.profile,NEW.resources)
        IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.node_id,OLD.pool_id,OLD.profile_id,OLD.volume_id,OLD.firmware_id,OLD.tpm_id,OLD.profile,OLD.resources)
        OR OLD.state='deleted' OR NEW.revision<>OLD.revision+1 OR NEW.generation<OLD.generation THEN
        RAISE EXCEPTION 'computer identity is immutable; update must advance revision' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER computer_identity_guard BEFORE UPDATE ON platform.computers FOR EACH ROW EXECUTE FUNCTION platform.guard_computer_identity();
CREATE FUNCTION platform.guard_computer_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id<>OLD.id OR NEW.profile IS DISTINCT FROM OLD.profile THEN
        RAISE EXCEPTION 'publish a new profile instead of replacing an existing Windows system' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER computer_profile_guard BEFORE UPDATE ON platform.computer_profiles FOR EACH ROW EXECUTE FUNCTION platform.guard_computer_profile();
CREATE FUNCTION platform.guard_computer_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id,NEW.computer_id,NEW.owner_id,NEW.action,NEW.request_key,NEW.request_fingerprint,NEW.generation,NEW.command)
        IS DISTINCT FROM (OLD.id,OLD.computer_id,OLD.owner_id,OLD.action,OLD.request_key,OLD.request_fingerprint,OLD.generation,OLD.command)
        OR OLD.state IN ('succeeded','failed') THEN
        RAISE EXCEPTION 'computer operation identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER computer_operation_guard BEFORE UPDATE ON platform.computer_operations FOR EACH ROW EXECUTE FUNCTION platform.guard_computer_operation();
