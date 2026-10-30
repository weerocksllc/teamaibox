\set ON_ERROR_STOP on
BEGIN;

INSERT INTO plugins.verified_imports (
    plugin_key, plugin_type, version, source_kind, manifest,
    manifest_payload_sha256, manifest_signer_key_id,
    bundle_payload_sha256, bundle_signer_key_id,
    image_digests, artifacts, supply_chain, policy_version, verified_at
) VALUES (
    'example.team-notes', 'ApplicationPlugin', '1.2.3', 'offline-bundle',
    '{"apiVersion":"teamaibox.io/plugin/v1","id":"example.team-notes","type":"ApplicationPlugin","version":"1.2.3","signature":{"algorithm":"Ed25519"}}'::jsonb,
    decode(repeat('11', 32), 'hex'), 'example.publisher/release-2026',
    decode(repeat('22', 32), 'hex'), 'example.publisher/release-2026',
    ARRAY['sha256:' || repeat('a', 64)],
    '[{"name":"image-notes-app","kind":"oci-image-manifest","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
    '{"sbomDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","provenanceDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","vulnerabilityReportDigest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","vulnerabilityStatus":"passed","vulnerabilityScannedAt":"2026-08-11T00:00:00Z"}'::jsonb,
    1, '2026-08-11T00:00:00Z'
);

DO $smoke$
BEGIN
    IF (SELECT count(*) FROM plugins.verified_imports WHERE plugin_key = 'example.team-notes') <> 1 THEN
        RAISE EXCEPTION 'verified plugin import was not retained';
    END IF;
    IF (SELECT source_kind FROM plugins.verified_imports WHERE plugin_key = 'example.team-notes') <> 'offline-bundle' THEN
        RAISE EXCEPTION 'verified plugin source kind was not retained';
    END IF;
    IF (SELECT supply_chain->>'vulnerabilityStatus' FROM plugins.verified_imports WHERE plugin_key = 'example.team-notes') <> 'passed' THEN
        RAISE EXCEPTION 'passing vulnerability evidence was not retained';
    END IF;
    BEGIN
        INSERT INTO plugins.verified_imports (
            plugin_key, plugin_type, version, source_kind, manifest,
            manifest_payload_sha256, manifest_signer_key_id,
            bundle_payload_sha256, bundle_signer_key_id,
            image_digests, artifacts, supply_chain, policy_version, verified_at
        )
        SELECT plugin_key, plugin_type, version, source_kind, manifest,
               decode(repeat('33', 32), 'hex'), manifest_signer_key_id,
               decode(repeat('44', 32), 'hex'), bundle_signer_key_id,
               image_digests, artifacts, supply_chain, policy_version, verified_at
        FROM plugins.verified_imports
        WHERE plugin_key = 'example.team-notes';
        RAISE EXCEPTION 'expected immutable plugin version conflict';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$smoke$;

ROLLBACK;
