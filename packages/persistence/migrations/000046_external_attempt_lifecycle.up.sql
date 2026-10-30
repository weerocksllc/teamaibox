CREATE SEQUENCE compute.external_dispatch_fence_sequence AS bigint START WITH 1;

CREATE FUNCTION compute.valid_external_replay_contract(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value)='object'
       AND value ?& ARRAY['idempotencyMode','replayAfterAcceptance','reconcileMode','cancellationMode','sideEffectClass']
       AND value->>'idempotencyMode' IN ('none','provider_key')
       AND value->>'replayAfterAcceptance' IN ('prohibited','same_provider','any_provider')
       AND value->>'reconcileMode' IN ('none','status')
       AND value->>'cancellationMode' IN ('none','request')
       AND value->>'sideEffectClass' IN ('none','idempotent','non_idempotent')
       AND (value->>'replayAfterAcceptance'<>'same_provider' OR value->>'idempotencyMode'='provider_key')
       AND (value->>'replayAfterAcceptance'<>'any_provider' OR value->>'sideEffectClass'='none')
       AND (value->>'sideEffectClass'<>'non_idempotent' OR value->>'replayAfterAcceptance'='prohibited');
$$;

CREATE FUNCTION compute.valid_external_provider_execution_contract(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT compute.valid_external_replay_contract(value)
       AND value ?& ARRAY['idempotencyHeader','statusPathTemplate','cancelPathTemplate','cancelMethod']
       AND (
           (value->>'idempotencyMode'='none' AND value->>'idempotencyHeader' IS NULL)
           OR (value->>'idempotencyMode'='provider_key' AND value->>'idempotencyHeader' ~ '^[A-Za-z][A-Za-z0-9-]{0,63}$')
       )
       AND (
           (value->>'reconcileMode'='none' AND value->>'statusPathTemplate' IS NULL)
           OR (value->>'reconcileMode'='status'
               AND value->>'statusPathTemplate' ~ '^/[A-Za-z0-9._~!$&()*+,;=:@%/{}/-]{1,255}$'
               AND position('..' IN value->>'statusPathTemplate')=0
               AND length(value->>'statusPathTemplate')-length(replace(value->>'statusPathTemplate','{request_id}',''))=12)
       )
       AND (
           (value->>'cancellationMode'='none' AND value->>'cancelPathTemplate' IS NULL AND value->>'cancelMethod' IS NULL)
           OR (value->>'cancellationMode'='request'
               AND value->>'cancelPathTemplate' ~ '^/[A-Za-z0-9._~!$&()*+,;=:@%/{}/-]{1,255}$'
               AND position('..' IN value->>'cancelPathTemplate')=0
               AND length(value->>'cancelPathTemplate')-length(replace(value->>'cancelPathTemplate','{request_id}',''))=12
               AND value->>'cancelMethod' IN ('POST','DELETE'))
       );
$$;

ALTER TABLE compute.providers
ADD COLUMN execution_contract jsonb NOT NULL DEFAULT '{
  "idempotencyMode":"none",
  "replayAfterAcceptance":"prohibited",
  "reconcileMode":"none",
  "cancellationMode":"none",
  "sideEffectClass":"none",
  "idempotencyHeader":null,
  "statusPathTemplate":null,
  "cancelPathTemplate":null,
  "cancelMethod":null
}'::jsonb CHECK (compute.valid_external_provider_execution_contract(execution_contract));

CREATE TABLE compute.external_attempt_dispatches (
    attempt_id uuid PRIMARY KEY REFERENCES compute.attempts(id) ON DELETE CASCADE,
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE RESTRICT,
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    provider_id uuid NOT NULL REFERENCES compute.providers(id) ON DELETE RESTRICT,
    provider_model text NOT NULL CHECK (length(provider_model) BETWEEN 1 AND 512),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
    provider_idempotency_key text CHECK (provider_idempotency_key IS NULL OR provider_idempotency_key ~ '^taib:[0-9a-f-]{36}:[0-9a-f-]{36}$'),
    replay_contract jsonb NOT NULL CHECK (compute.valid_external_replay_contract(replay_contract)),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN (
        'dispatching','accepted','streaming','reconcile_required','succeeded','failed','incomplete','cancelled'
    )),
    acceptance_state text NOT NULL CHECK (acceptance_state IN (
        'not_accepted','accepted_no_output','output_observed','side_effect_uncertain'
    )),
    provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 256),
    cancellation_state text NOT NULL DEFAULT 'none' CHECK (cancellation_state IN ('none','requested','confirmed','unsupported','uncertain')),
    cancellation_outcome text CHECK (cancellation_outcome IS NULL OR length(cancellation_outcome) BETWEEN 1 AND 128),
    cancel_requested_at timestamptz,
    last_output_sequence bigint NOT NULL DEFAULT 0 CHECK (last_output_sequence>=0),
    observed_output_bytes bigint NOT NULL DEFAULT 0 CHECK (observed_output_bytes>=0),
    output_chain_digest bytea CHECK (output_chain_digest IS NULL OR octet_length(output_chain_digest)=32),
    result_object_id uuid,
    result_object_version integer,
    result_sha256 bytea CHECK (result_sha256 IS NULL OR octet_length(result_sha256)=32),
    result_size_bytes bigint CHECK (result_size_bytes IS NULL OR result_size_bytes>0),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_:.-]{1,191}$'),
    retry_action text CHECK (retry_action IS NULL OR retry_action IN ('none','failover','retry_same_provider','reconcile','manual_reconcile','terminal')),
    retry_classification text CHECK (retry_classification IS NULL OR retry_classification IN ('retryable','terminal','manual_reconcile')),
    reconciliation_reason text CHECK (reconciliation_reason IS NULL OR reconciliation_reason ~ '^[a-z][a-z0-9_:.-]{1,191}$'),
    reconciled boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL,
    accepted_at timestamptz,
    finished_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    FOREIGN KEY (result_object_id,result_object_version)
        REFERENCES objects.object_versions(object_id,version) ON DELETE RESTRICT,
    CHECK ((replay_contract->>'idempotencyMode'='provider_key')=(provider_idempotency_key IS NOT NULL)),
    CHECK ((acceptance_state='not_accepted')=(accepted_at IS NULL)),
    CHECK ((last_output_sequence=0)=(observed_output_bytes=0)),
    CHECK ((last_output_sequence=0)=(output_chain_digest IS NULL)),
    CHECK (acceptance_state='output_observed' OR last_output_sequence=0),
    CHECK ((result_object_id IS NULL)=(result_object_version IS NULL)),
    CHECK ((result_object_id IS NULL)=(result_sha256 IS NULL)),
    CHECK ((result_object_id IS NULL)=(result_size_bytes IS NULL)),
    CHECK ((lifecycle_state='succeeded')=(result_object_id IS NOT NULL)),
    CHECK ((lifecycle_state IN ('succeeded','failed','incomplete','cancelled'))=(finished_at IS NOT NULL)),
    CHECK (lifecycle_state<>'reconcile_required' OR reconciliation_reason IS NOT NULL),
    CHECK ((cancel_requested_at IS NULL)=(cancellation_state='none')),
    CHECK (accepted_at IS NULL OR accepted_at>=started_at),
    CHECK (finished_at IS NULL OR finished_at>=started_at)
);

CREATE UNIQUE INDEX external_attempt_one_active_job_idx
ON compute.external_attempt_dispatches(job_id)
WHERE lifecycle_state IN ('dispatching','accepted','streaming','reconcile_required');

CREATE INDEX external_attempt_provider_state_idx
ON compute.external_attempt_dispatches(provider_id,lifecycle_state,started_at);

CREATE TABLE compute.external_attempt_events (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    attempt_id uuid NOT NULL REFERENCES compute.external_attempt_dispatches(attempt_id) ON DELETE CASCADE,
    event_kind text NOT NULL CHECK (event_kind IN (
        'dispatch_started','accepted','output_observed','side_effect_uncertain','succeeded','failed','incomplete',
        'reconcile_required','cancellation_requested','cancellation_confirmed','cancellation_unsupported',
        'cancellation_uncertain','reconciled_succeeded','reconciled_failed'
    )),
    acceptance_state text NOT NULL CHECK (acceptance_state IN ('not_accepted','accepted_no_output','output_observed','side_effect_uncertain')),
    output_sequence bigint CHECK (output_sequence IS NULL OR output_sequence>0),
    size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes>0),
    sha256 bytea CHECK (sha256 IS NULL OR octet_length(sha256)=32),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_:.-]{1,191}$'),
    retry_action text CHECK (retry_action IS NULL OR retry_action IN ('none','failover','retry_same_provider','reconcile','manual_reconcile','terminal')),
    cancellation_outcome text CHECK (cancellation_outcome IS NULL OR length(cancellation_outcome) BETWEEN 1 AND 128),
    occurred_at timestamptz NOT NULL,
    CHECK ((output_sequence IS NULL)=(size_bytes IS NULL)),
    CHECK ((output_sequence IS NULL)=(sha256 IS NULL))
);

CREATE INDEX external_attempt_events_attempt_idx
ON compute.external_attempt_events(attempt_id,sequence_id);

CREATE FUNCTION compute.enforce_external_attempt_create()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    attempt_job uuid;
    attempt_provider uuid;
    attempt_acceptance text;
    job_owner uuid;
    provider_kind text;
BEGIN
    SELECT attempt.job_id,attempt.provider_id,attempt.acceptance_state,job.owner_identity_id
      INTO attempt_job,attempt_provider,attempt_acceptance,job_owner
    FROM compute.attempts attempt JOIN compute.jobs job ON job.id=attempt.job_id
    WHERE attempt.id=NEW.attempt_id;
    SELECT provider_kind INTO provider_kind FROM compute.providers WHERE id=NEW.provider_id;
    IF attempt_job IS NULL OR attempt_job<>NEW.job_id OR attempt_provider<>NEW.provider_id
       OR attempt_acceptance<>'not_accepted' OR job_owner<>NEW.owner_identity_id
       OR provider_kind<>'external_openai' THEN
        RAISE EXCEPTION 'external attempt does not match its durable job and provider boundary' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER external_attempt_create_boundary
BEFORE INSERT ON compute.external_attempt_dispatches
FOR EACH ROW EXECUTE FUNCTION compute.enforce_external_attempt_create();

CREATE FUNCTION compute.enforce_external_attempt_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    result_digest bytea;
    result_namespace text;
BEGIN
    IF NEW.attempt_id<>OLD.attempt_id OR NEW.job_id<>OLD.job_id OR NEW.owner_identity_id<>OLD.owner_identity_id
       OR NEW.provider_id<>OLD.provider_id OR NEW.provider_model<>OLD.provider_model
       OR NEW.request_digest<>OLD.request_digest OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key
       OR NEW.replay_contract<>OLD.replay_contract OR NEW.started_at<>OLD.started_at
       OR NEW.last_output_sequence<OLD.last_output_sequence OR NEW.observed_output_bytes<OLD.observed_output_bytes
       OR OLD.lifecycle_state IN ('succeeded','failed','cancelled') AND NEW.lifecycle_state<>OLD.lifecycle_state
       OR OLD.acceptance_state='output_observed' AND NEW.acceptance_state<>'output_observed'
       OR OLD.acceptance_state='side_effect_uncertain' AND NEW.acceptance_state<>'side_effect_uncertain' THEN
        RAISE EXCEPTION 'immutable or terminal external attempt facts cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.result_object_id IS NOT NULL THEN
        SELECT version.sha256,entry.namespace_key INTO result_digest,result_namespace
        FROM objects.object_versions version JOIN objects.object_entries entry ON entry.id=version.object_id
        WHERE version.object_id=NEW.result_object_id AND version.version=NEW.result_object_version;
        IF result_digest IS NULL OR result_digest<>NEW.result_sha256
           OR result_namespace<>format('user:%s',NEW.owner_identity_id) THEN
            RAISE EXCEPTION 'external attempt result is not the verified owner object' USING ERRCODE='23514';
        END IF;
    END IF;
    NEW.revision=OLD.revision+1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER external_attempt_update_boundary
BEFORE UPDATE ON compute.external_attempt_dispatches
FOR EACH ROW EXECUTE FUNCTION compute.enforce_external_attempt_update();

CREATE FUNCTION compute.reject_external_attempt_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'external attempt events are append-only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER external_attempt_events_append_only
BEFORE UPDATE OR DELETE ON compute.external_attempt_events
FOR EACH ROW EXECUTE FUNCTION compute.reject_external_attempt_event_mutation();
