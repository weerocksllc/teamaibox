ALTER TABLE compute.providers
    ADD COLUMN display_name text,
    ADD COLUMN auth_scheme text NOT NULL DEFAULT 'none' CHECK (auth_scheme IN ('none','bearer','api_key_header')),
    ADD COLUMN auth_header_name text CHECK (auth_header_name IS NULL OR auth_header_name ~ '^[A-Za-z][A-Za-z0-9-]{0,63}$'),
    ADD COLUMN ca_secret_ref text,
    ADD COLUMN trust_policy jsonb NOT NULL DEFAULT '{"mode":"system_ca","serverName":null}'::jsonb CHECK (jsonb_typeof(trust_policy)='object'),
    ADD COLUMN allowed_data_classes jsonb NOT NULL DEFAULT '["public"]'::jsonb CHECK (
        jsonb_typeof(allowed_data_classes)='array'
        AND jsonb_array_length(allowed_data_classes) BETWEEN 1 AND 4
        AND allowed_data_classes <@ '["public","internal","confidential","restricted"]'::jsonb
    ),
    ADD COLUMN concurrency_limit integer NOT NULL DEFAULT 1 CHECK (concurrency_limit BETWEEN 1 AND 4096),
    ADD COLUMN rate_limits jsonb NOT NULL DEFAULT '{"requestsPerMinute":60,"tokensPerMinute":null}'::jsonb CHECK (jsonb_typeof(rate_limits)='object'),
    ADD COLUMN timeout_policy jsonb NOT NULL DEFAULT '{"connectMilliseconds":5000,"requestMilliseconds":120000,"idleStreamMilliseconds":30000}'::jsonb CHECK (jsonb_typeof(timeout_policy)='object'),
    ADD COLUMN health_check jsonb NOT NULL DEFAULT '{"path":"/models","intervalSeconds":30,"timeoutMilliseconds":5000,"failureThreshold":3}'::jsonb CHECK (jsonb_typeof(health_check)='object'),
    ADD COLUMN health jsonb NOT NULL DEFAULT '{"state":"unknown","latencyMilliseconds":null,"errorCode":null,"observedAt":null,"consecutiveFailures":0}'::jsonb CHECK (jsonb_typeof(health)='object'),
    ADD COLUMN cost_accounting jsonb NOT NULL DEFAULT '{"currency":"USD","inputMicrounitsPerMillionTokens":0,"outputMicrounitsPerMillionTokens":0,"imageMicrounitsPerRequest":0,"audioMicrounitsPerMinute":0,"accountingMode":"unpriced"}'::jsonb CHECK (jsonb_typeof(cost_accounting)='object'),
    ADD COLUMN contract_state text NOT NULL DEFAULT 'untested' CHECK (contract_state IN ('untested','passed','failed','stale')),
    ADD COLUMN contract_evidence_digest bytea CHECK (contract_evidence_digest IS NULL OR octet_length(contract_evidence_digest)=32),
    ADD COLUMN contract_tested_at timestamptz,
    ADD COLUMN contract_failed_checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contract_failed_checks)='array'),
    ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN created_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL;

UPDATE compute.providers SET display_name = provider_key;

ALTER TABLE compute.providers
    ALTER COLUMN display_name SET NOT NULL,
    ALTER COLUMN display_name SET DEFAULT 'Provider',
    ADD CONSTRAINT providers_display_name_check CHECK (length(display_name) BETWEEN 1 AND 128),
    ADD CONSTRAINT providers_external_https_check CHECK (
        provider_kind <> 'external_openai'
        OR endpoint_uri ~ '^https://[^/?#[:space:]]+(?::[0-9]{1,5})?(?:/[^?#[:space:]]*)?$'
    ),
    ADD CONSTRAINT providers_auth_secret_pair CHECK (
        (auth_scheme='none' AND secret_ref IS NULL AND auth_header_name IS NULL)
        OR (auth_scheme='bearer' AND secret_ref ~ '^provider\.[0-9a-f-]{36}\.auth$' AND auth_header_name='Authorization')
        OR (auth_scheme='api_key_header' AND secret_ref ~ '^provider\.[0-9a-f-]{36}\.auth$' AND auth_header_name IS NOT NULL)
    ),
    ADD CONSTRAINT providers_trust_secret_pair CHECK (
        (trust_policy->>'mode'='system_ca' AND ca_secret_ref IS NULL)
        OR (trust_policy->>'mode'='custom_ca' AND ca_secret_ref ~ '^provider\.[0-9a-f-]{36}\.ca$')
    ),
    ADD CONSTRAINT providers_contract_evidence_pair CHECK (
        (contract_state='untested' AND contract_evidence_digest IS NULL AND contract_tested_at IS NULL)
        OR (contract_state IN ('passed','failed','stale') AND contract_evidence_digest IS NOT NULL AND contract_tested_at IS NOT NULL)
    );

ALTER TABLE compute.provider_model_profiles
    ADD COLUMN operations jsonb NOT NULL DEFAULT '["responses"]'::jsonb CHECK (jsonb_typeof(operations)='array' AND jsonb_array_length(operations)>0),
    ADD COLUMN context_window integer NOT NULL DEFAULT 1 CHECK (context_window BETWEEN 1 AND 100000000),
    ADD COLUMN maximum_output_tokens integer CHECK (maximum_output_tokens BETWEEN 1 AND 10000000),
    ADD COLUMN contract_state text NOT NULL DEFAULT 'untested' CHECK (contract_state IN ('untested','passed','failed','stale'));

CREATE TABLE compute.provider_health_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id uuid NOT NULL REFERENCES compute.providers(id) ON DELETE CASCADE,
    provider_revision bigint NOT NULL CHECK (provider_revision > 0),
    state text NOT NULL CHECK (state IN ('healthy','degraded','unavailable')),
    latency_milliseconds integer CHECK (latency_milliseconds IS NULL OR latency_milliseconds >= 0),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_:.-]{1,191}$'),
    observed_at timestamptz NOT NULL
);

CREATE INDEX provider_health_events_provider_time_idx
ON compute.provider_health_events (provider_id, observed_at DESC, id DESC);

CREATE TABLE compute.provider_contract_test_runs (
    id uuid PRIMARY KEY,
    provider_id uuid NOT NULL REFERENCES compute.providers(id) ON DELETE RESTRICT,
    provider_revision bigint NOT NULL CHECK (provider_revision > 0),
    status text NOT NULL CHECK (status IN ('passed','failed')),
    evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest)=32),
    failed_checks jsonb NOT NULL CHECK (jsonb_typeof(failed_checks)='array'),
    observed_at timestamptz NOT NULL,
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    UNIQUE (provider_id, provider_revision, evidence_digest)
);

CREATE INDEX provider_contract_test_runs_provider_time_idx
ON compute.provider_contract_test_runs (provider_id, observed_at DESC);

CREATE FUNCTION compute.reject_provider_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'provider health and contract evidence is append-only' USING ERRCODE='23514';
END
$$;

CREATE TRIGGER provider_health_events_append_only
BEFORE UPDATE OR DELETE ON compute.provider_health_events
FOR EACH ROW EXECUTE FUNCTION compute.reject_provider_evidence_mutation();

CREATE TRIGGER provider_contract_test_runs_append_only
BEFORE UPDATE OR DELETE ON compute.provider_contract_test_runs
FOR EACH ROW EXECUTE FUNCTION compute.reject_provider_evidence_mutation();
