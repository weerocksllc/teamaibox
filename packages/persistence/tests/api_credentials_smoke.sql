\set ON_ERROR_STOP on
BEGIN;

WITH developer AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'credential-developer', 'credential-developer', 'Credential Developer',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), service_account AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name
    ) VALUES (
        'service_account', 'credential-worker', 'credential-worker', 'Credential Worker'
    ) RETURNING id
), developer_credential AS (
    INSERT INTO iam.api_credentials (
        subject_identity_id, credential_kind, display_name, token_hint, token_hash,
        scopes, created_by_identity_id, expires_at
    )
    SELECT developer.id, 'developer', 'Local CLI', 'taib_sk_abcdefgh',
           decode(repeat('11', 32), 'hex'),
           '[{"permissionKey":"ai:invoke","resourceKind":"appliance","resourceKey":"*"}]'::jsonb,
           developer.id, clock_timestamp() + interval '1 hour'
    FROM developer
    RETURNING id
), service_credential AS (
    INSERT INTO iam.api_credentials (
        subject_identity_id, credential_kind, display_name, token_hint, token_hash,
        scopes, created_by_identity_id, expires_at
    )
    SELECT service_account.id, 'service', 'Compute Worker', 'taib_sk_ijklmnop',
           decode(repeat('22', 32), 'hex'),
           '[{"permissionKey":"ai:invoke","resourceKind":"appliance","resourceKey":"*"}]'::jsonb,
           developer.id, clock_timestamp() + interval '1 hour'
    FROM service_account CROSS JOIN developer
    RETURNING id
), service_grant AS (
    INSERT INTO iam.service_account_grants (
        identity_id, permission_key, resource_kind, resource_key, granted_by, expires_at
    )
    SELECT service_account.id, 'ai:invoke', 'appliance', '*', developer.id,
           clock_timestamp() + interval '1 hour'
    FROM service_account CROSS JOIN developer
    RETURNING id
)
SELECT 1;

DO $$
DECLARE
    developer_id uuid;
    service_id uuid;
BEGIN
    SELECT id INTO developer_id FROM iam.identities WHERE normalized_login_name = 'credential-developer';
    SELECT id INTO service_id FROM iam.identities WHERE normalized_login_name = 'credential-worker';

    IF (SELECT count(*) FROM iam.api_credentials) <> 2 THEN
        RAISE EXCEPTION 'credentials were not persisted';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'iam' AND table_name = 'api_credentials'
          AND column_name ~ '(secret|plaintext|raw_token)'
    ) THEN
        RAISE EXCEPTION 'credential table exposes plaintext-secret storage';
    END IF;
    IF (SELECT octet_length(token_hash) FROM iam.api_credentials LIMIT 1) <> 32 THEN
        RAISE EXCEPTION 'credential digest length is invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM iam.role_permissions role_permission
        JOIN iam.roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'developer'
          AND role_permission.permission_key = 'developer_credential:create'
    ) THEN
        RAISE EXCEPTION 'developer role is missing credential authority';
    END IF;
    IF EXISTS (
        SELECT 1 FROM iam.role_permissions role_permission
        JOIN iam.roles role ON role.id = role_permission.role_id
        WHERE role.role_key = 'member'
          AND role_permission.permission_key = 'developer_credential:create'
    ) THEN
        RAISE EXCEPTION 'ordinary member received credential authority';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM iam.service_account_grants
        WHERE identity_id = service_id
          AND permission_key = 'ai:invoke'
          AND resource_kind = 'appliance'
          AND resource_key = '*'
          AND revoked_at IS NULL
          AND expires_at > clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'service account is missing compute authority';
    END IF;
    IF position('service_grant.permission_key = ''ai:invoke''' IN
        pg_get_functiondef('objects.enforce_access_grant_boundary()'::regprocedure)) = 0
       OR position('service_grant.revoked_at IS NULL' IN
        pg_get_functiondef('objects.enforce_access_grant_boundary()'::regprocedure)) = 0
       OR position('service_grant.expires_at > NEW.created_at' IN
        pg_get_functiondef('objects.enforce_access_grant_boundary()'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'service compute object-reference boundary is missing';
    END IF;

    BEGIN
        INSERT INTO iam.api_credentials (
            subject_identity_id, credential_kind, display_name, token_hint, token_hash,
            scopes, created_by_identity_id, expires_at
        ) VALUES (
            service_id, 'developer', 'Invalid', 'taib_sk_qrstuvwx',
            decode(repeat('33', 32), 'hex'),
            '[{"permissionKey":"ai:invoke","resourceKind":"appliance","resourceKey":"*"}]'::jsonb,
            developer_id, clock_timestamp() + interval '1 hour'
        );
        RAISE EXCEPTION 'expected developer subject rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO iam.api_credentials (
            subject_identity_id, credential_kind, display_name, token_hint, token_hash,
            scopes, created_by_identity_id, expires_at
        ) VALUES (
            developer_id, 'developer', 'Invalid scope', 'taib_sk_yzabcdef',
            decode(repeat('44', 32), 'hex'),
            '[{"permissionKey":"unknown:permission","resourceKind":"appliance","resourceKey":"*"}]'::jsonb,
            developer_id, clock_timestamp() + interval '1 hour'
        );
        RAISE EXCEPTION 'expected unknown permission rejection';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO iam.api_credentials (
            subject_identity_id, credential_kind, display_name, token_hint, token_hash,
            scopes, created_by_identity_id, expires_at
        ) VALUES (
            developer_id, 'developer', 'Too long', 'taib_sk_ghijklmn',
            decode(repeat('55', 32), 'hex'),
            '[{"permissionKey":"ai:invoke","resourceKind":"appliance","resourceKey":"*"}]'::jsonb,
            developer_id, clock_timestamp() + interval '91 days'
        );
        RAISE EXCEPTION 'expected expiry rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;
