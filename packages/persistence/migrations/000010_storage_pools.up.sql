CREATE TABLE objects.storage_pools (
    pool_id text PRIMARY KEY CHECK (pool_id ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
    backend_kind text NOT NULL CHECK (
        backend_kind IN ('local-block', 'local-filesystem', 's3-compatible')
    ),
    node_id uuid REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    failure_domain text NOT NULL CHECK (failure_domain ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    lifecycle_state text NOT NULL DEFAULT 'active' CHECK (
        lifecycle_state IN ('active', 'draining', 'drained', 'removed')
    ),
    health_state text NOT NULL DEFAULT 'unknown' CHECK (
        health_state IN ('unknown', 'healthy', 'degraded', 'unavailable')
    ),
    total_bytes bigint CHECK (total_bytes IS NULL OR total_bytes >= 1),
    available_bytes bigint CHECK (available_bytes IS NULL OR available_bytes >= 0),
    safety_reserve_bytes bigint NOT NULL DEFAULT 0 CHECK (safety_reserve_bytes >= 0),
    encryption_mode text NOT NULL DEFAULT 'none' CHECK (
        encryption_mode IN ('none', 'luks2', 'provider-managed')
    ),
    encryption_status text NOT NULL DEFAULT 'pending' CHECK (
        encryption_status IN ('pending', 'verified', 'failed')
    ),
    encryption_verified_at timestamptz,
    compatibility_status text NOT NULL DEFAULT 'pending' CHECK (
        compatibility_status IN ('pending', 'verified', 'failed')
    ),
    compatibility_verified_at timestamptz,
    observed_at timestamptz,
    removed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((backend_kind IN ('local-block', 'local-filesystem')) = (node_id IS NOT NULL)),
    CHECK ((total_bytes IS NULL) = (available_bytes IS NULL)),
    CHECK (total_bytes IS NULL OR available_bytes <= total_bytes),
    CHECK ((encryption_status = 'verified') = (encryption_verified_at IS NOT NULL)),
    CHECK ((compatibility_status = 'verified') = (compatibility_verified_at IS NOT NULL)),
    CHECK ((lifecycle_state = 'removed') = (removed_at IS NOT NULL)),
    CHECK (updated_at >= created_at)
);

CREATE TRIGGER storage_pools_touch_updated_at
BEFORE UPDATE ON objects.storage_pools
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE objects.storage_pool_data_classes (
    pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE CASCADE,
    data_class text NOT NULL CHECK (data_class IN (
        'team-file', 'message-attachment', 'ai-artifact', 'dataset',
        'checkpoint', 'model-artifact', 'agent-workspace', 'plugin-data', 'cache'
    )),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (pool_id, data_class)
);

CREATE TABLE objects.storage_placement_reservations (
    reservation_id uuid PRIMARY KEY DEFAULT uuidv7(),
    blob_key text NOT NULL CHECK (length(blob_key) BETWEEN 1 AND 2048),
    data_class text NOT NULL CHECK (data_class IN (
        'team-file', 'message-attachment', 'ai-artifact', 'dataset',
        'checkpoint', 'model-artifact', 'agent-workspace', 'plugin-data', 'cache'
    )),
    size bigint NOT NULL CHECK (size >= 1),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    state text NOT NULL DEFAULT 'reserved' CHECK (
        state IN ('reserved', 'committed', 'aborted', 'expired')
    ),
    requested_copies smallint NOT NULL DEFAULT 1 CHECK (requested_copies BETWEEN 1 AND 8),
    expires_at timestamptz NOT NULL,
    committed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at > created_at),
    CHECK ((state = 'committed') = (committed_at IS NOT NULL)),
    CHECK (updated_at >= created_at)
);

CREATE INDEX storage_placement_reservations_expiry_idx
ON objects.storage_placement_reservations (state, expires_at, reservation_id);

CREATE TABLE objects.storage_placement_targets (
    reservation_id uuid NOT NULL
        REFERENCES objects.storage_placement_reservations(reservation_id) ON DELETE CASCADE,
    pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    allocation_kind text NOT NULL CHECK (allocation_kind IN ('primary', 'availability-copy')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (reservation_id, pool_id)
);

CREATE TABLE objects.storage_allocations (
    allocation_id uuid PRIMARY KEY DEFAULT uuidv7(),
    blob_key text NOT NULL REFERENCES objects.encrypted_blobs(blob_key) ON DELETE RESTRICT,
    pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    data_class text NOT NULL CHECK (data_class IN (
        'team-file', 'message-attachment', 'ai-artifact', 'dataset',
        'checkpoint', 'model-artifact', 'agent-workspace', 'plugin-data', 'cache'
    )),
    size bigint NOT NULL CHECK (size >= 1),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    allocation_kind text NOT NULL CHECK (allocation_kind IN ('primary', 'availability-copy')),
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (blob_key, pool_id)
);

CREATE INDEX storage_allocations_pool_idx
ON objects.storage_allocations (pool_id, data_class, blob_key);

CREATE TABLE objects.storage_migrations (
    migration_id uuid PRIMARY KEY DEFAULT uuidv7(),
    blob_key text NOT NULL REFERENCES objects.encrypted_blobs(blob_key) ON DELETE RESTRICT,
    data_class text NOT NULL CHECK (data_class IN (
        'team-file', 'message-attachment', 'ai-artifact', 'dataset',
        'checkpoint', 'model-artifact', 'agent-workspace', 'plugin-data', 'cache'
    )),
    size bigint NOT NULL CHECK (size >= 1),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    source_pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    target_pool_id text NOT NULL REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    state text NOT NULL CHECK (
        state IN ('copying', 'verifying', 'cleanup_pending', 'completed', 'failed', 'superseded')
    ),
    reused_existing_copy boolean NOT NULL DEFAULT false,
    candidate_cleanup_pending boolean NOT NULL DEFAULT false,
    failure_code text CHECK (
        failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    verified_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (source_pool_id <> target_pool_id),
    CHECK ((state IN ('completed', 'superseded')) = (completed_at IS NOT NULL)),
    CHECK (state <> 'cleanup_pending' OR verified_at IS NOT NULL),
    CHECK (updated_at >= created_at)
);

CREATE INDEX storage_migrations_source_state_idx
ON objects.storage_migrations (source_pool_id, state, blob_key);

CREATE INDEX storage_migrations_target_state_idx
ON objects.storage_migrations (target_pool_id, state, blob_key);

CREATE FUNCTION objects.storage_pool_ineligibility(
    candidate_pool_id text,
    candidate_data_class text,
    required_bytes bigint
)
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
    candidate objects.storage_pools%ROWTYPE;
    reasons text[] := ARRAY[]::text[];
    allocated bigint;
    placement_reserved bigint;
    migration_reserved bigint;
    available_to_place bigint;
BEGIN
    SELECT * INTO candidate
    FROM objects.storage_pools
    WHERE pool_id = candidate_pool_id;
    IF NOT FOUND THEN
        RETURN ARRAY['pool_missing'];
    END IF;
    IF candidate.lifecycle_state <> 'active' THEN
        reasons := array_append(reasons, 'lifecycle_' || candidate.lifecycle_state);
    END IF;
    IF candidate.health_state <> 'healthy' THEN
        reasons := array_append(reasons, 'health_' || candidate.health_state);
    END IF;
    IF candidate.observed_at IS NULL THEN
        reasons := array_append(reasons, 'observation_missing');
    ELSIF candidate.observed_at < clock_timestamp() - interval '5 minutes' THEN
        reasons := array_append(reasons, 'observation_stale');
    ELSIF candidate.observed_at > clock_timestamp() THEN
        reasons := array_append(reasons, 'observation_from_future');
    END IF;
    IF candidate.compatibility_status <> 'verified' THEN
        reasons := array_append(reasons, 'compatibility_' || candidate.compatibility_status);
    END IF;
    IF candidate.encryption_status <> 'verified' THEN
        reasons := array_append(reasons, 'encryption_' || candidate.encryption_status);
    END IF;
    IF candidate.backend_kind IN ('local-block', 'local-filesystem')
       AND candidate.encryption_mode <> 'luks2' THEN
        reasons := array_append(reasons, 'local_pool_requires_luks2');
    END IF;
    IF candidate.backend_kind = 's3-compatible'
       AND candidate.encryption_mode <> 'provider-managed' THEN
        reasons := array_append(reasons, 'object_pool_requires_provider_encryption');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM objects.storage_pool_data_classes allowed
        WHERE allowed.pool_id = candidate.pool_id
          AND allowed.data_class = candidate_data_class
    ) THEN
        reasons := array_append(reasons, 'data_class_not_allowed');
    END IF;

    SELECT COALESCE(sum(size), 0) INTO allocated
    FROM objects.storage_allocations
    WHERE pool_id = candidate.pool_id;
    SELECT COALESCE(sum(reservation.size), 0) INTO placement_reserved
    FROM objects.storage_placement_targets target
    JOIN objects.storage_placement_reservations reservation
      ON reservation.reservation_id = target.reservation_id
    WHERE target.pool_id = candidate.pool_id
      AND reservation.state = 'reserved'
      AND reservation.expires_at > clock_timestamp();
    SELECT COALESCE(sum(size), 0) INTO migration_reserved
    FROM objects.storage_migrations
    WHERE target_pool_id = candidate.pool_id AND state = 'copying';
    available_to_place := GREATEST(
        0,
        LEAST(
            COALESCE(candidate.available_bytes, 0),
            GREATEST(0, COALESCE(candidate.total_bytes, 0) - allocated)
        ) - candidate.safety_reserve_bytes - placement_reserved - migration_reserved
    );
    IF required_bytes > available_to_place THEN
        reasons := array_append(reasons, 'capacity_insufficient');
    END IF;
    RETURN reasons;
END;
$$;

CREATE FUNCTION objects.enforce_storage_pool_data_class_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_pool_id text := COALESCE(NEW.pool_id, OLD.pool_id);
    target_state text;
BEGIN
    SELECT lifecycle_state INTO target_state
    FROM objects.storage_pools
    WHERE pool_id = target_pool_id
    FOR UPDATE;
    IF target_state <> 'active' THEN
        RAISE EXCEPTION 'storage data classes can change only while the pool is active'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER storage_pool_data_class_change_boundary
BEFORE INSERT OR UPDATE OR DELETE ON objects.storage_pool_data_classes
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_pool_data_class_change();

CREATE FUNCTION objects.enforce_storage_placement_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    reservation objects.storage_placement_reservations%ROWTYPE;
    candidate objects.storage_pools%ROWTYPE;
    reasons text[];
BEGIN
    SELECT * INTO reservation
    FROM objects.storage_placement_reservations
    WHERE reservation_id = NEW.reservation_id
    FOR UPDATE;
    SELECT * INTO candidate
    FROM objects.storage_pools
    WHERE pool_id = NEW.pool_id
    FOR UPDATE;
    IF reservation.state <> 'reserved' OR reservation.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'storage placement reservation is not active'
            USING ERRCODE = 'check_violation';
    END IF;
    reasons := objects.storage_pool_ineligibility(
        NEW.pool_id, reservation.data_class, reservation.size
    );
    IF cardinality(reasons) <> 0 THEN
        RAISE EXCEPTION 'storage placement target is ineligible: %', array_to_string(reasons, ',')
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM objects.storage_placement_targets existing
        JOIN objects.storage_pools existing_pool ON existing_pool.pool_id = existing.pool_id
        WHERE existing.reservation_id = NEW.reservation_id
          AND existing_pool.failure_domain = candidate.failure_domain
    ) THEN
        RAISE EXCEPTION 'storage placement copies must use distinct failure domains'
            USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM objects.storage_placement_targets
        WHERE reservation_id = NEW.reservation_id) >= reservation.requested_copies THEN
        RAISE EXCEPTION 'storage placement has more targets than requested copies'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_placement_target_boundary
BEFORE INSERT ON objects.storage_placement_targets
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_placement_target();

CREATE FUNCTION objects.enforce_storage_reservation_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_count bigint;
    verified_count bigint;
BEGIN
    IF NEW.blob_key <> OLD.blob_key
       OR NEW.data_class <> OLD.data_class
       OR NEW.size <> OLD.size
       OR NEW.sha256 <> OLD.sha256
       OR NEW.requested_copies <> OLD.requested_copies
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable storage reservation identity cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state <> 'reserved' AND NEW.state <> OLD.state THEN
        RAISE EXCEPTION 'terminal storage reservation cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> OLD.state
       AND NEW.state NOT IN ('committed', 'aborted', 'expired') THEN
        RAISE EXCEPTION 'invalid storage reservation state transition'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'committed' AND OLD.state <> 'committed' THEN
        SELECT count(*) INTO target_count
        FROM objects.storage_placement_targets
        WHERE reservation_id = NEW.reservation_id;
        SELECT count(*) INTO verified_count
        FROM objects.storage_placement_targets target
        JOIN objects.storage_allocations allocation
          ON allocation.pool_id = target.pool_id
         AND allocation.blob_key = NEW.blob_key
         AND allocation.data_class = NEW.data_class
         AND allocation.size = NEW.size
         AND allocation.sha256 = NEW.sha256
        WHERE target.reservation_id = NEW.reservation_id;
        IF target_count <> NEW.requested_copies OR verified_count <> target_count THEN
            RAISE EXCEPTION 'storage reservation requires every requested target to be verified'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_reservation_transition_boundary
BEFORE UPDATE ON objects.storage_placement_reservations
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_reservation_transition();

CREATE FUNCTION objects.enforce_storage_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    encrypted objects.encrypted_blobs%ROWTYPE;
    reasons text[];
BEGIN
    SELECT * INTO encrypted
    FROM objects.encrypted_blobs
    WHERE blob_key = NEW.blob_key;
    IF encrypted.blob_key IS NULL
       OR encrypted.plaintext_size <> NEW.size
       OR encrypted.plaintext_sha256 <> NEW.sha256 THEN
        RAISE EXCEPTION 'storage allocation requires matching envelope-encrypted blob metadata'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM objects.storage_placement_targets target
        JOIN objects.storage_placement_reservations reservation
          ON reservation.reservation_id = target.reservation_id
        WHERE target.pool_id = NEW.pool_id
          AND reservation.blob_key = NEW.blob_key
          AND reservation.data_class = NEW.data_class
          AND reservation.size = NEW.size
          AND reservation.sha256 = NEW.sha256
          AND reservation.state = 'reserved'
          AND reservation.expires_at > clock_timestamp()
    ) AND NOT EXISTS (
        SELECT 1
        FROM objects.storage_migrations migration
        WHERE migration.target_pool_id = NEW.pool_id
          AND migration.blob_key = NEW.blob_key
          AND migration.data_class = NEW.data_class
          AND migration.size = NEW.size
          AND migration.sha256 = NEW.sha256
          AND migration.state = 'copying'
    ) THEN
        RAISE EXCEPTION 'storage allocation requires an active placement or migration reservation'
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM objects.storage_pools WHERE pool_id = NEW.pool_id FOR UPDATE;
    reasons := objects.storage_pool_ineligibility(NEW.pool_id, NEW.data_class, 0);
    IF cardinality(reasons) <> 0 THEN
        RAISE EXCEPTION 'storage allocation pool is ineligible: %', array_to_string(reasons, ',')
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_allocation_boundary
BEFORE INSERT ON objects.storage_allocations
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_allocation();

CREATE FUNCTION objects.enforce_storage_migration_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_allocation objects.storage_allocations%ROWTYPE;
    target_allocation objects.storage_allocations%ROWTYPE;
    reasons text[];
BEGIN
    SELECT * INTO source_allocation
    FROM objects.storage_allocations
    WHERE blob_key = NEW.blob_key AND pool_id = NEW.source_pool_id
    FOR UPDATE;
    IF source_allocation.allocation_id IS NULL
       OR source_allocation.data_class <> NEW.data_class
       OR source_allocation.size <> NEW.size
       OR source_allocation.sha256 <> NEW.sha256 THEN
        RAISE EXCEPTION 'storage migration source allocation does not match'
            USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1 FROM objects.storage_pools WHERE pool_id = NEW.target_pool_id FOR UPDATE;
    IF NEW.state = 'copying' THEN
        reasons := objects.storage_pool_ineligibility(
            NEW.target_pool_id, NEW.data_class, NEW.size
        );
    ELSE
        SELECT * INTO target_allocation
        FROM objects.storage_allocations
        WHERE blob_key = NEW.blob_key AND pool_id = NEW.target_pool_id;
        reasons := objects.storage_pool_ineligibility(NEW.target_pool_id, NEW.data_class, 0);
        IF NEW.state <> 'verifying'
           OR target_allocation.allocation_id IS NULL
           OR target_allocation.size <> NEW.size
           OR target_allocation.sha256 <> NEW.sha256 THEN
            RAISE EXCEPTION 'existing migration target is not a matching verified allocation'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF cardinality(reasons) <> 0 THEN
        RAISE EXCEPTION 'storage migration target is ineligible: %', array_to_string(reasons, ',')
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_migration_insert_boundary
BEFORE INSERT ON objects.storage_migrations
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_migration_insert();

CREATE FUNCTION objects.enforce_storage_migration_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_allocation objects.storage_allocations%ROWTYPE;
BEGIN
    IF NEW.blob_key <> OLD.blob_key
       OR NEW.data_class <> OLD.data_class
       OR NEW.size <> OLD.size
       OR NEW.sha256 <> OLD.sha256
       OR NEW.source_pool_id <> OLD.source_pool_id
       OR NEW.target_pool_id <> OLD.target_pool_id
       OR NEW.reused_existing_copy <> OLD.reused_existing_copy
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable storage migration identity cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state IN ('completed', 'superseded') THEN
        RAISE EXCEPTION 'terminal storage migration cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
        (OLD.state IN ('copying', 'verifying') AND NEW.state IN ('cleanup_pending', 'failed'))
        OR (OLD.state = 'cleanup_pending' AND NEW.state IN ('completed', 'failed'))
        OR (OLD.state = 'failed' AND NEW.state = 'superseded')
    ) THEN
        RAISE EXCEPTION 'invalid storage migration state transition'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state IN ('cleanup_pending', 'completed') THEN
        SELECT * INTO target_allocation
        FROM objects.storage_allocations
        WHERE blob_key = NEW.blob_key AND pool_id = NEW.target_pool_id;
        IF target_allocation.allocation_id IS NULL
           OR target_allocation.size <> NEW.size
           OR target_allocation.sha256 <> NEW.sha256 THEN
            RAISE EXCEPTION 'verified migration target allocation is missing'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.state = 'completed' AND EXISTS (
        SELECT 1 FROM objects.storage_allocations
        WHERE blob_key = NEW.blob_key AND pool_id = NEW.source_pool_id
    ) THEN
        RAISE EXCEPTION 'storage migration cannot complete before source cleanup'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_migration_transition_boundary
BEFORE UPDATE ON objects.storage_migrations
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_migration_transition();

CREATE FUNCTION objects.enforce_storage_pool_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    allocation_count bigint;
    reservation_count bigint;
    incomplete_migration_count bigint;
BEGIN
    IF NEW.pool_id <> OLD.pool_id
       OR NEW.backend_kind <> OLD.backend_kind
       OR NEW.node_id IS DISTINCT FROM OLD.node_id
       OR NEW.failure_domain <> OLD.failure_domain
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable storage pool identity cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.lifecycle_state = 'removed' THEN
        RAISE EXCEPTION 'removed storage pool cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lifecycle_state <> OLD.lifecycle_state AND NOT (
        (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'draining')
        OR (OLD.lifecycle_state = 'draining' AND NEW.lifecycle_state = 'drained')
        OR (OLD.lifecycle_state = 'drained' AND NEW.lifecycle_state = 'removed')
    ) THEN
        RAISE EXCEPTION 'invalid storage pool lifecycle transition'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lifecycle_state IN ('drained', 'removed')
       AND NEW.lifecycle_state <> OLD.lifecycle_state THEN
        SELECT count(*) INTO allocation_count
        FROM objects.storage_allocations WHERE pool_id = NEW.pool_id;
        SELECT count(*) INTO reservation_count
        FROM objects.storage_placement_targets target
        JOIN objects.storage_placement_reservations reservation
          ON reservation.reservation_id = target.reservation_id
        WHERE target.pool_id = NEW.pool_id
          AND reservation.state = 'reserved'
          AND reservation.expires_at > clock_timestamp();
        SELECT count(*) INTO incomplete_migration_count
        FROM objects.storage_migrations
        WHERE (source_pool_id = NEW.pool_id OR target_pool_id = NEW.pool_id)
          AND state IN ('copying', 'verifying', 'cleanup_pending', 'failed');
        IF allocation_count <> 0 OR reservation_count <> 0
           OR incomplete_migration_count <> 0 THEN
            RAISE EXCEPTION 'storage pool has live allocation, reservation, or migration blockers'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_pool_lifecycle_boundary
BEFORE UPDATE ON objects.storage_pools
FOR EACH ROW EXECUTE FUNCTION objects.enforce_storage_pool_lifecycle();
