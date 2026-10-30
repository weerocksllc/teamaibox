CREATE TABLE compute.model_profile_certification_baselines (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    lifecycle_revision bigint NOT NULL CHECK (lifecycle_revision > 0),
    validation_run_id uuid NOT NULL REFERENCES compute.model_validation_runs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    facts jsonb NOT NULL CHECK (
        jsonb_typeof(facts) = 'object'
        AND facts ?& ARRAY[
            'modelArtifactDigest', 'quantizationRecipeDigest', 'engineDigest',
            'containerImageDigest', 'driverVersion', 'osRelease', 'kernelVersion',
            'cudaInterfaceVersion', 'containerToolkitVersion', 'hardwareDigest',
            'configurationDigest', 'testCorpusDigest'
        ]
    ),
    facts_digest bytea NOT NULL CHECK (octet_length(facts_digest) = 32),
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    recorded_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (model_profile_id, lifecycle_revision),
    UNIQUE (model_profile_id, facts_digest)
);

CREATE TABLE compute.model_profile_revalidation_checks (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    model_profile_id uuid NOT NULL REFERENCES compute.model_profiles(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    baseline_id uuid NOT NULL REFERENCES compute.model_profile_certification_baselines(id) ON DELETE RESTRICT,
    observed_facts jsonb NOT NULL CHECK (jsonb_typeof(observed_facts) = 'object'),
    observed_facts_digest bytea NOT NULL CHECK (octet_length(observed_facts_digest) = 32),
    changed_dimensions jsonb NOT NULL CHECK (jsonb_typeof(changed_dimensions) = 'array'),
    outcome text NOT NULL CHECK (outcome IN ('current', 'revalidation_required')),
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    worker_id text NOT NULL CHECK (worker_id ~ '^[a-z][a-z0-9._-]{2,191}$'),
    checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX model_profile_revalidation_checks_profile_time_idx
ON compute.model_profile_revalidation_checks (model_profile_id, checked_at DESC);

CREATE FUNCTION compute.reject_model_certification_baseline_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'immutable model certification baseline cannot be changed'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER model_profile_certification_baselines_immutable
BEFORE UPDATE OR DELETE ON compute.model_profile_certification_baselines
FOR EACH ROW EXECUTE FUNCTION compute.reject_model_certification_baseline_mutation();

CREATE TRIGGER model_profile_revalidation_checks_immutable
BEFORE UPDATE OR DELETE ON compute.model_profile_revalidation_checks
FOR EACH ROW EXECUTE FUNCTION compute.reject_model_certification_baseline_mutation();
