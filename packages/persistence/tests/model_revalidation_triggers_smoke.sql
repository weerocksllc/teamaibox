\set ON_ERROR_STOP on
BEGIN;

DO $smoke$
DECLARE
    smoke_profile uuid := '00000000-0000-4000-8000-000000002501';
    smoke_run uuid := '00000000-0000-4000-8000-000000002502';
    smoke_baseline uuid;
BEGIN
    INSERT INTO compute.model_profile_certification_baselines (
        model_profile_id, lifecycle_revision, validation_run_id, facts,
        facts_digest, evidence_refs
    ) VALUES (
        smoke_profile, 1, smoke_run,
        '{"modelArtifactDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","quantizationRecipeDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","engineDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","containerImageDigest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","driverVersion":"580.95.05","osRelease":"ubuntu-24.04","kernelVersion":"6.17.0","cudaInterfaceVersion":"13.0","containerToolkitVersion":"1.17.8","hardwareDigest":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","configurationDigest":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","testCorpusDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}',
        decode(repeat('12', 32), 'hex'), '["evidence://certification/baseline"]'
    ) RETURNING id INTO smoke_baseline;

    INSERT INTO compute.model_profile_revalidation_checks (
        model_profile_id, baseline_id, observed_facts, observed_facts_digest,
        changed_dimensions, outcome, evidence_refs, worker_id
    ) VALUES (
        smoke_profile, smoke_baseline, '{"driverVersion":"581.1"}',
        decode(repeat('13', 32), 'hex'), '["driverVersion"]',
        'revalidation_required', '["evidence://inventory/driver-change"]',
        'worker.revalidation.smoke'
    );

    IF (SELECT count(*) FROM compute.model_profile_revalidation_checks WHERE baseline_id = smoke_baseline) <> 1 THEN
        RAISE EXCEPTION 'model revalidation check was not persisted';
    END IF;
END
$smoke$;

ROLLBACK;
