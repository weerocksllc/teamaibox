CREATE TABLE compute.external_attempt_accounting (
    attempt_id uuid PRIMARY KEY REFERENCES compute.external_attempt_dispatches(attempt_id) ON DELETE RESTRICT,
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE RESTRICT,
    provider_id uuid NOT NULL REFERENCES compute.providers(id) ON DELETE RESTRICT,
    usage jsonb NOT NULL CHECK (
        jsonb_typeof(usage)='object'
        AND usage ?& ARRAY['inputTokens','outputTokens','imageRequests','audioMilliseconds','source']
        AND (usage->>'inputTokens')::bigint>=0 AND (usage->>'outputTokens')::bigint>=0
        AND (usage->>'imageRequests')::bigint>=0 AND (usage->>'audioMilliseconds')::bigint>=0
        AND usage->>'source' IN ('provider_reported','platform_observed')
    ),
    accounting_mode text NOT NULL CHECK (accounting_mode IN ('provider_reported','platform_estimated','unpriced')),
    rates jsonb NOT NULL CHECK (
        jsonb_typeof(rates)='object'
        AND rates ?& ARRAY['inputMicrounitsPerMillionTokens','outputMicrounitsPerMillionTokens','imageMicrounitsPerRequest','audioMicrounitsPerMinute']
        AND (rates->>'inputMicrounitsPerMillionTokens')::bigint>=0
        AND (rates->>'outputMicrounitsPerMillionTokens')::bigint>=0
        AND (rates->>'imageMicrounitsPerRequest')::bigint>=0
        AND (rates->>'audioMicrounitsPerMinute')::bigint>=0
    ),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    total_microunits bigint CHECK (total_microunits IS NULL OR total_microunits>=0),
    observed_at timestamptz NOT NULL,
    CHECK ((accounting_mode='unpriced')=(total_microunits IS NULL)),
    CHECK (accounting_mode<>'provider_reported' OR usage->>'source'='provider_reported')
);

CREATE INDEX external_attempt_accounting_provider_time_idx
ON compute.external_attempt_accounting(provider_id,observed_at DESC);

CREATE FUNCTION compute.enforce_external_attempt_accounting_boundary()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    attempt_job uuid;
    attempt_provider uuid;
BEGIN
    SELECT job_id,provider_id INTO attempt_job,attempt_provider
    FROM compute.external_attempt_dispatches WHERE attempt_id=NEW.attempt_id;
    IF attempt_job IS NULL OR attempt_job<>NEW.job_id OR attempt_provider<>NEW.provider_id THEN
        RAISE EXCEPTION 'external accounting does not match its durable attempt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER external_attempt_accounting_boundary
BEFORE INSERT ON compute.external_attempt_accounting
FOR EACH ROW EXECUTE FUNCTION compute.enforce_external_attempt_accounting_boundary();

CREATE FUNCTION compute.reject_external_attempt_accounting_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'external attempt accounting is immutable' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER external_attempt_accounting_immutable
BEFORE UPDATE OR DELETE ON compute.external_attempt_accounting
FOR EACH ROW EXECUTE FUNCTION compute.reject_external_attempt_accounting_mutation();
