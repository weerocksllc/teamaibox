INSERT INTO iam.permissions (permission_key, description_key)
VALUES ('file:share', 'permissions.file_share');

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, 'file:share'
FROM iam.roles role
WHERE role.role_key IN ('owner', 'team_admin');
