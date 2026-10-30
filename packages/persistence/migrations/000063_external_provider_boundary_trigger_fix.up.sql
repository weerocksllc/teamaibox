CREATE OR REPLACE FUNCTION compute.enforce_external_attempt_create()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    attempt_job uuid;
    attempt_provider uuid;
    attempt_acceptance text;
    job_owner uuid;
    stored_provider_kind text;
BEGIN
    SELECT attempt.job_id,attempt.provider_id,attempt.acceptance_state,job.owner_identity_id
      INTO attempt_job,attempt_provider,attempt_acceptance,job_owner
    FROM compute.attempts attempt JOIN compute.jobs job ON job.id=attempt.job_id
    WHERE attempt.id=NEW.attempt_id;
    SELECT provider.provider_kind INTO stored_provider_kind
    FROM compute.providers provider WHERE provider.id=NEW.provider_id;
    IF attempt_job IS NULL OR attempt_job<>NEW.job_id OR attempt_provider<>NEW.provider_id
       OR attempt_acceptance<>'not_accepted' OR job_owner<>NEW.owner_identity_id
       OR stored_provider_kind<>'external_openai' THEN
        RAISE EXCEPTION 'external attempt does not match its durable job and provider boundary' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION compute.enforce_external_object_grant_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt_job uuid;
    attempt_provider uuid;
    job_owner uuid;
    stored_provider_kind text;
    reference_issuer uuid;
    reference_audience text;
    reference_digest bytea;
BEGIN
    SELECT attempt.job_id, attempt.provider_id, job.owner_identity_id
      INTO attempt_job, attempt_provider, job_owner
    FROM compute.attempts attempt
    JOIN compute.jobs job ON job.id=attempt.job_id
    WHERE attempt.id=NEW.attempt_id;
    SELECT provider.provider_kind INTO stored_provider_kind
    FROM compute.providers provider WHERE provider.id=NEW.provider_id;
    IF attempt_job IS NULL OR attempt_job<>NEW.job_id OR attempt_provider<>NEW.provider_id
       OR job_owner<>NEW.owner_identity_id OR stored_provider_kind<>'external_openai'
       OR NEW.audience<>format('external-provider:%s:%s',NEW.provider_id,NEW.attempt_id) THEN
        RAISE EXCEPTION 'external object grant is outside its job attempt boundary'
            USING ERRCODE='23514';
    END IF;
    IF NEW.direction='input' THEN
        SELECT issued_by_identity_id,audience,integrity_sha256
          INTO reference_issuer,reference_audience,reference_digest
        FROM objects.access_grants WHERE reference_id=NEW.reference_id;
        IF reference_issuer IS NULL OR reference_issuer<>NEW.owner_identity_id
           OR reference_audience<>NEW.audience OR reference_digest<>NEW.expected_sha256 THEN
            RAISE EXCEPTION 'external input grant does not match its scoped object reference'
                USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
