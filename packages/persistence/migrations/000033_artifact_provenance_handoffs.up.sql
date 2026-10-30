CREATE TABLE objects.artifact_provenance (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    artifact_kind text NOT NULL CHECK (artifact_kind IN (
        'chat-attachment', 'drive-file', 'agent-artifact', 'ai-input', 'ai-result',
        'fine-tuning-dataset', 'fine-tuning-checkpoint', 'model-artifact'
    )),
    object_id uuid NOT NULL,
    object_version integer NOT NULL CHECK (object_version > 0),
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    object_key text CHECK (object_key IS NULL OR length(object_key) BETWEEN 1 AND 1024),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    producer_kind text NOT NULL CHECK (producer_kind IN (
        'user', 'application', 'agent', 'compute-job', 'worker', 'model-registry',
        'model-studio', 'team-drive', 'messaging'
    )),
    producer_key text NOT NULL CHECK (producer_key ~ '^[a-z][a-z0-9_.:-]{1,190}$'),
    application_key text CHECK (application_key IS NULL OR application_key ~ '^[a-z][a-z0-9_.:-]{1,190}$'),
    job_id uuid,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    provenance_digest bytea NOT NULL UNIQUE CHECK (octet_length(provenance_digest) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (object_id, object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT
);

CREATE INDEX artifact_provenance_object_idx
ON objects.artifact_provenance (object_id, object_version, created_at DESC, id DESC);

CREATE INDEX artifact_provenance_owner_idx
ON objects.artifact_provenance (owner_identity_id, created_at DESC, id DESC);

CREATE TABLE objects.artifact_provenance_sources (
    provenance_id uuid NOT NULL REFERENCES objects.artifact_provenance(id) ON DELETE RESTRICT,
    source_ordinal integer NOT NULL CHECK (source_ordinal >= 0 AND source_ordinal < 64),
    relationship text NOT NULL CHECK (relationship IN (
        'source', 'input', 'derived-from', 'checkpoint-of', 'version-of', 'export-of', 'copy-of'
    )),
    source_object_id uuid NOT NULL,
    source_object_version integer NOT NULL CHECK (source_object_version > 0),
    source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
    source_provenance_id uuid REFERENCES objects.artifact_provenance(id) ON DELETE RESTRICT,
    PRIMARY KEY (provenance_id, source_ordinal),
    FOREIGN KEY (source_object_id, source_object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT,
    CHECK (source_provenance_id IS NULL OR source_provenance_id <> provenance_id)
);

CREATE INDEX artifact_provenance_source_idx
ON objects.artifact_provenance_sources (source_object_id, source_object_version, provenance_id);

CREATE TABLE objects.artifact_handoffs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    provenance_id uuid REFERENCES objects.artifact_provenance(id) ON DELETE SET NULL,
    object_id uuid NOT NULL,
    object_version integer NOT NULL CHECK (object_version > 0),
    actor_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    consumer_kind text NOT NULL CHECK (consumer_kind IN (
        'user', 'application', 'agent', 'compute-job', 'worker', 'model-registry',
        'model-studio', 'team-drive', 'messaging'
    )),
    consumer_key text NOT NULL CHECK (consumer_key ~ '^[a-z][a-z0-9_.:-]{1,190}$'),
    application_key text CHECK (application_key IS NULL OR application_key ~ '^[a-z][a-z0-9_.:-]{1,190}$'),
    job_id uuid,
    audience text NOT NULL CHECK (length(audience) BETWEEN 3 AND 191),
    operation text NOT NULL CHECK (operation IN ('head', 'read', 'range')),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (object_id, object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT
);

CREATE INDEX artifact_handoffs_object_idx
ON objects.artifact_handoffs (object_id, object_version, occurred_at DESC, id DESC);

CREATE INDEX artifact_handoffs_actor_idx
ON objects.artifact_handoffs (actor_identity_id, occurred_at DESC, id DESC);

CREATE FUNCTION objects.reject_artifact_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'artifact provenance and handoffs are append-only'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER artifact_provenance_append_only
BEFORE UPDATE OR DELETE ON objects.artifact_provenance
FOR EACH ROW EXECUTE FUNCTION objects.reject_artifact_provenance_mutation();

CREATE TRIGGER artifact_provenance_sources_append_only
BEFORE UPDATE OR DELETE ON objects.artifact_provenance_sources
FOR EACH ROW EXECUTE FUNCTION objects.reject_artifact_provenance_mutation();

CREATE TRIGGER artifact_handoffs_append_only
BEFORE UPDATE OR DELETE ON objects.artifact_handoffs
FOR EACH ROW EXECUTE FUNCTION objects.reject_artifact_provenance_mutation();
