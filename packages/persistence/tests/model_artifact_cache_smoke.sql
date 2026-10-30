\set ON_ERROR_STOP on
BEGIN;

INSERT INTO compute.model_cache_accounts (
    account_key, quota_bytes
) VALUES ('model-cache-smoke', 100);

INSERT INTO compute.model_artifact_imports (
    id, account_key, candidate_key, source_kind, artifact_name,
    artifact_sha256, size_bytes, media_type, chunk_size_bytes,
    source_uri, source_revision, reservation_bytes, operation_key
) VALUES (
    '00000000-0000-4000-8000-000000002001', 'model-cache-smoke',
    'example-nvfp4', 'online', 'weights.bin', decode(repeat('cc', 32), 'hex'),
    8, 'application/octet-stream', 4,
    'https://models.example.test/revision/weights.bin', 'revision-1', 8,
    'model-import-smoke-2001'
);

UPDATE compute.model_cache_accounts SET reserved_bytes = 8
WHERE account_key = 'model-cache-smoke';

INSERT INTO objects.encrypted_blobs (
    blob_key, plaintext_size, plaintext_sha256, ciphertext_size,
    ciphertext_sha256, data_algorithm, data_nonce, data_tag,
    wrap_algorithm, wrapping_key_version, wrap_nonce, wrapped_data_key, wrap_tag
) VALUES
    ('models/chunks/sha256/' || repeat('aa', 32), 4, decode(repeat('aa', 32), 'hex'), 4,
     decode(repeat('1a', 32), 'hex'), 'aes-256-gcm', decode(repeat('01', 12), 'hex'),
     decode(repeat('02', 16), 'hex'), 'aes-256-gcm-keywrap', 1,
     decode(repeat('03', 12), 'hex'), decode(repeat('04', 32), 'hex'), decode(repeat('05', 16), 'hex')),
    ('models/chunks/sha256/' || repeat('bb', 32), 4, decode(repeat('bb', 32), 'hex'), 4,
     decode(repeat('1b', 32), 'hex'), 'aes-256-gcm', decode(repeat('11', 12), 'hex'),
     decode(repeat('12', 16), 'hex'), 'aes-256-gcm-keywrap', 1,
     decode(repeat('13', 12), 'hex'), decode(repeat('14', 32), 'hex'), decode(repeat('15', 16), 'hex')),
    ('models/chunks/sha256/' || repeat('dd', 32), 4, decode(repeat('dd', 32), 'hex'), 4,
     decode(repeat('1d', 32), 'hex'), 'aes-256-gcm', decode(repeat('21', 12), 'hex'),
     decode(repeat('22', 16), 'hex'), 'aes-256-gcm-keywrap', 1,
     decode(repeat('23', 12), 'hex'), decode(repeat('24', 32), 'hex'), decode(repeat('25', 16), 'hex')),
    ('models/chunks/sha256/' || repeat('ee', 32), 4, decode(repeat('ee', 32), 'hex'), 4,
     decode(repeat('1e', 32), 'hex'), 'aes-256-gcm', decode(repeat('31', 12), 'hex'),
     decode(repeat('32', 16), 'hex'), 'aes-256-gcm-keywrap', 1,
     decode(repeat('33', 12), 'hex'), decode(repeat('34', 32), 'hex'), decode(repeat('35', 16), 'hex'));

SELECT compute.record_model_import_chunk(
    '00000000-0000-4000-8000-000000002001', 0, 0,
    decode(repeat('aa', 32), 'hex'), 4,
    'models/chunks/sha256/' || repeat('aa', 32), '"stable"', NULL
);
SELECT compute.record_model_import_chunk(
    '00000000-0000-4000-8000-000000002001', 1, 4,
    decode(repeat('bb', 32), 'hex'), 4,
    'models/chunks/sha256/' || repeat('bb', 32), '"stable"', NULL
);

DO $smoke$
BEGIN
    IF (SELECT committed_bytes FROM compute.model_cache_accounts WHERE account_key = 'model-cache-smoke') <> 8
       OR (SELECT reserved_bytes FROM compute.model_cache_accounts WHERE account_key = 'model-cache-smoke') <> 0
       OR (SELECT received_bytes FROM compute.model_artifact_imports WHERE id = '00000000-0000-4000-8000-000000002001') <> 8 THEN
        RAISE EXCEPTION 'model import accounting did not advance atomically';
    END IF;
    BEGIN
        INSERT INTO compute.model_cache_chunks (chunk_sha256, blob_key, size_bytes)
        VALUES (
            decode(repeat('ff', 32), 'hex'),
            'models/chunks/sha256/' || repeat('dd', 32), 4
        );
        RAISE EXCEPTION 'expected protected content-addressed model chunk rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END
$smoke$;

SELECT compute.finalize_model_artifact_import('00000000-0000-4000-8000-000000002001');

DO $smoke$
BEGIN
    IF (SELECT state FROM compute.model_artifact_imports WHERE id = '00000000-0000-4000-8000-000000002001') <> 'ready'
       OR (SELECT count(*) FROM compute.model_artifact_chunk_map WHERE artifact_sha256 = decode(repeat('cc', 32), 'hex')) <> 2
       OR EXISTS (SELECT 1 FROM compute.model_artifact_import_chunks WHERE import_id = '00000000-0000-4000-8000-000000002001') THEN
        RAISE EXCEPTION 'verified model artifact was not promoted atomically';
    END IF;
END
$smoke$;

INSERT INTO compute.model_artifact_imports (
    id, account_key, candidate_key, source_kind, artifact_name,
    artifact_sha256, size_bytes, media_type, chunk_size_bytes,
    source_uri, source_revision, reservation_bytes, operation_key
) VALUES (
    '00000000-0000-4000-8000-000000002002', 'model-cache-smoke',
    'example-nvfp4', 'offline-bundle', 'adapter.bin', decode(repeat('ef', 32), 'hex'),
    4, 'application/octet-stream', 4,
    'https://models.example.test/revision/adapter.bin', 'revision-1', 4,
    'model-import-smoke-2002'
);
UPDATE compute.model_cache_accounts SET reserved_bytes = reserved_bytes + 4
WHERE account_key = 'model-cache-smoke';
SELECT compute.record_model_import_chunk(
    '00000000-0000-4000-8000-000000002002', 0, 0,
    decode(repeat('dd', 32), 'hex'), 4,
    'models/chunks/sha256/' || repeat('dd', 32), 'offline:signed-index', NULL
);
SELECT * FROM compute.fail_model_artifact_import(
    '00000000-0000-4000-8000-000000002002', 'model_artifact_checksum_failed'
);

DO $smoke$
BEGIN
    IF (SELECT state FROM compute.model_artifact_imports WHERE id = '00000000-0000-4000-8000-000000002002') <> 'failed'
       OR EXISTS (SELECT 1 FROM compute.model_cache_chunks WHERE chunk_sha256 = decode(repeat('dd', 32), 'hex'))
       OR (SELECT committed_bytes FROM compute.model_cache_accounts WHERE account_key = 'model-cache-smoke') <> 8
       OR NOT EXISTS (
           SELECT 1 FROM compute.orphan_model_encrypted_blobs(clock_timestamp(), 100)
           WHERE blob_key = 'models/chunks/sha256/' || repeat('ee', 32)
       ) THEN
        RAISE EXCEPTION 'failed import cleanup or orphan discovery is invalid';
    END IF;
END
$smoke$;

ROLLBACK;
