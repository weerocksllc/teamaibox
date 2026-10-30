CREATE TABLE objects.namespaces (
    namespace_key text PRIMARY KEY CHECK (
        namespace_key ~ '^[a-z][a-z0-9:._-]{2,190}$'
    ),
    quota_bytes bigint NOT NULL CHECK (quota_bytes >= 1),
    committed_bytes bigint NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (committed_bytes + reserved_bytes <= quota_bytes)
);

CREATE TABLE objects.multipart_uploads (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE RESTRICT,
    object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
    content_type text NOT NULL CHECK (length(content_type) BETWEEN 3 AND 255),
    expected_size bigint NOT NULL CHECK (expected_size >= 1),
    expected_sha256 bytea NOT NULL CHECK (octet_length(expected_sha256) = 32),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX multipart_uploads_expiry_idx
ON objects.multipart_uploads (expires_at, id);

CREATE TABLE objects.blob_claims (
    blob_key text PRIMARY KEY REFERENCES objects.encrypted_blobs(blob_key) ON DELETE RESTRICT,
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE RESTRICT,
    claim_kind text NOT NULL CHECK (claim_kind IN ('object_candidate', 'multipart_part')),
    claim_state text NOT NULL CHECK (
        claim_state IN ('staged', 'verified', 'multipart_part', 'committed', 'reclaimable')
    ),
    owner_upload_id uuid REFERENCES objects.multipart_uploads(id) ON DELETE SET NULL,
    expected_size bigint NOT NULL CHECK (expected_size >= 1),
    expected_sha256 bytea NOT NULL CHECK (octet_length(expected_sha256) = 32),
    verified_at timestamptz,
    expires_at timestamptz,
    reclaim_after timestamptz,
    committed_object_id uuid,
    committed_object_version integer,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (claim_state = 'staged' AND verified_at IS NULL AND expires_at IS NOT NULL)
        OR (claim_state IN ('verified', 'multipart_part') AND verified_at IS NOT NULL)
        OR (claim_state = 'committed' AND verified_at IS NOT NULL AND expires_at IS NULL
            AND reclaim_after IS NULL)
        OR claim_state = 'reclaimable'
    ),
    CHECK ((committed_object_id IS NULL) = (committed_object_version IS NULL)),
    CHECK (committed_object_version IS NULL OR committed_object_version >= 1)
);

CREATE INDEX blob_claims_reconciliation_idx
ON objects.blob_claims (claim_state, reclaim_after, expires_at, created_at);

CREATE TABLE objects.object_entries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE RESTRICT,
    object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
    current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    purge_after timestamptz,
    UNIQUE (namespace_key, object_key),
    CHECK ((deleted_at IS NULL AND purge_after IS NULL)
        OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after >= deleted_at))
);

CREATE TABLE objects.object_versions (
    object_id uuid NOT NULL REFERENCES objects.object_entries(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    blob_key text NOT NULL UNIQUE REFERENCES objects.encrypted_blobs(blob_key) ON DELETE RESTRICT,
    size bigint NOT NULL CHECK (size >= 1),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    content_type text NOT NULL CHECK (length(content_type) BETWEEN 3 AND 255),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (object_id, version)
);

CREATE TABLE objects.multipart_parts (
    upload_id uuid NOT NULL REFERENCES objects.multipart_uploads(id) ON DELETE CASCADE,
    part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    blob_key text NOT NULL UNIQUE REFERENCES objects.encrypted_blobs(blob_key) ON DELETE RESTRICT,
    size bigint NOT NULL CHECK (size >= 1),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE objects.file_entries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE RESTRICT,
    file_path text NOT NULL CHECK (length(file_path) BETWEEN 1 AND 2048),
    current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    UNIQUE (namespace_key, file_path)
);

CREATE TABLE objects.file_versions (
    file_id uuid NOT NULL REFERENCES objects.file_entries(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    object_id uuid NOT NULL,
    object_version integer NOT NULL,
    source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256) = 32),
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (file_id, version),
    FOREIGN KEY (object_id, object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT
);

CREATE FUNCTION objects.enforce_verified_object_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    entry_namespace text;
    entry_current integer;
    claim objects.blob_claims%ROWTYPE;
    encrypted objects.encrypted_blobs%ROWTYPE;
BEGIN
    SELECT namespace_key, current_version INTO entry_namespace, entry_current
    FROM objects.object_entries
    WHERE id = NEW.object_id
    FOR UPDATE;
    IF NOT FOUND OR NEW.version <> entry_current + 1 THEN
        RAISE EXCEPTION 'object version is not the next transactional version'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO claim
    FROM objects.blob_claims
    WHERE blob_key = NEW.blob_key
    FOR UPDATE;
    SELECT * INTO encrypted
    FROM objects.encrypted_blobs
    WHERE blob_key = NEW.blob_key;
    IF claim.blob_key IS NULL
       OR claim.claim_state <> 'verified'
       OR claim.claim_kind <> 'object_candidate'
       OR claim.namespace_key <> entry_namespace
       OR claim.expected_size <> NEW.size
       OR claim.expected_sha256 <> NEW.sha256
       OR encrypted.plaintext_size <> NEW.size
       OR encrypted.plaintext_sha256 <> NEW.sha256 THEN
        RAISE EXCEPTION 'object version requires a matching verified blob claim'
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE objects.blob_claims
    SET claim_state = 'committed', expires_at = NULL, reclaim_after = NULL,
        owner_upload_id = NULL, committed_object_id = NEW.object_id,
        committed_object_version = NEW.version
    WHERE blob_key = NEW.blob_key;
    RETURN NEW;
END;
$$;

CREATE FUNCTION objects.advance_object_current_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE objects.object_entries
    SET current_version = NEW.version, deleted_at = NULL, purge_after = NULL
    WHERE id = NEW.object_id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER object_version_verified_claim
BEFORE INSERT ON objects.object_versions
FOR EACH ROW EXECUTE FUNCTION objects.enforce_verified_object_version();

CREATE TRIGGER object_version_advance_current
AFTER INSERT ON objects.object_versions
FOR EACH ROW EXECUTE FUNCTION objects.advance_object_current_version();

CREATE FUNCTION objects.enforce_multipart_part_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    upload_namespace text;
    claim objects.blob_claims%ROWTYPE;
    encrypted objects.encrypted_blobs%ROWTYPE;
BEGIN
    SELECT namespace_key INTO upload_namespace
    FROM objects.multipart_uploads
    WHERE id = NEW.upload_id
    FOR UPDATE;
    SELECT * INTO claim FROM objects.blob_claims WHERE blob_key = NEW.blob_key FOR UPDATE;
    SELECT * INTO encrypted FROM objects.encrypted_blobs WHERE blob_key = NEW.blob_key;
    IF upload_namespace IS NULL
       OR claim.blob_key IS NULL
       OR claim.claim_state <> 'verified'
       OR claim.claim_kind <> 'multipart_part'
       OR claim.owner_upload_id <> NEW.upload_id
       OR claim.namespace_key <> upload_namespace
       OR claim.expected_size <> NEW.size
       OR claim.expected_sha256 <> NEW.sha256
       OR encrypted.plaintext_size <> NEW.size
       OR encrypted.plaintext_sha256 <> NEW.sha256 THEN
        RAISE EXCEPTION 'multipart part requires a matching verified blob claim'
            USING ERRCODE = 'check_violation';
    END IF;
    UPDATE objects.blob_claims
    SET claim_state = 'multipart_part', expires_at = NULL
    WHERE blob_key = NEW.blob_key;
    RETURN NEW;
END;
$$;

CREATE FUNCTION objects.release_multipart_part_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE objects.blob_claims
    SET claim_state = 'reclaimable', owner_upload_id = NULL,
        reclaim_after = clock_timestamp()
    WHERE blob_key = OLD.blob_key AND claim_state <> 'committed';
    RETURN NULL;
END;
$$;

CREATE TRIGGER multipart_part_verified_claim
BEFORE INSERT ON objects.multipart_parts
FOR EACH ROW EXECUTE FUNCTION objects.enforce_multipart_part_claim();

CREATE TRIGGER multipart_part_release_claim
AFTER DELETE ON objects.multipart_parts
FOR EACH ROW EXECUTE FUNCTION objects.release_multipart_part_claim();

CREATE FUNCTION objects.enforce_verified_file_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    file_namespace text;
    file_current integer;
    object_namespace text;
    object_sha256 bytea;
BEGIN
    SELECT namespace_key, current_version INTO file_namespace, file_current
    FROM objects.file_entries
    WHERE id = NEW.file_id
    FOR UPDATE;
    SELECT entry.namespace_key, version.sha256 INTO object_namespace, object_sha256
    FROM objects.object_versions version
    JOIN objects.object_entries entry ON entry.id = version.object_id
    WHERE version.object_id = NEW.object_id AND version.version = NEW.object_version;
    IF file_namespace IS NULL
       OR NEW.version <> file_current + 1
       OR object_namespace IS NULL
       OR object_namespace <> file_namespace
       OR object_sha256 <> NEW.source_sha256 THEN
        RAISE EXCEPTION 'file version requires a verified object version in the same namespace'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION objects.advance_file_current_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE objects.file_entries
    SET current_version = NEW.version, deleted_at = NULL
    WHERE id = NEW.file_id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER file_version_verified_object
BEFORE INSERT ON objects.file_versions
FOR EACH ROW EXECUTE FUNCTION objects.enforce_verified_file_version();

CREATE TRIGGER file_version_advance_current
AFTER INSERT ON objects.file_versions
FOR EACH ROW EXECUTE FUNCTION objects.advance_file_current_version();

CREATE FUNCTION objects.orphan_blob_candidates(moment timestamptz, maximum_rows integer)
RETURNS TABLE (blob_key text, reason text)
LANGUAGE sql
STABLE
STRICT
AS $$
    SELECT claim.blob_key,
           CASE
               WHEN claim.claim_state = 'reclaimable' THEN 'reclaimable'
               WHEN claim.claim_state = 'multipart_part' THEN 'expired_upload'
               ELSE 'expired_uncommitted'
           END
    FROM objects.blob_claims claim
    LEFT JOIN objects.multipart_uploads upload ON upload.id = claim.owner_upload_id
    WHERE NOT EXISTS (
        SELECT 1 FROM objects.object_versions version WHERE version.blob_key = claim.blob_key
    )
      AND (
          (claim.claim_state = 'reclaimable' AND claim.reclaim_after <= moment)
          OR (claim.claim_state IN ('staged', 'verified') AND claim.expires_at <= moment)
          OR (claim.claim_state = 'multipart_part'
              AND (upload.id IS NULL OR upload.expires_at <= moment))
      )
    ORDER BY claim.created_at, claim.blob_key
    LIMIT greatest(0, least(maximum_rows, 1000));
$$;
