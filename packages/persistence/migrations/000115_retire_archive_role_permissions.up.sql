-- Retire only archive grants. Preserve identities, role bindings, historical
-- permission definitions and credential/audit foreign keys.
DELETE FROM iam.role_permissions
WHERE permission_key IN ('backup:view', 'backup:manage');
