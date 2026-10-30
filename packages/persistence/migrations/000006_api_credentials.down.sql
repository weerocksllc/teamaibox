DELETE FROM iam.role_permissions
WHERE role_id = (SELECT id FROM iam.roles WHERE role_key = 'owner')
  AND permission_key = 'developer_credential:create';

DELETE FROM iam.roles WHERE role_key = 'developer';

DELETE FROM iam.permissions WHERE permission_key = 'developer_credential:create';

DROP TRIGGER api_credentials_boundary ON iam.api_credentials;
DROP FUNCTION iam.enforce_api_credential_boundary();
DROP TABLE iam.api_credentials;
DROP FUNCTION iam.valid_api_credential_scopes(jsonb);
