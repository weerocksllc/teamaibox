CREATE SCHEMA objects;

CREATE TABLE objects.encrypted_blobs (
    blob_key text PRIMARY KEY CHECK (length(blob_key) BETWEEN 1 AND 2048),
    schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    plaintext_size bigint NOT NULL CHECK (plaintext_size >= 1),
    plaintext_sha256 bytea NOT NULL CHECK (octet_length(plaintext_sha256) = 32),
    ciphertext_size bigint NOT NULL CHECK (ciphertext_size >= 1),
    ciphertext_sha256 bytea NOT NULL CHECK (octet_length(ciphertext_sha256) = 32),
    data_algorithm text NOT NULL CHECK (data_algorithm = 'aes-256-gcm'),
    data_nonce bytea NOT NULL CHECK (octet_length(data_nonce) = 12),
    data_tag bytea NOT NULL CHECK (octet_length(data_tag) = 16),
    wrap_algorithm text NOT NULL CHECK (wrap_algorithm = 'aes-256-gcm-keywrap'),
    wrapping_key_version bigint NOT NULL CHECK (wrapping_key_version >= 1),
    wrap_nonce bytea NOT NULL CHECK (octet_length(wrap_nonce) = 12),
    wrapped_data_key bytea NOT NULL CHECK (octet_length(wrapped_data_key) = 32),
    wrap_tag bytea NOT NULL CHECK (octet_length(wrap_tag) = 16),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (updated_at >= created_at)
);

CREATE INDEX encrypted_blobs_wrapping_key_version_idx
ON objects.encrypted_blobs (wrapping_key_version, blob_key);

CREATE FUNCTION objects.enforce_encrypted_blob_rewrap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.blob_key <> OLD.blob_key
       OR NEW.schema_version <> OLD.schema_version
       OR NEW.plaintext_size <> OLD.plaintext_size
       OR NEW.plaintext_sha256 <> OLD.plaintext_sha256
       OR NEW.ciphertext_size <> OLD.ciphertext_size
       OR NEW.ciphertext_sha256 <> OLD.ciphertext_sha256
       OR NEW.data_algorithm <> OLD.data_algorithm
       OR NEW.data_nonce <> OLD.data_nonce
       OR NEW.data_tag <> OLD.data_tag
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'immutable encrypted blob metadata cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'encrypted blob revision must advance by one'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.wrapping_key_version = OLD.wrapping_key_version THEN
        RAISE EXCEPTION 'rewrap must advance the wrapping-key version'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER encrypted_blob_rewrap_boundary
BEFORE UPDATE ON objects.encrypted_blobs
FOR EACH ROW EXECUTE FUNCTION objects.enforce_encrypted_blob_rewrap();
