\set ON_ERROR_STOP on
BEGIN;

INSERT INTO iam.identities (
    identity_kind, login_name, normalized_login_name, display_name, password_hash
) VALUES
    ('local_user', 'object-grant-user', 'object-grant-user', 'Object Grant User',
     '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'),
    ('local_user', 'object-grant-other', 'object-grant-other', 'Object Grant Other',
     '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'),
    ('service_account', 'object-grant-worker', 'object-grant-worker', 'Object Grant Worker', NULL);

INSERT INTO objects.namespaces (namespace_key, quota_bytes)
VALUES ('team:object-grants', 1048576), ('tenant:other-grants', 1048576);

INSERT INTO objects.namespace_bindings (
    namespace_key, identity_id, operations, granted_by_identity_id
)
SELECT 'team:object-grants', identity.id,
       '["read","write","list","reference:create","reference:revoke"]'::jsonb,
       identity.id
FROM iam.identities identity
WHERE identity.normalized_login_name = 'object-grant-user';

INSERT INTO objects.encrypted_blobs (
    blob_key, plaintext_size, plaintext_sha256, ciphertext_size, ciphertext_sha256,
    data_algorithm, data_nonce, data_tag, wrap_algorithm, wrapping_key_version,
    wrap_nonce, wrapped_data_key, wrap_tag
) VALUES (
    'objects/access-grant-smoke', 48, decode(repeat('14', 32), 'hex'),
    48, decode(repeat('24', 32), 'hex'), 'aes-256-gcm',
    decode(repeat('34', 12), 'hex'), decode(repeat('44', 16), 'hex'),
    'aes-256-gcm-keywrap', 1, decode(repeat('54', 12), 'hex'),
    decode(repeat('64', 32), 'hex'), decode(repeat('74', 16), 'hex')
);

INSERT INTO objects.blob_claims (
    blob_key, namespace_key, claim_kind, claim_state, expected_size,
    expected_sha256, verified_at, expires_at
) VALUES (
    'objects/access-grant-smoke', 'team:object-grants', 'object_candidate',
    'verified', 48, decode(repeat('14', 32), 'hex'), clock_timestamp(),
    clock_timestamp() + interval '1 hour'
);

WITH actor AS (
    SELECT id FROM iam.identities WHERE normalized_login_name = 'object-grant-user'
), entry AS (
    INSERT INTO objects.object_entries (namespace_key, object_key)
    VALUES ('team:object-grants', 'worker/input.bin')
    RETURNING id
)
INSERT INTO objects.object_versions (
    object_id, version, blob_key, size, sha256, content_type,
    created_by_identity_id
)
SELECT entry.id, 1, 'objects/access-grant-smoke', 48,
       decode(repeat('14', 32), 'hex'), 'application/octet-stream', actor.id
FROM entry CROSS JOIN actor;

WITH actor AS (
    SELECT id FROM iam.identities WHERE normalized_login_name = 'object-grant-user'
), object_version AS (
    SELECT entry.id
    FROM objects.object_entries entry
    WHERE entry.namespace_key = 'team:object-grants'
      AND entry.object_key = 'worker/input.bin'
)
INSERT INTO objects.access_grants (
    namespace_key, object_id, object_version, audience, operations,
    integrity_sha256, issued_by_identity_id, expires_at
)
SELECT 'team:object-grants', object_version.id, 1, 'worker:ocr-smoke',
       '["head","read"]'::jsonb, decode(repeat('14', 32), 'hex'), actor.id,
       clock_timestamp() + interval '10 minutes'
FROM actor CROSS JOIN object_version;

DO $$
DECLARE
    issuer_id uuid;
    other_id uuid;
    worker_id uuid;
    target_object_id uuid;
    grant_id uuid;
    access_event_id uuid;
BEGIN
    SELECT id INTO issuer_id FROM iam.identities
    WHERE normalized_login_name = 'object-grant-user';
    SELECT id INTO other_id FROM iam.identities
    WHERE normalized_login_name = 'object-grant-other';
    SELECT id INTO worker_id FROM iam.identities
    WHERE normalized_login_name = 'object-grant-worker';
    SELECT id INTO target_object_id FROM objects.object_entries
    WHERE namespace_key = 'team:object-grants' AND object_key = 'worker/input.bin';
    SELECT reference_id INTO grant_id FROM objects.access_grants;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'objects' AND table_name = 'access_grants'
          AND column_name ~ '(token|password|secret|access_key|credential)'
    ) THEN
        RAISE EXCEPTION 'object access grants contain permanent credential storage';
    END IF;
    IF (SELECT namespace_kind FROM objects.namespaces
        WHERE namespace_key = 'team:object-grants') <> 'team' THEN
        RAISE EXCEPTION 'namespace kind was not derived';
    END IF;

    INSERT INTO objects.access_events (
        reference_id, audience, namespace_key, object_id, object_version,
        operation, success
    ) VALUES (
        grant_id, 'worker:ocr-smoke', 'team:object-grants', target_object_id, 1,
        'read', true
    ) RETURNING event_id INTO access_event_id;
    UPDATE objects.access_grants
    SET use_count = use_count + 1, last_used_at = clock_timestamp()
    WHERE reference_id = grant_id;
    UPDATE objects.access_grants
    SET revoked_at = clock_timestamp(), revoked_by_identity_id = issuer_id,
        revoke_reason = 'smoke_revoke'
    WHERE reference_id = grant_id;
    IF (SELECT revoked_at FROM objects.access_grants WHERE reference_id = grant_id) IS NULL THEN
        RAISE EXCEPTION 'grant revocation was not persisted';
    END IF;

    BEGIN
        UPDATE objects.access_grants SET audience = 'worker:changed'
        WHERE reference_id = grant_id;
        RAISE EXCEPTION 'expected immutable grant rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO objects.access_grants (
            namespace_key, object_id, object_version, audience, operations,
            integrity_sha256, issued_by_identity_id, expires_at
        ) VALUES (
            'team:object-grants', target_object_id, 1, 'worker:too-long',
            '["head"]'::jsonb, decode(repeat('14', 32), 'hex'), issuer_id,
            clock_timestamp() + interval '16 minutes'
        );
        RAISE EXCEPTION 'expected long-lived grant rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO objects.access_grants (
            namespace_key, object_id, object_version, audience, operations,
            integrity_sha256, issued_by_identity_id, expires_at
        ) VALUES (
            'team:object-grants', target_object_id, 1, 'worker:self-issued',
            '["head"]'::jsonb, decode(repeat('14', 32), 'hex'), worker_id,
            clock_timestamp() + interval '1 minute'
        );
        RAISE EXCEPTION 'expected service-account issuer rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE objects.access_events SET operation = 'head'
        WHERE event_id = access_event_id;
        RAISE EXCEPTION 'expected append-only access event rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1 FROM iam.role_permissions permission
        JOIN iam.roles role ON role.id = permission.role_id
        WHERE role.role_key = 'team_admin'
          AND permission.permission_key = 'object_reference:revoke:any'
    ) THEN
        RAISE EXCEPTION 'team administrator lacks scoped grant revocation authority';
    END IF;
END;
$$;

ROLLBACK;
