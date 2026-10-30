\set ON_ERROR_STOP on
BEGIN;

WITH local_user AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name, password_hash
    ) VALUES (
        'local_user', 'authorization-user', 'authorization-user', 'Authorization User',
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdC1vbmx5LXNhbHQ$dGVzdC1vbmx5LWhhc2g'
    ) RETURNING id
), role_binding AS (
    INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key)
    SELECT local_user.id, role.id, 'team', 'team-alpha'
    FROM local_user
    JOIN iam.roles role ON role.role_key = 'team_admin'
    RETURNING id
), service_account AS (
    INSERT INTO iam.identities (
        identity_kind, login_name, normalized_login_name, display_name
    ) VALUES (
        'service_account', 'authorization-worker', 'authorization-worker', 'Authorization Worker'
    ) RETURNING id
), service_grant AS (
    INSERT INTO iam.service_account_grants (
        identity_id, permission_key, resource_kind, resource_key, expires_at
    )
    SELECT id, 'ai:invoke', 'team', 'team-alpha', clock_timestamp() + interval '1 hour'
    FROM service_account
    RETURNING id
)
SELECT 1;

DO $$
DECLARE
    local_id uuid;
    service_id uuid;
    expected_permissions constant text[] := ARRAY[
        'application:catalog:view',
        'application:catalog:manage',
        'ai:invoke',
        'audit:view',
        'cast:use',
        'cast:share',
        'cast:view',
        'cast:manage',
        'developer_credential:create',
        'diagnostic_sensitive:view',
        'file:read',
        'file:write',
        'file:share',
        'file:manage',
        'identity:view',
        'identity:manage',
        'message:read',
        'message:write',
        'message:manage',
        'model:view',
        'model:manage',
        'node:view',
        'node:manage',
        'object_reference:revoke:any',
        'operations:view',
        'operations:manage',
        'phone:use',
        'phone:manage',
        'computer:use',
        'computer:manage',
        'plugin:view',
        'plugin:manage',
        'provider:view',
        'provider:manage',
        'queue:view',
        'queue:manage',
        'resource_policy:view',
        'resource_policy:manage',
        'role:view',
        'role:manage',
        'security:view',
        'security:manage',
        'service_credential:manage',
        'source:view',
        'source:manage',
        'storage:view',
        'storage:manage',
        'task:own:view',
        'task:own:manage',
        'team:view',
        'team:manage',
        'update:view',
        'update:manage'
    ];
    actual_permissions text[];
    sorted_expected_permissions text[];
    owner_permissions text[];
BEGIN
    SELECT id INTO local_id FROM iam.identities WHERE normalized_login_name = 'authorization-user';
    SELECT id INTO service_id FROM iam.identities WHERE normalized_login_name = 'authorization-worker';

    SELECT array_agg(permission_key ORDER BY permission_key)
      INTO actual_permissions
      FROM iam.permissions WHERE permission_key NOT IN ('backup:view','backup:manage');
    SELECT array_agg(permission_key ORDER BY permission_key)
      INTO sorted_expected_permissions
      FROM unnest(expected_permissions) AS permission_key;
    IF actual_permissions IS DISTINCT FROM sorted_expected_permissions THEN
        RAISE EXCEPTION 'permission catalog differs from the canonical authorization catalog';
    END IF;
    SELECT array_agg(role_permission.permission_key ORDER BY role_permission.permission_key)
      INTO owner_permissions
      FROM iam.role_permissions role_permission
      JOIN iam.roles role ON role.id = role_permission.role_id
     WHERE role.role_key = 'owner';
    IF owner_permissions IS DISTINCT FROM sorted_expected_permissions THEN
        RAISE EXCEPTION 'owner does not have the complete permission catalog';
    END IF;
    IF (SELECT count(*) FROM iam.role_bindings WHERE identity_id = local_id) <> 1 THEN
        RAISE EXCEPTION 'team role binding was not persisted';
    END IF;
    IF (SELECT count(*) FROM iam.service_account_grants WHERE identity_id = service_id) <> 1 THEN
        RAISE EXCEPTION 'service-account grant was not persisted';
    END IF;

    BEGIN
        INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key)
        SELECT service_id, id, 'appliance', '*' FROM iam.roles WHERE role_key = 'owner';
        RAISE EXCEPTION 'expected service-account role rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO iam.service_account_grants (
            identity_id, permission_key, resource_kind, resource_key, expires_at
        ) VALUES (
            local_id, 'ai:invoke', 'appliance', '*', clock_timestamp() + interval '1 hour'
        );
        RAISE EXCEPTION 'expected local-user service-grant rejection';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO iam.role_bindings (identity_id, role_id, scope_kind, scope_key)
        SELECT local_id, id, 'team', 'team-beta' FROM iam.roles WHERE role_key = 'compute_admin';
        RAISE EXCEPTION 'expected invalid administrative scope rejection';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
END;
$$;

ROLLBACK;
