CREATE TABLE compute.node_groups (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    group_key text NOT NULL UNIQUE CHECK (
        group_key ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    role text NOT NULL CHECK (
        role IN ('appliance-core', 'extension-pool')
    ),
    max_managed_nodes integer NOT NULL CHECK (
        max_managed_nodes BETWEEN 0 AND 256
    ),
    enrollment_concurrency integer NOT NULL DEFAULT 1 CHECK (
        enrollment_concurrency BETWEEN 1 AND 16
    ),
    rollout_concurrency integer NOT NULL DEFAULT 1 CHECK (
        rollout_concurrency BETWEEN 1 AND 16
    ),
    desired_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
        jsonb_typeof(desired_state) = 'object'
    ),
    desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
    ),
    maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    lifecycle_state text NOT NULL DEFAULT 'active' CHECK (
        lifecycle_state IN ('active', 'maintenance', 'disabled')
    ),
    recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (observed_state_revision <= desired_state_revision),
    CHECK (
        (role = 'appliance-core' AND max_managed_nodes = 1)
        OR (role = 'extension-pool')
    ),
    CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    )
);

CREATE UNIQUE INDEX node_groups_one_appliance_core_idx
ON compute.node_groups (role)
WHERE role = 'appliance-core' AND lifecycle_state <> 'disabled';

CREATE TRIGGER node_groups_touch_updated_at
BEFORE UPDATE ON compute.node_groups
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE compute.node_group_memberships (
    node_group_id uuid NOT NULL
        REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    node_id uuid NOT NULL
        REFERENCES compute.nodes(id) ON DELETE RESTRICT,
    membership_state text NOT NULL DEFAULT 'joining' CHECK (
        membership_state IN (
            'joining', 'active', 'draining', 'degraded',
            'recovering', 'disabled', 'removed'
        )
    ),
    desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
    ),
    maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (node_group_id, node_id),
    UNIQUE (node_id),
    CHECK (observed_state_revision <= desired_state_revision),
    CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    )
);

CREATE INDEX node_group_memberships_group_state_idx
ON compute.node_group_memberships (node_group_id, membership_state, node_id);

CREATE TRIGGER node_group_memberships_touch_updated_at
BEFORE UPDATE ON compute.node_group_memberships
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

ALTER TABLE compute.nodes
    ADD COLUMN appliance_role text NOT NULL DEFAULT 'extension-pool' CHECK (
        appliance_role IN ('appliance-core', 'extension-pool')
    ),
    ADD COLUMN node_group_id uuid
        REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    ADD COLUMN desired_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
        jsonb_typeof(desired_state) = 'object'
    ),
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    ADD COLUMN recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    ADD CONSTRAINT nodes_state_revision_order CHECK (
        observed_state_revision <= desired_state_revision
    ),
    ADD CONSTRAINT nodes_recovery_reason_pair CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    );

CREATE INDEX nodes_group_role_state_idx
ON compute.nodes (node_group_id, appliance_role, lifecycle_state, recovery_state);

CREATE FUNCTION compute.enforce_node_group_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_role text;
    target_limit integer;
    target_lifecycle text;
    member_role text;
    member_group_id uuid;
    active_members integer;
BEGIN
    SELECT role, max_managed_nodes, lifecycle_state
    INTO target_role, target_limit, target_lifecycle
    FROM compute.node_groups
    WHERE id = NEW.node_group_id
    FOR UPDATE;

    IF target_role IS NULL OR target_lifecycle = 'disabled' THEN
        RAISE EXCEPTION 'node group is unavailable' USING ERRCODE = '23514';
    END IF;

    SELECT appliance_role, node_group_id
    INTO member_role, member_group_id
    FROM compute.nodes
    WHERE id = NEW.node_id
    FOR UPDATE;

    IF member_role IS DISTINCT FROM target_role
       OR member_group_id IS DISTINCT FROM NEW.node_group_id THEN
        RAISE EXCEPTION 'node role or group projection does not match membership'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.membership_state <> 'removed' THEN
        SELECT count(*)
        INTO active_members
        FROM compute.node_group_memberships
        WHERE node_group_id = NEW.node_group_id
          AND membership_state <> 'removed'
          AND node_id <> NEW.node_id;

        IF active_members >= target_limit THEN
            RAISE EXCEPTION 'node group maxManagedNodes envelope is exhausted'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER node_group_membership_envelope
BEFORE INSERT OR UPDATE ON compute.node_group_memberships
FOR EACH ROW EXECUTE FUNCTION compute.enforce_node_group_membership();

CREATE FUNCTION compute.enforce_node_group_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_members integer;
BEGIN
    SELECT count(*)
    INTO active_members
    FROM compute.node_group_memberships
    WHERE node_group_id = NEW.id
      AND membership_state <> 'removed';

    IF active_members > NEW.max_managed_nodes THEN
        RAISE EXCEPTION 'maxManagedNodes cannot be lower than active membership'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role AND active_members > 0 THEN
        RAISE EXCEPTION 'a populated node group cannot change appliance role'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER node_group_limit_guard
BEFORE UPDATE OF role, max_managed_nodes ON compute.node_groups
FOR EACH ROW EXECUTE FUNCTION compute.enforce_node_group_limit();

ALTER TABLE compute.model_profiles
    ADD COLUMN placement_class text NOT NULL DEFAULT 'warm-optional' CHECK (
        placement_class IN (
            'protected-resident', 'warm-optional', 'exclusive-batch'
        )
    ),
    ADD COLUMN placement_node_group_id uuid
        REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    ADD COLUMN recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    ADD CONSTRAINT model_profiles_state_revision_order CHECK (
        observed_state_revision <= desired_state_revision
    ),
    ADD CONSTRAINT model_profiles_recovery_reason_pair CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    );

CREATE INDEX model_profiles_placement_state_idx
ON compute.model_profiles (
    placement_class, placement_node_group_id, recovery_state, certification_state
);

CREATE TABLE compute.model_profile_placement_revisions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    model_profile_id uuid NOT NULL
        REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    node_group_id uuid NOT NULL
        REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    placement_revision bigint NOT NULL CHECK (placement_revision > 0),
    placement_class text NOT NULL CHECK (
        placement_class IN (
            'protected-resident', 'warm-optional', 'exclusive-batch'
        )
    ),
    desired_state_revision bigint NOT NULL CHECK (
        desired_state_revision > 0
    ),
    observed_state_revision bigint NOT NULL CHECK (
        observed_state_revision >= 0
    ),
    maintenance_generation bigint NOT NULL CHECK (
        maintenance_generation > 0
    ),
    placement_state text NOT NULL CHECK (
        placement_state IN (
            'desired', 'loading', 'ready', 'maintenance',
            'degraded', 'recovering', 'failed', 'disabled'
        )
    ),
    recovery_state text NOT NULL CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    configuration_digest bytea NOT NULL CHECK (
        octet_length(configuration_digest) = 32
    ),
    resource_envelope jsonb NOT NULL CHECK (
        jsonb_typeof(resource_envelope) = 'object'
    ),
    warm_probe jsonb NOT NULL CHECK (
        jsonb_typeof(warm_probe) = 'object'
    ),
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(evidence_refs) = 'array'
    ),
    previous_revision_id uuid
        REFERENCES compute.model_profile_placement_revisions(id) ON DELETE RESTRICT,
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (model_profile_id, placement_revision),
    CHECK (observed_state_revision <= desired_state_revision),
    CHECK (
        (placement_revision = 1 AND previous_revision_id IS NULL)
        OR (placement_revision > 1 AND previous_revision_id IS NOT NULL)
    ),
    CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    )
);

CREATE INDEX model_profile_placement_current_idx
ON compute.model_profile_placement_revisions (
    model_profile_id, placement_revision DESC, node_group_id
);

CREATE FUNCTION compute.reject_model_profile_placement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'model profile placement revisions are append-only'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER model_profile_placement_revisions_append_only
BEFORE UPDATE OR DELETE ON compute.model_profile_placement_revisions
FOR EACH ROW EXECUTE FUNCTION compute.reject_model_profile_placement_mutation();

CREATE FUNCTION compute.enforce_model_profile_placement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    group_role text;
    previous_profile_id uuid;
    previous_revision bigint;
BEGIN
    SELECT role INTO group_role
    FROM compute.node_groups
    WHERE id = NEW.node_group_id AND lifecycle_state <> 'disabled'
    FOR SHARE;

    IF group_role IS NULL THEN
        RAISE EXCEPTION 'model placement node group is unavailable'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.placement_class = 'protected-resident'
       AND group_role <> 'appliance-core' THEN
        RAISE EXCEPTION 'protected-resident placement requires appliance-core'
            USING ERRCODE = '23514';
    END IF;

    IF group_role = 'extension-pool'
       AND NEW.placement_class NOT IN ('warm-optional', 'exclusive-batch') THEN
        RAISE EXCEPTION 'extension-pool placement class is invalid'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.placement_revision = 1 THEN
        IF EXISTS (
            SELECT 1 FROM compute.model_profile_placement_revisions
            WHERE model_profile_id = NEW.model_profile_id
        ) THEN
            RAISE EXCEPTION 'model placement revision must advance monotonically'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT model_profile_id, placement_revision
        INTO previous_profile_id, previous_revision
        FROM compute.model_profile_placement_revisions
        WHERE id = NEW.previous_revision_id
        FOR SHARE;

        IF previous_profile_id IS NULL
           OR previous_profile_id <> NEW.model_profile_id
           OR previous_revision + 1 <> NEW.placement_revision THEN
            RAISE EXCEPTION 'model placement predecessor is invalid'
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1 FROM compute.model_profile_placement_revisions
            WHERE model_profile_id = NEW.model_profile_id
              AND placement_revision >= NEW.placement_revision
        ) THEN
            RAISE EXCEPTION 'model placement revision is stale'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER model_profile_placement_revision_guard
BEFORE INSERT ON compute.model_profile_placement_revisions
FOR EACH ROW EXECUTE FUNCTION compute.enforce_model_profile_placement();

ALTER TABLE compute.providers
    ADD COLUMN placement_class text CHECK (
        placement_class IS NULL OR placement_class IN (
            'protected-resident', 'warm-optional', 'exclusive-batch'
        )
    ),
    ADD COLUMN placement_node_group_id uuid
        REFERENCES compute.node_groups(id) ON DELETE RESTRICT,
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    ADD COLUMN recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    );

UPDATE compute.providers
SET placement_class = 'warm-optional'
WHERE provider_kind = 'managed_node' AND placement_class IS NULL;

CREATE FUNCTION compute.default_managed_provider_placement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Preserve compatibility with callers created before placement classes
    -- existed.  External providers intentionally keep NULL so an omitted value
    -- can never acquire local residency by accident.
    IF NEW.provider_kind = 'managed_node' AND NEW.placement_class IS NULL THEN
        NEW.placement_class := 'warm-optional';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER providers_default_managed_placement
BEFORE INSERT OR UPDATE OF provider_kind, placement_class
ON compute.providers
FOR EACH ROW EXECUTE FUNCTION compute.default_managed_provider_placement();

ALTER TABLE compute.providers
    ADD CONSTRAINT providers_placement_kind_check CHECK (
        (provider_kind = 'external_openai' AND placement_class IS NULL)
        OR (provider_kind = 'managed_node' AND placement_class IS NOT NULL)
    ),
    ADD CONSTRAINT providers_state_revision_order CHECK (
        observed_state_revision <= desired_state_revision
    ),
    ADD CONSTRAINT providers_recovery_reason_pair CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    );

CREATE INDEX providers_placement_state_idx
ON compute.providers (
    placement_class, placement_node_group_id, lifecycle_state, recovery_state
)
WHERE provider_kind = 'managed_node';

ALTER TABLE compute.worker_instances
    ADD COLUMN placement_class text NOT NULL DEFAULT 'warm-optional' CHECK (
        placement_class IN (
            'protected-resident', 'warm-optional', 'exclusive-batch'
        )
    ),
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN observed_state_revision bigint NOT NULL DEFAULT 0 CHECK (
        observed_state_revision >= 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN (
            'healthy', 'degraded', 'recovering', 'failed', 'manual-recovery'
        )
    ),
    ADD COLUMN recovery_reason_code text CHECK (
        recovery_reason_code IS NULL
        OR recovery_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
    ADD CONSTRAINT worker_instances_state_revision_order CHECK (
        observed_state_revision <= desired_state_revision
    ),
    ADD CONSTRAINT worker_instances_recovery_reason_pair CHECK (
        (recovery_state = 'healthy' AND recovery_reason_code IS NULL)
        OR (recovery_state <> 'healthy')
    );

CREATE INDEX worker_instances_placement_state_idx
ON compute.worker_instances (
    node_id, placement_class, lifecycle_state, recovery_state
);

ALTER TABLE compute.lease_sets
    ADD COLUMN placement_class text NOT NULL DEFAULT 'warm-optional' CHECK (
        placement_class IN (
            'protected-resident', 'warm-optional', 'exclusive-batch'
        )
    ),
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN ('healthy', 'degraded', 'recovering', 'failed')
    );

ALTER TABLE compute.node_exclusive_intents
    ADD COLUMN placement_class text NOT NULL DEFAULT 'exclusive-batch' CHECK (
        placement_class = 'exclusive-batch'
    ),
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN ('healthy', 'degraded', 'recovering', 'failed')
    );

ALTER TABLE compute.realtime_sessions
    ADD COLUMN placement_class text NOT NULL DEFAULT 'warm-optional' CHECK (
        placement_class IN ('protected-resident', 'warm-optional')
    ),
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN ('healthy', 'degraded', 'recovering', 'failed')
    );

ALTER TABLE compute.gang_lease_sets
    ADD COLUMN placement_class text NOT NULL DEFAULT 'exclusive-batch' CHECK (
        placement_class = 'exclusive-batch'
    ),
    ADD COLUMN desired_state_revision bigint NOT NULL DEFAULT 1 CHECK (
        desired_state_revision > 0
    ),
    ADD COLUMN maintenance_generation bigint NOT NULL DEFAULT 1 CHECK (
        maintenance_generation > 0
    ),
    ADD COLUMN recovery_state text NOT NULL DEFAULT 'healthy' CHECK (
        recovery_state IN ('healthy', 'degraded', 'recovering', 'failed')
    );

CREATE INDEX lease_sets_placement_state_idx
ON compute.lease_sets (node_id, placement_class, state, recovery_state);

CREATE INDEX realtime_sessions_placement_state_idx
ON compute.realtime_sessions (node_id, placement_class, state, recovery_state);

CREATE INDEX gang_lease_sets_placement_state_idx
ON compute.gang_lease_sets (placement_class, state, recovery_state);
