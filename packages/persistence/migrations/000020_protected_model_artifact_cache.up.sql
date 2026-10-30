CREATE TABLE compute.model_cache_accounts (
    account_key text PRIMARY KEY CHECK (account_key ~ '^[a-z][a-z0-9._:-]{2,127}$'),
    quota_bytes bigint NOT NULL CHECK (quota_bytes >= 1),
    committed_bytes bigint NOT NULL DEFAULT 0 CHECK (committed_bytes >= 0),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (committed_bytes + reserved_bytes <= quota_bytes)
);

CREATE TABLE compute.model_artifact_imports (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    account_key text NOT NULL REFERENCES compute.model_cache_accounts(account_key) ON DELETE RESTRICT,
    candidate_key text NOT NULL CHECK (candidate_key ~ '^[a-z][a-z0-9._-]{2,191}$'),
    source_kind text NOT NULL CHECK (source_kind IN ('online', 'offline-bundle')),
    artifact_name text NOT NULL CHECK (
        length(artifact_name) BETWEEN 1 AND 1024
        AND artifact_name !~ '(^|/)\.\.?(/|$)'
    ),
    artifact_sha256 bytea NOT NULL CHECK (octet_length(artifact_sha256) = 32),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 1),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 3 AND 256),
    chunk_size_bytes integer NOT NULL CHECK (chunk_size_bytes BETWEEN 1 AND 67108864),
    source_uri text NOT NULL CHECK (
        length(source_uri) BETWEEN 9 AND 2048
        AND source_uri LIKE 'https://%'
        AND source_uri !~ 'https://[^/]*@'
    ),
    source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 256),
    signature jsonb CHECK (signature IS NULL OR (
        jsonb_typeof(signature) = 'object'
        AND signature ->> 'algorithm' = 'Ed25519'
        AND signature ?& ARRAY['keyId', 'value']
    )),
    bundle_signature_verified boolean NOT NULL DEFAULT false,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ready', 'failed')),
    received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= size_bytes),
    reservation_bytes bigint NOT NULL CHECK (reservation_bytes >= 0 AND reservation_bytes <= size_bytes),
    next_ordinal integer NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
    source_etag text CHECK (source_etag IS NULL OR length(source_etag) BETWEEN 1 AND 1024),
    source_last_modified text CHECK (source_last_modified IS NULL OR length(source_last_modified) BETWEEN 1 AND 1024),
    deduplicated boolean NOT NULL DEFAULT false,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{2,127}$'),
    requested_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (state = 'active' AND received_bytes + reservation_bytes = size_bytes AND error_code IS NULL)
        OR (state = 'ready' AND received_bytes = size_bytes AND reservation_bytes = 0 AND error_code IS NULL)
        OR (state = 'failed' AND reservation_bytes = 0 AND error_code IS NOT NULL)
    )
);

CREATE INDEX model_artifact_imports_resume_idx
ON compute.model_artifact_imports (state, updated_at, id);

CREATE TABLE compute.model_cache_chunks (
    chunk_sha256 bytea PRIMARY KEY CHECK (octet_length(chunk_sha256) = 32),
    blob_key text NOT NULL UNIQUE REFERENCES objects.encrypted_blobs(blob_key) ON DELETE RESTRICT,
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE compute.model_artifacts (
    artifact_sha256 bytea PRIMARY KEY CHECK (octet_length(artifact_sha256) = 32),
    candidate_key text NOT NULL CHECK (candidate_key ~ '^[a-z][a-z0-9._-]{2,191}$'),
    artifact_name text NOT NULL CHECK (length(artifact_name) BETWEEN 1 AND 1024),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 1),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 3 AND 256),
    source_uri text NOT NULL CHECK (source_uri LIKE 'https://%'),
    source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 256),
    signature_verified boolean NOT NULL,
    chunk_count integer NOT NULL CHECK (chunk_count >= 1),
    state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'evicted')),
    pinned boolean NOT NULL DEFAULT false,
    lease_count integer NOT NULL DEFAULT 0 CHECK (lease_count >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_accessed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX model_artifacts_eviction_idx
ON compute.model_artifacts (last_accessed_at, artifact_sha256)
WHERE state = 'ready' AND NOT pinned AND lease_count = 0;

CREATE TABLE compute.model_artifact_import_chunks (
    import_id uuid NOT NULL REFERENCES compute.model_artifact_imports(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
    chunk_sha256 bytea NOT NULL REFERENCES compute.model_cache_chunks(chunk_sha256) ON DELETE RESTRICT,
    PRIMARY KEY (import_id, ordinal),
    UNIQUE (import_id, byte_offset)
);

CREATE TABLE compute.model_artifact_chunk_map (
    artifact_sha256 bytea NOT NULL REFERENCES compute.model_artifacts(artifact_sha256) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
    chunk_sha256 bytea NOT NULL REFERENCES compute.model_cache_chunks(chunk_sha256) ON DELETE RESTRICT,
    PRIMARY KEY (artifact_sha256, ordinal),
    UNIQUE (artifact_sha256, byte_offset)
);

CREATE INDEX model_artifact_chunk_map_chunk_idx
ON compute.model_artifact_chunk_map (chunk_sha256);

CREATE FUNCTION compute.enforce_protected_model_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    encrypted objects.encrypted_blobs%ROWTYPE;
BEGIN
    SELECT * INTO encrypted FROM objects.encrypted_blobs WHERE blob_key = NEW.blob_key;
    IF encrypted.blob_key IS NULL
       OR NEW.blob_key <> 'models/chunks/sha256/' || encode(NEW.chunk_sha256, 'hex')
       OR encrypted.plaintext_size <> NEW.size_bytes
       OR encrypted.plaintext_sha256 <> NEW.chunk_sha256
       OR encrypted.data_algorithm <> 'aes-256-gcm'
       OR encrypted.wrap_algorithm <> 'aes-256-gcm-keywrap' THEN
        RAISE EXCEPTION 'model chunk requires matching envelope-encrypted content-addressed storage'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER model_cache_chunk_protected_storage
BEFORE INSERT OR UPDATE ON compute.model_cache_chunks
FOR EACH ROW EXECUTE FUNCTION compute.enforce_protected_model_chunk();

CREATE FUNCTION compute.record_model_import_chunk(
    requested_import_id uuid,
    requested_ordinal integer,
    requested_offset bigint,
    requested_chunk_sha256 bytea,
    requested_size integer,
    requested_blob_key text,
    requested_etag text,
    requested_last_modified text
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    import_record compute.model_artifact_imports%ROWTYPE;
    existing_chunk compute.model_cache_chunks%ROWTYPE;
    inserted_rows integer;
    chunk_created boolean;
BEGIN
    SELECT * INTO import_record
    FROM compute.model_artifact_imports
    WHERE id = requested_import_id
    FOR UPDATE;
    IF import_record.id IS NULL OR import_record.state <> 'active' THEN
        RAISE EXCEPTION 'model import is not active' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF requested_ordinal <> import_record.next_ordinal
       OR requested_offset <> import_record.received_bytes
       OR requested_size <> least(import_record.chunk_size_bytes, import_record.size_bytes - import_record.received_bytes) THEN
        RAISE EXCEPTION 'model chunk is not the next exact range' USING ERRCODE = 'serialization_failure';
    END IF;
    IF import_record.source_etag IS NOT NULL AND requested_etag IS DISTINCT FROM import_record.source_etag THEN
        RAISE EXCEPTION 'model source ETag changed during resume' USING ERRCODE = 'data_exception';
    END IF;
    IF import_record.source_last_modified IS NOT NULL
       AND requested_last_modified IS DISTINCT FROM import_record.source_last_modified THEN
        RAISE EXCEPTION 'model source Last-Modified changed during resume' USING ERRCODE = 'data_exception';
    END IF;
    IF import_record.source_etag IS NULL AND import_record.source_last_modified IS NULL
       AND requested_etag IS NULL AND requested_last_modified IS NULL
       AND import_record.size_bytes > import_record.chunk_size_bytes THEN
        RAISE EXCEPTION 'resumable model source requires a stable validator' USING ERRCODE = 'data_exception';
    END IF;

    INSERT INTO compute.model_cache_chunks (chunk_sha256, blob_key, size_bytes)
    VALUES (requested_chunk_sha256, requested_blob_key, requested_size)
    ON CONFLICT (chunk_sha256) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    chunk_created := inserted_rows = 1;
    SELECT * INTO existing_chunk
    FROM compute.model_cache_chunks
    WHERE chunk_sha256 = requested_chunk_sha256;
    IF existing_chunk.size_bytes <> requested_size OR existing_chunk.blob_key <> requested_blob_key THEN
        RAISE EXCEPTION 'model content digest has inconsistent metadata' USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    INSERT INTO compute.model_artifact_import_chunks (
        import_id, ordinal, byte_offset, size_bytes, chunk_sha256
    ) VALUES (
        requested_import_id, requested_ordinal, requested_offset,
        requested_size, requested_chunk_sha256
    );
    UPDATE compute.model_artifact_imports
    SET received_bytes = received_bytes + requested_size,
        reservation_bytes = reservation_bytes - requested_size,
        next_ordinal = next_ordinal + 1,
        source_etag = coalesce(source_etag, requested_etag),
        source_last_modified = coalesce(source_last_modified, requested_last_modified),
        updated_at = clock_timestamp()
    WHERE id = requested_import_id;
    UPDATE compute.model_cache_accounts
    SET committed_bytes = committed_bytes + CASE WHEN chunk_created THEN requested_size ELSE 0 END,
        reserved_bytes = reserved_bytes - requested_size,
        updated_at = clock_timestamp()
    WHERE account_key = import_record.account_key;
    RETURN chunk_created;
END;
$$;

CREATE FUNCTION compute.finalize_model_artifact_import(requested_import_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    import_record compute.model_artifact_imports%ROWTYPE;
    existing_artifact compute.model_artifacts%ROWTYPE;
    inserted_rows integer;
BEGIN
    SELECT * INTO import_record
    FROM compute.model_artifact_imports
    WHERE id = requested_import_id
    FOR UPDATE;
    IF import_record.id IS NULL OR import_record.state <> 'active'
       OR import_record.received_bytes <> import_record.size_bytes
       OR import_record.reservation_bytes <> 0 THEN
        RAISE EXCEPTION 'model import is incomplete' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT * INTO existing_artifact
    FROM compute.model_artifacts
    WHERE artifact_sha256 = import_record.artifact_sha256
    FOR UPDATE;
    IF existing_artifact.artifact_sha256 IS NULL THEN
        INSERT INTO compute.model_artifacts (
            artifact_sha256, candidate_key, artifact_name, size_bytes, media_type,
            source_uri, source_revision, signature_verified, chunk_count
        ) VALUES (
            import_record.artifact_sha256, import_record.candidate_key,
            import_record.artifact_name, import_record.size_bytes, import_record.media_type,
            import_record.source_uri, import_record.source_revision,
            import_record.signature IS NOT NULL OR import_record.bundle_signature_verified,
            import_record.next_ordinal
        );
        inserted_rows := 1;
    ELSIF existing_artifact.size_bytes <> import_record.size_bytes THEN
        RAISE EXCEPTION 'model artifact digest has inconsistent metadata' USING ERRCODE = 'integrity_constraint_violation';
    ELSIF existing_artifact.state = 'evicted' THEN
        UPDATE compute.model_artifacts
        SET candidate_key = import_record.candidate_key,
            artifact_name = import_record.artifact_name,
            media_type = import_record.media_type,
            source_uri = import_record.source_uri,
            source_revision = import_record.source_revision,
            signature_verified = import_record.signature IS NOT NULL OR import_record.bundle_signature_verified,
            chunk_count = import_record.next_ordinal,
            state = 'ready', pinned = false, lease_count = 0,
            last_accessed_at = clock_timestamp()
        WHERE artifact_sha256 = import_record.artifact_sha256;
        inserted_rows := 1;
    ELSE
        inserted_rows := 0;
    END IF;
    IF inserted_rows = 1 THEN
        INSERT INTO compute.model_artifact_chunk_map (
            artifact_sha256, ordinal, byte_offset, size_bytes, chunk_sha256
        )
        SELECT import_record.artifact_sha256, ordinal, byte_offset, size_bytes, chunk_sha256
        FROM compute.model_artifact_import_chunks
        WHERE import_id = requested_import_id
        ORDER BY ordinal;
    END IF;
    DELETE FROM compute.model_artifact_import_chunks WHERE import_id = requested_import_id;
    UPDATE compute.model_artifact_imports
    SET state = 'ready', deduplicated = inserted_rows = 0, updated_at = clock_timestamp()
    WHERE id = requested_import_id;
    RETURN inserted_rows = 1;
END;
$$;

CREATE FUNCTION compute.fail_model_artifact_import(requested_import_id uuid, requested_error_code text)
RETURNS TABLE (chunk_sha256 bytea, blob_key text)
LANGUAGE plpgsql
AS $$
DECLARE
    import_record compute.model_artifact_imports%ROWTYPE;
BEGIN
    SELECT * INTO import_record
    FROM compute.model_artifact_imports
    WHERE id = requested_import_id
    FOR UPDATE;
    IF import_record.id IS NULL OR import_record.state = 'ready' THEN
        RAISE EXCEPTION 'model import cannot be failed' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF import_record.state = 'failed' THEN RETURN; END IF;
    UPDATE compute.model_cache_accounts
    SET reserved_bytes = reserved_bytes - import_record.reservation_bytes,
        updated_at = clock_timestamp()
    WHERE account_key = import_record.account_key;
    UPDATE compute.model_artifact_imports
    SET state = 'failed', reservation_bytes = 0, error_code = requested_error_code,
        updated_at = clock_timestamp()
    WHERE id = requested_import_id;
    DELETE FROM compute.model_artifact_import_chunks WHERE import_id = requested_import_id;
    RETURN QUERY
    WITH deleted AS (
        DELETE FROM compute.model_cache_chunks candidate
        WHERE NOT EXISTS (
            SELECT 1 FROM compute.model_artifact_import_chunks active_ref
            WHERE active_ref.chunk_sha256 = candidate.chunk_sha256
        )
          AND NOT EXISTS (
            SELECT 1 FROM compute.model_artifact_chunk_map artifact_ref
            WHERE artifact_ref.chunk_sha256 = candidate.chunk_sha256
        )
        RETURNING candidate.chunk_sha256, candidate.blob_key, candidate.size_bytes
    ), accounted AS (
        UPDATE compute.model_cache_accounts account
        SET committed_bytes = account.committed_bytes - coalesce((SELECT sum(size_bytes) FROM deleted), 0),
            updated_at = clock_timestamp()
        WHERE account.account_key = import_record.account_key
        RETURNING 1
    )
    SELECT deleted.chunk_sha256, deleted.blob_key FROM deleted, accounted;
END;
$$;

CREATE FUNCTION compute.orphan_model_encrypted_blobs(moment timestamptz, maximum_rows integer)
RETURNS TABLE (blob_key text, reason text)
LANGUAGE sql
STABLE
STRICT
AS $$
    SELECT encrypted.blob_key, 'unclaimed_model_chunk'
    FROM objects.encrypted_blobs encrypted
    LEFT JOIN compute.model_cache_chunks chunk ON chunk.blob_key = encrypted.blob_key
    WHERE encrypted.blob_key LIKE 'models/chunks/sha256/%'
      AND chunk.blob_key IS NULL
      AND encrypted.created_at <= moment
    ORDER BY encrypted.created_at, encrypted.blob_key
    LIMIT greatest(0, least(maximum_rows, 1000));
$$;
