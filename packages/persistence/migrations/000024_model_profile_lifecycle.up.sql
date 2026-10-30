ALTER TABLE compute.model_profiles
DROP CONSTRAINT model_profiles_certification_state_check;

UPDATE compute.model_profiles
SET certification_state = CASE
    WHEN certification_state = 'certified' THEN 'certified'
    WHEN certification_state = 'rejected' THEN 'failed'
    WHEN certification_state = 'retired' THEN 'deprecated'
    ELSE 'validating'
END;

ALTER TABLE compute.model_profiles
    ALTER COLUMN certification_state SET DEFAULT 'experimental',
    ADD CONSTRAINT model_profiles_certification_state_check CHECK (
        certification_state IN (
            'experimental', 'validating', 'certified', 'deprecated',
            'failed', 'revalidation_required'
        )
    ),
    ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0),
    ADD COLUMN lifecycle_reason_key text NOT NULL DEFAULT 'model.lifecycle.migrated' CHECK (
        lifecycle_reason_key ~ '^[a-z][a-z0-9_.-]{2,127}$'
    ),
    ADD COLUMN lifecycle_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
        jsonb_typeof(lifecycle_evidence_refs) = 'array'
    ),
    ADD COLUMN lifecycle_validation_run_id uuid REFERENCES compute.model_validation_runs(id) ON DELETE RESTRICT,
    ADD COLUMN lifecycle_updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE compute.model_profile_lifecycle_events (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT,
    profile_revision bigint NOT NULL CHECK (profile_revision > 0),
    from_state text CHECK (
        from_state IS NULL OR from_state IN (
            'experimental', 'validating', 'certified', 'deprecated',
            'failed', 'revalidation_required'
        )
    ),
    to_state text NOT NULL CHECK (
        to_state IN (
            'experimental', 'validating', 'certified', 'deprecated',
            'failed', 'revalidation_required'
        )
    ),
    reason_key text NOT NULL CHECK (reason_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    validation_run_id uuid REFERENCES compute.model_validation_runs(id) ON DELETE RESTRICT,
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (model_profile_id, profile_revision)
);

INSERT INTO compute.model_profile_lifecycle_events (
    model_profile_id, profile_revision, from_state, to_state, reason_key,
    evidence_refs, validation_run_id, actor_identity_id, occurred_at
)
SELECT id, lifecycle_revision, NULL, certification_state, lifecycle_reason_key,
       lifecycle_evidence_refs, lifecycle_validation_run_id, created_by,
       lifecycle_updated_at
FROM compute.model_profiles;

CREATE INDEX model_profile_lifecycle_events_profile_time_idx
ON compute.model_profile_lifecycle_events (model_profile_id, occurred_at DESC);

CREATE TABLE compute.model_experimental_routing_opt_ins (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    environment text NOT NULL CHECK (environment IN ('development', 'validation')),
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE CASCADE,
    enabled boolean NOT NULL,
    reason_key text NOT NULL CHECK (reason_key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    expires_at timestamptz NOT NULL,
    set_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (policy_key, environment, model_profile_id),
    CHECK (expires_at > created_at)
);

CREATE INDEX model_experimental_routing_opt_ins_active_idx
ON compute.model_experimental_routing_opt_ins (policy_key, environment, expires_at)
WHERE enabled;

CREATE TRIGGER model_experimental_routing_opt_ins_touch_updated_at
BEFORE UPDATE ON compute.model_experimental_routing_opt_ins
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
