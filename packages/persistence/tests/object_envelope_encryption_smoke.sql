\set ON_ERROR_STOP on
BEGIN;

INSERT INTO objects.encrypted_blobs (
    blob_key, plaintext_size, plaintext_sha256, ciphertext_size, ciphertext_sha256,
    data_algorithm, data_nonce, data_tag, wrap_algorithm, wrapping_key_version,
    wrap_nonce, wrapped_data_key, wrap_tag
) VALUES (
    'objects/smoke-encrypted-blob', 4096, decode(repeat('11', 32), 'hex'),
    4096, decode(repeat('22', 32), 'hex'), 'aes-256-gcm',
    decode(repeat('33', 12), 'hex'), decode(repeat('44', 16), 'hex'),
    'aes-256-gcm-keywrap', 1, decode(repeat('55', 12), 'hex'),
    decode(repeat('66', 32), 'hex'), decode(repeat('77', 16), 'hex')
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'objects'
          AND table_name = 'encrypted_blobs'
          AND column_name IN ('data_key', 'master_key', 'kek', 'plaintext_content')
    ) THEN
        RAISE EXCEPTION 'encrypted blob metadata exposes plaintext key or content storage';
    END IF;
    IF (SELECT octet_length(wrapped_data_key)
        FROM objects.encrypted_blobs
        WHERE blob_key = 'objects/smoke-encrypted-blob') <> 32 THEN
        RAISE EXCEPTION 'wrapped data key length is invalid';
    END IF;

    UPDATE objects.encrypted_blobs
    SET revision = revision + 1,
        wrapping_key_version = 2,
        wrap_nonce = decode(repeat('88', 12), 'hex'),
        wrapped_data_key = decode(repeat('99', 32), 'hex'),
        wrap_tag = decode(repeat('aa', 16), 'hex'),
        updated_at = clock_timestamp()
    WHERE blob_key = 'objects/smoke-encrypted-blob';

    IF (SELECT wrapping_key_version
        FROM objects.encrypted_blobs
        WHERE blob_key = 'objects/smoke-encrypted-blob') <> 2 THEN
        RAISE EXCEPTION 'wrapping-key version was not advanced';
    END IF;

    BEGIN
        UPDATE objects.encrypted_blobs
        SET revision = revision + 1,
            ciphertext_sha256 = decode(repeat('bb', 32), 'hex'),
            wrapping_key_version = 3,
            updated_at = clock_timestamp()
        WHERE blob_key = 'objects/smoke-encrypted-blob';
        RAISE EXCEPTION 'expected immutable ciphertext metadata rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO objects.encrypted_blobs (
            blob_key, plaintext_size, plaintext_sha256, ciphertext_size, ciphertext_sha256,
            data_algorithm, data_nonce, data_tag, wrap_algorithm, wrapping_key_version,
            wrap_nonce, wrapped_data_key, wrap_tag
        ) VALUES (
            'objects/invalid-nonce', 1, decode(repeat('11', 32), 'hex'),
            1, decode(repeat('22', 32), 'hex'), 'aes-256-gcm',
            decode(repeat('33', 11), 'hex'), decode(repeat('44', 16), 'hex'),
            'aes-256-gcm-keywrap', 1, decode(repeat('55', 12), 'hex'),
            decode(repeat('66', 32), 'hex'), decode(repeat('77', 16), 'hex')
        );
        RAISE EXCEPTION 'expected invalid nonce rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;
