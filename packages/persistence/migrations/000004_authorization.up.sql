CREATE TABLE iam.permissions (
    permission_key text PRIMARY KEY CHECK (
        permission_key ~ '^[a-z][a-z0-9_.-]{1,63}(:[a-z][a-z0-9_.-]{1,63})+$'
    ),
    description_key text NOT NULL CHECK (length(description_key) BETWEEN 1 AND 256),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE iam.role_scopes (
    role_id uuid NOT NULL REFERENCES iam.roles(id) ON DELETE CASCADE,
    scope_kind text NOT NULL CHECK (scope_kind IN ('appliance', 'team')),
    PRIMARY KEY (role_id, scope_kind)
);

CREATE TABLE iam.role_permissions (
    role_id uuid NOT NULL REFERENCES iam.roles(id) ON DELETE CASCADE,
    permission_key text NOT NULL REFERENCES iam.permissions(permission_key) ON DELETE RESTRICT,
    PRIMARY KEY (role_id, permission_key)
);

CREATE INDEX role_permissions_permission_idx
ON iam.role_permissions (permission_key, role_id);

CREATE TABLE iam.role_bindings (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    role_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
    granted_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz,
    FOREIGN KEY (role_id, scope_kind)
        REFERENCES iam.role_scopes(role_id, scope_kind) ON DELETE RESTRICT,
    UNIQUE (identity_id, role_id, scope_kind, scope_key),
    CHECK (
        (scope_kind = 'appliance' AND scope_key = '*')
        OR (scope_kind = 'team' AND scope_key <> '*')
    ),
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE INDEX role_bindings_identity_active_idx
ON iam.role_bindings (identity_id, scope_kind, scope_key, expires_at);

CREATE TABLE iam.service_account_grants (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    permission_key text NOT NULL REFERENCES iam.permissions(permission_key) ON DELETE RESTRICT,
    resource_kind text NOT NULL CHECK (resource_kind ~ '^[a-z][a-z0-9_.-]{1,63}$'),
    resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 256),
    granted_by uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 128),
    UNIQUE (identity_id, permission_key, resource_kind, resource_key),
    CHECK (expires_at > granted_at),
    CHECK (
        (resource_kind = 'appliance' AND resource_key = '*')
        OR resource_kind <> 'appliance'
    ),
    CHECK (
        (revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    )
);

CREATE INDEX service_account_grants_active_idx
ON iam.service_account_grants (identity_id, resource_kind, resource_key, expires_at)
WHERE revoked_at IS NULL;

CREATE FUNCTION iam.enforce_authorization_identity_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_kind text;
BEGIN
    SELECT identity_kind INTO actual_kind
    FROM iam.identities
    WHERE id = NEW.identity_id;

    IF TG_TABLE_NAME = 'service_account_grants' AND actual_kind <> 'service_account' THEN
        RAISE EXCEPTION 'service grants require a service account'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_TABLE_NAME = 'role_bindings' AND actual_kind <> 'local_user' THEN
        RAISE EXCEPTION 'role bindings require a local user'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER role_bindings_identity_kind
BEFORE INSERT OR UPDATE OF identity_id ON iam.role_bindings
FOR EACH ROW EXECUTE FUNCTION iam.enforce_authorization_identity_kind();

CREATE TRIGGER service_account_grants_identity_kind
BEFORE INSERT OR UPDATE OF identity_id ON iam.service_account_grants
FOR EACH ROW EXECUTE FUNCTION iam.enforce_authorization_identity_kind();

INSERT INTO iam.permissions (permission_key, description_key) VALUES
    ('application:catalog:view', 'permissions.application_catalog_view'),
    ('application:catalog:manage', 'permissions.application_catalog_manage'),
    ('ai:invoke', 'permissions.ai_invoke'),
    ('audit:view', 'permissions.audit_view'),
    ('backup:view', 'permissions.backup_view'),
    ('backup:manage', 'permissions.backup_manage'),
    ('file:read', 'permissions.file_read'),
    ('file:write', 'permissions.file_write'),
    ('file:manage', 'permissions.file_manage'),
    ('identity:view', 'permissions.identity_view'),
    ('identity:manage', 'permissions.identity_manage'),
    ('message:read', 'permissions.message_read'),
    ('message:write', 'permissions.message_write'),
    ('message:manage', 'permissions.message_manage'),
    ('model:view', 'permissions.model_view'),
    ('model:manage', 'permissions.model_manage'),
    ('model_studio:use', 'permissions.model_studio_use'),
    ('node:view', 'permissions.node_view'),
    ('node:manage', 'permissions.node_manage'),
    ('plugin:view', 'permissions.plugin_view'),
    ('plugin:manage', 'permissions.plugin_manage'),
    ('provider:view', 'permissions.provider_view'),
    ('provider:manage', 'permissions.provider_manage'),
    ('queue:view', 'permissions.queue_view'),
    ('queue:manage', 'permissions.queue_manage'),
    ('resource_policy:view', 'permissions.resource_policy_view'),
    ('resource_policy:manage', 'permissions.resource_policy_manage'),
    ('role:view', 'permissions.role_view'),
    ('role:manage', 'permissions.role_manage'),
    ('security:view', 'permissions.security_view'),
    ('security:manage', 'permissions.security_manage'),
    ('service_credential:manage', 'permissions.service_credential_manage'),
    ('source:view', 'permissions.source_view'),
    ('source:manage', 'permissions.source_manage'),
    ('storage:view', 'permissions.storage_view'),
    ('storage:manage', 'permissions.storage_manage'),
    ('task:own:view', 'permissions.task_own_view'),
    ('task:own:manage', 'permissions.task_own_manage'),
    ('team:view', 'permissions.team_view'),
    ('team:manage', 'permissions.team_manage'),
    ('update:view', 'permissions.update_view'),
    ('update:manage', 'permissions.update_manage');

INSERT INTO iam.roles (role_key, display_name_key, description_key, system_role) VALUES
    ('owner', 'roles.owner.name', 'roles.owner.description', true),
    ('system_admin', 'roles.system_admin.name', 'roles.system_admin.description', true),
    ('compute_admin', 'roles.compute_admin.name', 'roles.compute_admin.description', true),
    ('application_admin', 'roles.application_admin.name', 'roles.application_admin.description', true),
    ('team_admin', 'roles.team_admin.name', 'roles.team_admin.description', true),
    ('member', 'roles.member.name', 'roles.member.description', true),
    ('guest', 'roles.guest.name', 'roles.guest.description', true);

INSERT INTO iam.role_scopes (role_id, scope_kind)
SELECT id, 'appliance' FROM iam.roles
WHERE role_key IN ('owner', 'system_admin', 'compute_admin', 'application_admin', 'team_admin', 'member', 'guest');

INSERT INTO iam.role_scopes (role_id, scope_kind)
SELECT id, 'team' FROM iam.roles
WHERE role_key IN ('team_admin', 'member', 'guest');

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, permission.permission_key
FROM iam.roles role
CROSS JOIN iam.permissions permission
WHERE role.role_key = 'owner';

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, mapping.permission_key
FROM iam.roles role
JOIN (VALUES
    ('system_admin', 'identity:view'), ('system_admin', 'identity:manage'),
    ('system_admin', 'role:view'), ('system_admin', 'role:manage'),
    ('system_admin', 'service_credential:manage'),
    ('system_admin', 'security:view'), ('system_admin', 'security:manage'),
    ('system_admin', 'storage:view'), ('system_admin', 'storage:manage'),
    ('system_admin', 'source:view'), ('system_admin', 'source:manage'),
    ('system_admin', 'backup:view'), ('system_admin', 'backup:manage'),
    ('system_admin', 'update:view'), ('system_admin', 'update:manage'),
    ('system_admin', 'audit:view'), ('system_admin', 'node:view'),
    ('system_admin', 'application:catalog:view'),

    ('compute_admin', 'application:catalog:view'), ('compute_admin', 'ai:invoke'),
    ('compute_admin', 'message:read'), ('compute_admin', 'message:write'),
    ('compute_admin', 'file:read'), ('compute_admin', 'file:write'),
    ('compute_admin', 'task:own:view'), ('compute_admin', 'task:own:manage'),
    ('compute_admin', 'team:view'), ('compute_admin', 'node:view'),
    ('compute_admin', 'node:manage'), ('compute_admin', 'resource_policy:view'),
    ('compute_admin', 'resource_policy:manage'), ('compute_admin', 'model:view'),
    ('compute_admin', 'model:manage'), ('compute_admin', 'model_studio:use'),
    ('compute_admin', 'queue:view'), ('compute_admin', 'queue:manage'),
    ('compute_admin', 'provider:view'), ('compute_admin', 'provider:manage'),
    ('compute_admin', 'audit:view'),

    ('application_admin', 'application:catalog:view'),
    ('application_admin', 'application:catalog:manage'),
    ('application_admin', 'ai:invoke'),
    ('application_admin', 'message:read'), ('application_admin', 'message:write'),
    ('application_admin', 'file:read'), ('application_admin', 'file:write'),
    ('application_admin', 'task:own:view'), ('application_admin', 'task:own:manage'),
    ('application_admin', 'team:view'), ('application_admin', 'plugin:view'),
    ('application_admin', 'plugin:manage'), ('application_admin', 'audit:view'),

    ('team_admin', 'application:catalog:view'), ('team_admin', 'ai:invoke'),
    ('team_admin', 'message:read'), ('team_admin', 'message:write'),
    ('team_admin', 'message:manage'), ('team_admin', 'file:read'),
    ('team_admin', 'file:write'), ('team_admin', 'file:manage'),
    ('team_admin', 'task:own:view'), ('team_admin', 'task:own:manage'),
    ('team_admin', 'team:view'), ('team_admin', 'team:manage'),

    ('member', 'application:catalog:view'), ('member', 'ai:invoke'),
    ('member', 'message:read'), ('member', 'message:write'),
    ('member', 'file:read'), ('member', 'file:write'),
    ('member', 'task:own:view'), ('member', 'task:own:manage'),
    ('member', 'team:view'),

    ('guest', 'application:catalog:view'), ('guest', 'message:read'),
    ('guest', 'file:read'), ('guest', 'team:view')
) AS mapping(role_key, permission_key)
ON role.role_key = mapping.role_key;

INSERT INTO iam.role_bindings (
    identity_id, role_id, scope_kind, scope_key, granted_by, granted_at, expires_at
)
SELECT identity_role.identity_id, identity_role.role_id, 'appliance', '*',
       identity_role.granted_by, identity_role.granted_at, identity_role.expires_at
FROM iam.identity_roles identity_role
JOIN iam.role_scopes role_scope
  ON role_scope.role_id = identity_role.role_id
 AND role_scope.scope_kind = 'appliance';

