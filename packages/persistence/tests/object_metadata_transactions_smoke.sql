\set ON_ERROR_STOP on
BEGIN;

INSERT INTO iam.identities (
    identity_kind, login_name, normalized_login_name, display_name, password_hash
) VALUES (
    'local_user', 'object-transaction-user', 'object-transaction-user',
    'Object Transaction User',
    '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
);

INSERT INTO objects.namespaces (namespace_key, quota_bytes)
VALUES ('user:object-transaction', 1048576), ('user:other-transaction', 1048576);

INSERT INTO objects.encrypted_blobs (
    blob_key, plaintext_size, plaintext_sha256, ciphertext_size, ciphertext_sha256,
    data_algorithm, data_nonce, data_tag, wrap_algorithm, wrapping_key_version,
    wrap_nonce, wrapped_data_key, wrap_tag
) VALUES
    ('objects/transaction-verified', 128, decode(repeat('11', 32), 'hex'),
     128, decode(repeat('21', 32), 'hex'), 'aes-256-gcm',
     decode(repeat('31', 12), 'hex'), decode(repeat('41', 16), 'hex'),
     'aes-256-gcm-keywrap', 1, decode(repeat('51', 12), 'hex'),
     decode(repeat('61', 32), 'hex'), decode(repeat('71', 16), 'hex')),
    ('objects/transaction-unverified', 64, decode(repeat('12', 32), 'hex'),
     64, decode(repeat('22', 32), 'hex'), 'aes-256-gcm',
     decode(repeat('32', 12), 'hex'), decode(repeat('42', 16), 'hex'),
     'aes-256-gcm-keywrap', 1, decode(repeat('52', 12), 'hex'),
     decode(repeat('62', 32), 'hex'), decode(repeat('72', 16), 'hex')),
    ('objects/transaction-orphan', 32, decode(repeat('13', 32), 'hex'),
     32, decode(repeat('23', 32), 'hex'), 'aes-256-gcm',
     decode(repeat('33', 12), 'hex'), decode(repeat('43', 16), 'hex'),
     'aes-256-gcm-keywrap', 1, decode(repeat('53', 12), 'hex'),
     decode(repeat('63', 32), 'hex'), decode(repeat('73', 16), 'hex')),
    ('objects/transaction-concurrent-winner', 48, decode(repeat('14', 32), 'hex'),
     48, decode(repeat('24', 32), 'hex'), 'aes-256-gcm',
     decode(repeat('34', 12), 'hex'), decode(repeat('44', 16), 'hex'),
     'aes-256-gcm-keywrap', 1, decode(repeat('54', 12), 'hex'),
     decode(repeat('64', 32), 'hex'), decode(repeat('74', 16), 'hex')),
    ('objects/transaction-concurrent-stale', 48, decode(repeat('15', 32), 'hex'),
     48, decode(repeat('25', 32), 'hex'), 'aes-256-gcm',
     decode(repeat('35', 12), 'hex'), decode(repeat('45', 16), 'hex'),
     'aes-256-gcm-keywrap', 1, decode(repeat('55', 12), 'hex'),
     decode(repeat('65', 32), 'hex'), decode(repeat('75', 16), 'hex'));

INSERT INTO objects.blob_claims (
    blob_key, namespace_key, claim_kind, claim_state, expected_size,
    expected_sha256, verified_at, expires_at
) VALUES
    ('objects/transaction-verified', 'user:object-transaction', 'object_candidate',
     'verified', 128, decode(repeat('11', 32), 'hex'), clock_timestamp(),
     clock_timestamp() + interval '1 hour'),
    ('objects/transaction-unverified', 'user:object-transaction', 'object_candidate',
     'staged', 64, decode(repeat('12', 32), 'hex'), NULL,
     clock_timestamp() + interval '1 hour'),
    ('objects/transaction-orphan', 'user:object-transaction', 'object_candidate',
     'staged', 32, decode(repeat('13', 32), 'hex'), NULL,
     clock_timestamp() - interval '1 second'),
    ('objects/transaction-concurrent-winner', 'user:object-transaction', 'object_candidate',
     'verified', 48, decode(repeat('14', 32), 'hex'), clock_timestamp(),
     clock_timestamp() + interval '1 hour'),
    ('objects/transaction-concurrent-stale', 'user:object-transaction', 'object_candidate',
     'verified', 48, decode(repeat('15', 32), 'hex'), clock_timestamp(),
     clock_timestamp() + interval '1 hour');

WITH actor AS (
    SELECT id FROM iam.identities WHERE normalized_login_name = 'object-transaction-user'
), object_entry AS (
    INSERT INTO objects.object_entries (namespace_key, object_key)
    VALUES ('user:object-transaction', 'files/verified.txt')
    RETURNING id
)
INSERT INTO objects.object_versions (
    object_id, version, blob_key, size, sha256, content_type,
    created_by_identity_id
)
SELECT object_entry.id, 1, 'objects/transaction-verified', 128,
       decode(repeat('11', 32), 'hex'), 'text/plain', actor.id
FROM object_entry CROSS JOIN actor;

DO $$
DECLARE
    actor_id uuid;
    target_object_id uuid;
    file_id uuid;
BEGIN
    SELECT id INTO actor_id
    FROM iam.identities WHERE normalized_login_name = 'object-transaction-user';
    SELECT id INTO target_object_id
    FROM objects.object_entries
    WHERE namespace_key = 'user:object-transaction'
      AND object_key = 'files/verified.txt';

    IF (SELECT current_version FROM objects.object_entries WHERE id = target_object_id) <> 1 THEN
        RAISE EXCEPTION 'object current version was not advanced atomically';
    END IF;
    IF (SELECT claim_state FROM objects.blob_claims
        WHERE blob_key = 'objects/transaction-verified') <> 'committed' THEN
        RAISE EXCEPTION 'verified blob claim was not committed atomically';
    END IF;

    BEGIN
        INSERT INTO objects.object_versions (
            object_id, version, blob_key, size, sha256, content_type,
            created_by_identity_id
        ) VALUES (
            target_object_id, 2, 'objects/transaction-unverified', 64,
            decode(repeat('12', 32), 'hex'), 'text/plain', actor_id
        );
        RAISE EXCEPTION 'expected unverified object-version rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    IF (SELECT current_version FROM objects.object_entries WHERE id = target_object_id) <> 1
       OR (SELECT count(*) FROM objects.object_versions WHERE object_id = target_object_id) <> 1 THEN
        RAISE EXCEPTION 'failed object transaction exposed a partial version';
    END IF;

    INSERT INTO objects.object_versions (
        object_id, version, blob_key, size, sha256, content_type,
        created_by_identity_id
    ) VALUES (
        target_object_id, 2, 'objects/transaction-concurrent-winner', 48,
        decode(repeat('14', 32), 'hex'), 'text/plain', actor_id
    );
    BEGIN
        INSERT INTO objects.object_versions (
            object_id, version, blob_key, size, sha256, content_type,
            created_by_identity_id
        ) VALUES (
            target_object_id, 2, 'objects/transaction-concurrent-stale', 48,
            decode(repeat('15', 32), 'hex'), 'text/plain', actor_id
        );
        RAISE EXCEPTION 'expected stale concurrent object-version rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    IF (SELECT current_version FROM objects.object_entries WHERE id = target_object_id) <> 2
       OR (SELECT count(*) FROM objects.object_versions WHERE object_id = target_object_id) <> 2
       OR (SELECT claim_state FROM objects.blob_claims
           WHERE blob_key = 'objects/transaction-concurrent-stale') <> 'verified' THEN
        RAISE EXCEPTION 'stale concurrent object version changed committed state';
    END IF;

    INSERT INTO objects.file_entries (
        namespace_key, file_path, owner_identity_id
    ) VALUES (
        'user:object-transaction', '/verified.txt', actor_id
    ) RETURNING id INTO file_id;
    INSERT INTO objects.file_versions (
        file_id, version, object_id, object_version, source_sha256,
        provenance, created_by_identity_id
    ) VALUES (
        file_id, 1, target_object_id, 1, decode(repeat('11', 32), 'hex'),
        '{"source":"object-transaction-smoke"}'::jsonb, actor_id
    );
    IF (SELECT current_version FROM objects.file_entries WHERE id = file_id) <> 1 THEN
        RAISE EXCEPTION 'file current version was not advanced atomically';
    END IF;

    INSERT INTO objects.file_entries (
        namespace_key, file_path, owner_identity_id
    ) VALUES (
        'user:other-transaction', '/cross-namespace.txt', actor_id
    ) RETURNING id INTO file_id;
    BEGIN
        INSERT INTO objects.file_versions (
            file_id, version, object_id, object_version, source_sha256,
            created_by_identity_id
        ) VALUES (
            file_id, 1, target_object_id, 1, decode(repeat('11', 32), 'hex'), actor_id
        );
        RAISE EXCEPTION 'expected cross-namespace file-version rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM objects.orphan_blob_candidates(clock_timestamp(), 10)
        WHERE blob_key = 'objects/transaction-orphan'
          AND reason = 'expired_uncommitted'
    ) THEN
        RAISE EXCEPTION 'expired uncommitted blob was not selected for reconciliation';
    END IF;
END;
$$;

ROLLBACK;
