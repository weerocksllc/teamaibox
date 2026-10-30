DROP TRIGGER IF EXISTS model_experimental_routing_opt_ins_touch_updated_at
ON compute.model_experimental_routing_opt_ins;
DROP TABLE IF EXISTS compute.model_experimental_routing_opt_ins;
DROP TABLE IF EXISTS compute.model_profile_lifecycle_events;

ALTER TABLE compute.model_profiles
DROP CONSTRAINT model_profiles_certification_state_check;

UPDATE compute.model_profiles
SET certification_state = CASE
    WHEN certification_state = 'certified' THEN 'certified'
    WHEN certification_state = 'failed' THEN 'rejected'
    WHEN certification_state = 'deprecated' THEN 'retired'
    ELSE 'discovery'
END;

ALTER TABLE compute.model_profiles
    DROP COLUMN lifecycle_updated_at,
    DROP COLUMN lifecycle_validation_run_id,
    DROP COLUMN lifecycle_evidence_refs,
    DROP COLUMN lifecycle_reason_key,
    DROP COLUMN lifecycle_revision,
    ALTER COLUMN certification_state SET DEFAULT 'discovery',
    ADD CONSTRAINT model_profiles_certification_state_check CHECK (
        certification_state IN (
            'discovery', 'build', 'smoke', 'conformance', 'quality', 'benchmark',
            'stress_soak', 'coexistence_cluster', 'security', 'certified', 'rejected', 'retired'
        )
    );
