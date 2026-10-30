DROP TABLE platform.diagnostic_exports;
DROP TABLE platform.operational_alerts;
DROP TABLE platform.health_signals;
DROP TABLE platform.diagnostic_signals;

DELETE FROM iam.role_permissions
WHERE permission_key IN ('operations:view','operations:manage','diagnostic_sensitive:view');

DELETE FROM iam.permissions
WHERE permission_key IN ('operations:view','operations:manage','diagnostic_sensitive:view');
