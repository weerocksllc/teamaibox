-- Retire execution and grants, retaining existing records for recovery/audit.
-- Earlier migrations are immutable installation history, not active features.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM compute.jobs j JOIN compute.capabilities c ON c.id = j.capability_id
        WHERE c.modality = 'fine_tuning' AND j.status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'incomplete')
    ) THEN
        RAISE EXCEPTION 'Retired application still has unfinished jobs; resolve them before migration';
    END IF;
END;
$$;

UPDATE iam.api_credentials SET revoked_at = clock_timestamp(), revoke_reason = 'application_removed'
WHERE revoked_at IS NULL AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(scopes) scope
    WHERE scope->>'permissionKey' = 'model_studio:use'
);
DELETE FROM iam.role_permissions WHERE permission_key = 'model_studio:use';
DELETE FROM iam.service_account_grants WHERE permission_key = 'model_studio:use';
DELETE FROM iam.permissions WHERE permission_key = 'model_studio:use';

UPDATE iam.identities SET status = 'disabled', disabled_at = clock_timestamp()
WHERE normalized_login_name = 'current-model-studio-bootstrap' AND status <> 'disabled';

UPDATE plugins.runtime_slots SET slot_state = 'retired'
WHERE plugin_id IN (SELECT id FROM plugins.plugins WHERE plugin_key = 'official.model-studio');
UPDATE plugins.plugin_versions SET install_state = 'retired'
WHERE plugin_id IN (SELECT id FROM plugins.plugins WHERE plugin_key = 'official.model-studio');
UPDATE plugins.plugins SET lifecycle_state = 'uninstalled', current_version_id = NULL,
    active_slot = NULL, protected = false
WHERE plugin_key = 'official.model-studio';

UPDATE compute.capabilities SET lifecycle_state = 'retired', api_operations = '[]'::jsonb
WHERE modality = 'fine_tuning';
ALTER TABLE compute.capabilities ADD CONSTRAINT office_supported_modalities
    CHECK (modality <> 'fine_tuning') NOT VALID;
