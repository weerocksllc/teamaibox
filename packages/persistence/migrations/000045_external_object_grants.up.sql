CREATE FUNCTION compute.valid_external_object_operations(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value)='array'
       AND jsonb_array_length(value) BETWEEN 1 AND 3
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(value) operation(item)
           WHERE jsonb_typeof(item)<>'string'
              OR item #>> '{}' NOT IN ('head','read','range','write')
       )
       AND (SELECT count(*)=count(DISTINCT item) FROM jsonb_array_elements(value) operation(item));
$$;

CREATE TABLE compute.external_object_grants (
    id uuid PRIMARY KEY,
    ticket_digest bytea NOT NULL UNIQUE CHECK (octet_length(ticket_digest)=32),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL REFERENCES compute.attempts(id) ON DELETE RESTRICT,
    provider_id uuid NOT NULL REFERENCES compute.providers(id) ON DELETE RESTRICT,
    direction text NOT NULL CHECK (direction IN ('input','output')),
    reference_id uuid REFERENCES objects.access_grants(reference_id) ON DELETE RESTRICT,
    audience text NOT NULL CHECK (audience ~ '^external-provider:[0-9a-f-]{36}:[0-9a-f-]{36}$'),
    operations jsonb NOT NULL CHECK (compute.valid_external_object_operations(operations)),
    expected_sha256 bytea CHECK (expected_sha256 IS NULL OR octet_length(expected_sha256)=32),
    expected_size bigint CHECK (expected_size IS NULL OR expected_size>0),
    maximum_bytes bigint NOT NULL CHECK (maximum_bytes BETWEEN 1 AND 67108864),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 3 AND 255),
    destination_object_key text CHECK (destination_object_key IS NULL OR length(destination_object_key) BETWEEN 1 AND 1024),
    maximum_uses integer NOT NULL CHECK (maximum_uses BETWEEN 1 AND 4096),
    use_count integer NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND maximum_uses),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','consuming','consumed','failed','revoked')),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    completed_at timestamptz,
    failed_at timestamptz,
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_:.-]{1,191}$'),
    revoked_at timestamptz,
    revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason ~ '^[a-z][a-z0-9_]{1,63}$'),
    completed_object_id uuid,
    completed_object_version integer,
    completed_sha256 bytea CHECK (completed_sha256 IS NULL OR octet_length(completed_sha256)=32),
    FOREIGN KEY (completed_object_id, completed_object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT,
    CHECK (expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
    CHECK (last_used_at IS NULL OR last_used_at>=created_at),
    CHECK (
        (direction='input' AND reference_id IS NOT NULL AND operations <@ '["head","read","range"]'::jsonb
            AND expected_sha256 IS NOT NULL AND expected_size IS NOT NULL
            AND maximum_bytes=expected_size AND destination_object_key IS NULL)
        OR
        (direction='output' AND reference_id IS NULL AND operations='["write"]'::jsonb
            AND destination_object_key IS NOT NULL AND maximum_uses=1)
    ),
    CHECK ((state='consumed')=(completed_at IS NOT NULL)),
    CHECK ((state='failed')=(failed_at IS NOT NULL)),
    CHECK ((state='revoked')=(revoked_at IS NOT NULL)),
    CHECK ((completed_object_id IS NULL)=(completed_object_version IS NULL)),
    CHECK ((completed_object_id IS NULL)=(completed_sha256 IS NULL)),
    CHECK (state='consumed' OR completed_object_id IS NULL),
    CHECK ((failure_code IS NULL)=(failed_at IS NULL)),
    CHECK ((revoke_reason IS NULL)=(revoked_at IS NULL))
);

COMMENT ON COLUMN compute.external_object_grants.ticket_digest IS
'SHA-256 digest of an opaque 256-bit bearer ticket; the usable ticket and object-store credentials are never persisted.';

CREATE INDEX external_object_grants_attempt_active_idx
ON compute.external_object_grants (attempt_id, state, expires_at)
WHERE state IN ('active','consuming');

CREATE FUNCTION compute.enforce_external_object_grant_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt_job uuid;
    attempt_provider uuid;
    job_owner uuid;
    provider_kind text;
    reference_issuer uuid;
    reference_audience text;
    reference_digest bytea;
BEGIN
    SELECT attempt.job_id, attempt.provider_id, job.owner_identity_id
      INTO attempt_job, attempt_provider, job_owner
    FROM compute.attempts attempt
    JOIN compute.jobs job ON job.id=attempt.job_id
    WHERE attempt.id=NEW.attempt_id;
    SELECT provider.provider_kind INTO provider_kind
    FROM compute.providers provider WHERE provider.id=NEW.provider_id;
    IF attempt_job IS NULL OR attempt_job<>NEW.job_id OR attempt_provider<>NEW.provider_id
       OR job_owner<>NEW.owner_identity_id OR provider_kind<>'external_openai'
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

CREATE TRIGGER external_object_grant_create_boundary
BEFORE INSERT ON compute.external_object_grants
FOR EACH ROW EXECUTE FUNCTION compute.enforce_external_object_grant_boundary();

CREATE FUNCTION compute.enforce_external_object_grant_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    completed_digest bytea;
    completed_namespace text;
BEGIN
    IF NEW.id<>OLD.id OR NEW.ticket_digest<>OLD.ticket_digest
       OR NEW.owner_identity_id<>OLD.owner_identity_id OR NEW.job_id<>OLD.job_id
       OR NEW.attempt_id<>OLD.attempt_id OR NEW.provider_id<>OLD.provider_id
       OR NEW.direction<>OLD.direction OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
       OR NEW.audience<>OLD.audience OR NEW.operations<>OLD.operations
       OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
       OR NEW.expected_size IS DISTINCT FROM OLD.expected_size OR NEW.maximum_bytes<>OLD.maximum_bytes
       OR NEW.media_type<>OLD.media_type OR NEW.destination_object_key IS DISTINCT FROM OLD.destination_object_key
       OR NEW.maximum_uses<>OLD.maximum_uses OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
       OR NEW.use_count<OLD.use_count OR (OLD.state IN ('consumed','failed','revoked') AND NEW.state<>OLD.state) THEN
        RAISE EXCEPTION 'immutable external object grant fields cannot change' USING ERRCODE='23514';
    END IF;
    IF NEW.completed_object_id IS NOT NULL THEN
        SELECT version.sha256,entry.namespace_key INTO completed_digest,completed_namespace
        FROM objects.object_versions version
        JOIN objects.object_entries entry ON entry.id=version.object_id
        WHERE version.object_id=NEW.completed_object_id AND version.version=NEW.completed_object_version;
        IF completed_digest IS NULL OR completed_digest<>NEW.completed_sha256
           OR completed_namespace<>format('user:%s',NEW.owner_identity_id) THEN
            RAISE EXCEPTION 'completed external output does not match its protected owner object'
                USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER external_object_grant_update_boundary
BEFORE UPDATE ON compute.external_object_grants
FOR EACH ROW EXECUTE FUNCTION compute.enforce_external_object_grant_update();
