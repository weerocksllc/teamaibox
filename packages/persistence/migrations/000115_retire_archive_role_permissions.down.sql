INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM iam.roles r CROSS JOIN iam.permissions p
WHERE r.role_key IN ('owner', 'system_admin') AND r.system_role
  AND p.permission_key IN ('backup:view', 'backup:manage')
ON CONFLICT DO NOTHING;
