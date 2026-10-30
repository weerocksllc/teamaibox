CREATE FUNCTION iam.valid_api_credential_scopes(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT CASE
        WHEN jsonb_typeof(value) <> 'array' THEN false
        WHEN jsonb_array_length(value) NOT BETWEEN 1 AND 32 THEN false
        ELSE NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(value) AS scope(item)
            WHERE jsonb_typeof(item) <> 'object'
               OR NOT item ?& ARRAY['permissionKey', 'resourceKind', 'resourceKey']
               OR item - ARRAY['permissionKey', 'resourceKind', 'resourceKey'] <> '{}'::jsonb
               OR jsonb_typeof(item -> 'permissionKey') <> 'string'
               OR jsonb_typeof(item -> 'resourceKind') <> 'string'
               OR jsonb_typeof(item -> 'resourceKey') <> 'string'
               OR item ->> 'permissionKey' !~ '^[a-z][a-z0-9_.-]{1,63}(:[a-z][a-z0-9_.-]{1,63})+$'
               OR item ->> 'resourceKind' !~ '^[a-z][a-z0-9_.-]{1,63}$'
               OR length(item ->> 'resourceKey') NOT BETWEEN 1 AND 256
               OR (item ->> 'resourceKind' = 'appliance' AND item ->> 'resourceKey' <> '*')
        ) AND (
            SELECT count(*) = count(DISTINCT item)
            FROM jsonb_array_elements(value) AS scope(item)
        )
    END;
$$;

CREATE TABLE iam.api_credentials (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    subject_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    credential_kind text NOT NULL CHECK (credential_kind IN ('developer', 'service')),
    display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
    token_hint text NOT NULL CHECK (token_hint ~ '^taib_sk_[A-Za-z0-9_-]{8}$'),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    scopes jsonb NOT NULL CHECK (iam.valid_api_credential_scopes(scopes)),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 128),
    CHECK (expires_at >= created_at + interval '5 minutes'),
    CHECK (
        (credential_kind = 'developer' AND expires_at <= created_at + interval '90 days')
        OR (credential_kind = 'service' AND expires_at <= created_at + interval '365 days')
    ),
    CHECK (last_used_at IS NULL OR last_used_at >= created_at),
    CHECK (
        (revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    )
);

CREATE INDEX api_credentials_subject_active_idx
ON iam.api_credentials (subject_identity_id, expires_at)
WHERE revoked_at IS NULL;

CREATE INDEX api_credentials_expiry_cleanup_idx
ON iam.api_credentials (expires_at);

CREATE FUNCTION iam.enforce_api_credential_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    subject_kind text;
    creator_kind text;
BEGIN
    SELECT identity_kind INTO subject_kind
    FROM iam.identities
    WHERE id = NEW.subject_identity_id;

    SELECT identity_kind INTO creator_kind
    FROM iam.identities
    WHERE id = NEW.created_by_identity_id;

    IF creator_kind <> 'local_user' THEN
        RAISE EXCEPTION 'credential creators must be local users'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.credential_kind = 'developer'
       AND (subject_kind <> 'local_user' OR NEW.subject_identity_id <> NEW.created_by_identity_id) THEN
        RAISE EXCEPTION 'developer credentials must be self-issued to a local user'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.credential_kind = 'service' AND subject_kind <> 'service_account' THEN
        RAISE EXCEPTION 'service credentials require a service account'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.scopes) AS scope(item)
        LEFT JOIN iam.permissions permission
          ON permission.permission_key = scope.item ->> 'permissionKey'
        WHERE permission.permission_key IS NULL
    ) THEN
        RAISE EXCEPTION 'credential scope references an unknown permission'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER api_credentials_boundary
BEFORE INSERT OR UPDATE OF subject_identity_id, credential_kind, scopes, created_by_identity_id
ON iam.api_credentials
FOR EACH ROW EXECUTE FUNCTION iam.enforce_api_credential_boundary();

INSERT INTO iam.permissions (permission_key, description_key) VALUES
    ('developer_credential:create', 'permissions.developer_credential_create');

INSERT INTO iam.roles (role_key, display_name_key, description_key, system_role) VALUES
    ('developer', 'roles.developer.name', 'roles.developer.description', true);

INSERT INTO iam.role_scopes (role_id, scope_kind)
SELECT id, 'appliance' FROM iam.roles WHERE role_key = 'developer';

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, permission.permission_key
FROM iam.roles role
JOIN iam.permissions permission ON permission.permission_key = 'developer_credential:create'
WHERE role.role_key = 'owner';

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, mapping.permission_key
FROM iam.roles role
JOIN (VALUES
    ('developer', 'application:catalog:view'), ('developer', 'ai:invoke'),
    ('developer', 'message:read'), ('developer', 'message:write'),
    ('developer', 'file:read'), ('developer', 'file:write'),
    ('developer', 'task:own:view'), ('developer', 'task:own:manage'),
    ('developer', 'team:view'), ('developer', 'model_studio:use'),
    ('developer', 'developer_credential:create')
) AS mapping(role_key, permission_key)
ON role.role_key = mapping.role_key;
