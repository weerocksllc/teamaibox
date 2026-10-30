-- Retire only speculative model-import accounting. Chunk bytes, import
-- offsets, encrypted blobs, signatures and resumable identities are unchanged.
ALTER TABLE compute.model_cache_accounts DROP COLUMN reserved_bytes;
ALTER TABLE compute.model_cache_accounts ADD CONSTRAINT model_cache_actual_bytes_limit
    CHECK (committed_bytes <= quota_bytes);
ALTER TABLE compute.model_artifact_imports DROP COLUMN reservation_bytes;
ALTER TABLE compute.model_artifact_imports ADD CONSTRAINT model_import_verified_progress
    CHECK ((state = 'active' AND error_code IS NULL)
        OR (state = 'ready' AND received_bytes = size_bytes AND error_code IS NULL)
        OR (state = 'failed' AND error_code IS NOT NULL));

CREATE OR REPLACE FUNCTION compute.record_model_import_chunk(
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
        next_ordinal = next_ordinal + 1,
        source_etag = coalesce(source_etag, requested_etag),
        source_last_modified = coalesce(source_last_modified, requested_last_modified),
        updated_at = clock_timestamp()
    WHERE id = requested_import_id;
    IF chunk_created THEN
        UPDATE compute.model_cache_accounts
        SET committed_bytes = committed_bytes + requested_size,
            updated_at = clock_timestamp()
        WHERE account_key = import_record.account_key
          AND committed_bytes + requested_size <= quota_bytes;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'actual model cache storage limit reached' USING ERRCODE = '53100';
        END IF;
    END IF;
    RETURN chunk_created;
END;
$$;

CREATE OR REPLACE FUNCTION compute.finalize_model_artifact_import(requested_import_id uuid)
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
       OR import_record.received_bytes <> import_record.size_bytes THEN
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

CREATE OR REPLACE FUNCTION compute.fail_model_artifact_import(requested_import_id uuid, requested_error_code text)
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
    UPDATE compute.model_artifact_imports
    SET state = 'failed', error_code = requested_error_code,
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

