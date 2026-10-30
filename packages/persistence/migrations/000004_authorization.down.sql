DROP TRIGGER service_account_grants_identity_kind ON iam.service_account_grants;
DROP TRIGGER role_bindings_identity_kind ON iam.role_bindings;
DROP FUNCTION iam.enforce_authorization_identity_kind();
DROP TABLE iam.service_account_grants;
DROP TABLE iam.role_bindings;
DROP TABLE iam.role_permissions;
DROP TABLE iam.role_scopes;
DROP TABLE iam.permissions;

DELETE FROM iam.roles
WHERE role_key IN (
    'owner', 'system_admin', 'compute_admin', 'application_admin',
    'team_admin', 'member', 'guest'
);

