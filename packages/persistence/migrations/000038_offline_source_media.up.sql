CREATE TABLE source_center.offline_media (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL,
    device_identity_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(device_identity_sha256)=32),
    filesystem_uuid uuid NOT NULL,
    volume_label text NOT NULL CHECK (char_length(volume_label) BETWEEN 1 AND 128),
    observed_manifest_sha256 bytea NOT NULL CHECK (octet_length(observed_manifest_sha256)=32),
    availability text NOT NULL CHECK (availability IN ('attached','detached')),
    approval_state text NOT NULL CHECK (approval_state IN ('pending','approved')),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('discovered','ready','detached')),
    record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK ((availability='detached')=(lifecycle_state='detached')),
    CHECK (approval_state<>'approved' OR lifecycle_state='ready'),
    CHECK (availability<>'detached' OR NOT (record ? 'mediaHandle'))
);

CREATE INDEX offline_media_node_state_idx
ON source_center.offline_media (node_id,availability,lifecycle_state,volume_label);

CREATE TABLE source_center.offline_media_artifacts (
    media_id uuid NOT NULL REFERENCES source_center.offline_media(id) ON DELETE RESTRICT,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    ecosystem text NOT NULL CHECK (ecosystem IN ('pip','npm','apt')),
    package_name text NOT NULL CHECK (char_length(package_name) BETWEEN 1 AND 214),
    package_version text NOT NULL CHECK (char_length(package_version) BETWEEN 1 AND 128),
    architecture text NOT NULL CHECK (architecture IN ('arm64','all','source')),
    relative_path text NOT NULL CHECK (relative_path !~ '(^/|(^|/)\.\.(/|$))'),
    sha256 bytea NOT NULL CHECK (octet_length(sha256)=32),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object'),
    PRIMARY KEY (media_id,ordinal),
    UNIQUE (media_id,relative_path),
    CHECK (artifact->>'ecosystem'=ecosystem),
    CHECK (artifact->>'name'=package_name),
    CHECK (artifact->>'version'=package_version),
    CHECK (artifact->>'architecture'=architecture),
    CHECK (artifact->>'relativePath'=relative_path),
    CHECK ((artifact->>'sizeBytes')::bigint=byte_size)
);

CREATE INDEX offline_media_artifact_lookup_idx
ON source_center.offline_media_artifacts (ecosystem,package_name,package_version,architecture,media_id);

CREATE TABLE source_center.offline_media_approvals (
    approval_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    media_id uuid NOT NULL REFERENCES source_center.offline_media(id) ON DELETE RESTRICT,
    media_revision bigint NOT NULL CHECK (media_revision > 1),
    manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256)=32),
    signer_fingerprint text NOT NULL CHECK (signer_fingerprint ~ '^(?:[A-F0-9]{40}|[A-F0-9]{64})$'),
    inventory jsonb NOT NULL CHECK (jsonb_typeof(inventory)='object'),
    approved_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    approved_at timestamptz NOT NULL,
    UNIQUE (media_id,media_revision)
);

CREATE FUNCTION source_center.reject_offline_media_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'offline media approval evidence is append-only' USING ERRCODE='23514';
END
$$;

CREATE TRIGGER offline_media_approvals_append_only
BEFORE UPDATE OR DELETE ON source_center.offline_media_approvals
FOR EACH ROW EXECUTE FUNCTION source_center.reject_offline_media_approval_mutation();
