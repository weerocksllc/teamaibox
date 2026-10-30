\set ON_ERROR_STOP on
BEGIN;

INSERT INTO plugins.verified_imports (
    plugin_key, plugin_type, version, source_kind, manifest,
    manifest_payload_sha256, manifest_signer_key_id,
    bundle_payload_sha256, bundle_signer_key_id,
    image_digests, artifacts, supply_chain, policy_version, verified_at
) VALUES (
    'example.lifecycle', 'ApplicationPlugin', '1.0.0', 'marketplace',
    '{"id":"example.lifecycle","type":"ApplicationPlugin","version":"1.0.0","signature":{"algorithm":"Ed25519"}}'::jsonb,
    decode(repeat('11', 32), 'hex'), 'example.publisher/release-2026',
    decode(repeat('22', 32), 'hex'), 'example.publisher/release-2026',
    ARRAY['sha256:' || repeat('a', 64)], '[]'::jsonb,
    '{"sbomDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","provenanceDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","vulnerabilityReportDigest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","vulnerabilityStatus":"passed","vulnerabilityScannedAt":"2026-08-11T00:00:00Z"}'::jsonb,
    1, '2026-08-11T00:00:00Z'
);

INSERT INTO plugins.plugins (
    plugin_key, plugin_type, publisher, protected, lifecycle_state
) VALUES (
    'example.lifecycle', 'application', 'example.publisher', false, 'discovered'
);

INSERT INTO plugins.plugin_versions (
    plugin_id, version, manifest, manifest_sha256, supply_chain_state,
    install_state, verified_import_id, slot, staged_at
)
SELECT plugin.id, '1.0.0',
       '{"id":"example.lifecycle","version":"1.0.0","health":{}}'::jsonb,
       decode(repeat('11', 32), 'hex'), 'verified', 'staging',
       verified.id, 'blue', '2026-08-11T00:00:00Z'
FROM plugins.plugins AS plugin
JOIN plugins.verified_imports AS verified
  ON verified.plugin_key = plugin.plugin_key AND verified.version = '1.0.0'
WHERE plugin.plugin_key = 'example.lifecycle';

INSERT INTO plugins.lifecycle_operations (
    plugin_id, operation_key, operation_kind, status, stage,
    from_version, to_version, created_at
)
SELECT id, 'install-smoke-001', 'install', 'running', 'staged',
       NULL, '1.0.0', '2026-08-11T00:00:00Z'
FROM plugins.plugins
WHERE plugin_key = 'example.lifecycle';

INSERT INTO plugins.migration_runs (
    plugin_id, plugin_version_id, lifecycle_operation_id,
    migration_id, sequence, migration_state, transactional, reversible
)
SELECT plugin.id, version.id, operation.id,
       '000001_initialize_data', 1, 'committed', true, true
FROM plugins.plugins AS plugin
JOIN plugins.plugin_versions AS version ON version.plugin_id = plugin.id AND version.version = '1.0.0'
JOIN plugins.lifecycle_operations AS operation ON operation.plugin_id = plugin.id AND operation.operation_key = 'install-smoke-001'
WHERE plugin.plugin_key = 'example.lifecycle';

INSERT INTO plugins.runtime_slots (
    plugin_id, slot, plugin_version_id, slot_state, health, generation
)
SELECT plugin.id, 'blue', version.id, 'active',
       '{"healthy":true,"consecutive":3}'::jsonb, 1
FROM plugins.plugins AS plugin
JOIN plugins.plugin_versions AS version ON version.plugin_id = plugin.id AND version.version = '1.0.0'
WHERE plugin.plugin_key = 'example.lifecycle';

UPDATE plugins.plugins AS target
SET current_version_id = version.id,
    lifecycle_state = 'enabled',
    active_slot = 'blue',
    generation = 1
FROM plugins.plugin_versions AS version
WHERE target.plugin_key = 'example.lifecycle'
  AND version.plugin_id = target.id
  AND version.version = '1.0.0';

UPDATE plugins.plugin_versions
SET install_state = 'healthy', activated_at = '2026-08-11T00:00:00Z',
    health = '{"healthy":true,"consecutive":3}'::jsonb
WHERE version = '1.0.0'
  AND plugin_id = (SELECT id FROM plugins.plugins WHERE plugin_key = 'example.lifecycle');

UPDATE plugins.lifecycle_operations
SET status = 'succeeded', stage = 'complete', completed_at = '2026-08-11T00:00:01Z',
    result = '{"currentVersion":"1.0.0","activeSlot":"blue"}'::jsonb
WHERE operation_key = 'install-smoke-001';

DO $smoke$
DECLARE
    lifecycle_plugin_id uuid;
BEGIN
    SELECT id INTO lifecycle_plugin_id FROM plugins.plugins WHERE plugin_key = 'example.lifecycle';
    IF NOT EXISTS (
        SELECT 1 FROM plugins.plugins
        WHERE id = lifecycle_plugin_id
          AND current_version_id IS NOT NULL
          AND active_slot = 'blue'
          AND generation = 1
    ) THEN
        RAISE EXCEPTION 'atomic plugin cutover was not retained: plugin=%, current=%, slot=%, generation=%',
            lifecycle_plugin_id,
            (SELECT current_version_id FROM plugins.plugins WHERE id = lifecycle_plugin_id),
            (SELECT active_slot FROM plugins.plugins WHERE id = lifecycle_plugin_id),
            (SELECT generation FROM plugins.plugins WHERE id = lifecycle_plugin_id);
    END IF;
    IF (SELECT slot_state FROM plugins.runtime_slots WHERE plugin_id = lifecycle_plugin_id AND slot = 'blue') <> 'active' THEN
        RAISE EXCEPTION 'active runtime slot was not retained';
    END IF;
    IF (SELECT migration_state FROM plugins.migration_runs WHERE plugin_id = lifecycle_plugin_id) <> 'committed' THEN
        RAISE EXCEPTION 'plugin migration state was not retained';
    END IF;
    UPDATE plugins.plugins
    SET current_version_id = NULL, active_slot = NULL, lifecycle_state = 'uninstalled', generation = generation + 1
    WHERE id = lifecycle_plugin_id;
    IF (SELECT data_retention_state FROM plugins.plugins WHERE id = lifecycle_plugin_id) <> 'retained'
       OR (SELECT count(*) FROM plugins.migration_runs WHERE plugin_id = lifecycle_plugin_id) <> 1 THEN
        RAISE EXCEPTION 'uninstall did not preserve data and migration evidence';
    END IF;
END
$smoke$;

ROLLBACK;
