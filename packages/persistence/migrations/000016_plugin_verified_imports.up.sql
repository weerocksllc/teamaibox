CREATE TABLE plugins.verified_imports (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    plugin_key text NOT NULL CHECK (plugin_key ~ '^[a-z][a-z0-9.-]{2,127}$'),
    plugin_type text NOT NULL CHECK (plugin_type IN ('ApplicationPlugin', 'ComputePlugin')),
    version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$'),
    source_kind text NOT NULL CHECK (
        source_kind IN ('marketplace', 'private-registry', 'offline-bundle')
    ),
    manifest jsonb NOT NULL CHECK (
        jsonb_typeof(manifest) = 'object'
        AND manifest->>'id' = plugin_key
        AND manifest->>'type' = plugin_type
        AND manifest->>'version' = version
        AND jsonb_typeof(manifest->'signature') = 'object'
    ),
    manifest_payload_sha256 bytea NOT NULL CHECK (octet_length(manifest_payload_sha256) = 32),
    manifest_signer_key_id text NOT NULL CHECK (
        manifest_signer_key_id ~ '^[a-z][a-z0-9.-]{2,127}/[A-Za-z0-9._:-]{1,128}$'
    ),
    bundle_payload_sha256 bytea NOT NULL CHECK (octet_length(bundle_payload_sha256) = 32),
    bundle_signer_key_id text NOT NULL CHECK (
        bundle_signer_key_id ~ '^[a-z][a-z0-9.-]{2,127}/[A-Za-z0-9._:-]{1,128}$'
    ),
    image_digests text[] NOT NULL CHECK (
        cardinality(image_digests) > 0
        AND array_position(image_digests, NULL) IS NULL
    ),
    artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts) = 'array'),
    supply_chain jsonb NOT NULL CHECK (
        jsonb_typeof(supply_chain) = 'object'
        AND supply_chain ?& ARRAY[
            'sbomDigest', 'provenanceDigest', 'vulnerabilityReportDigest',
            'vulnerabilityStatus', 'vulnerabilityScannedAt'
        ]
        AND supply_chain->>'vulnerabilityStatus' = 'passed'
    ),
    policy_version integer NOT NULL CHECK (policy_version > 0),
    state text NOT NULL DEFAULT 'verified' CHECK (state = 'verified'),
    verified_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (plugin_key, version),
    UNIQUE (bundle_payload_sha256)
);

CREATE INDEX verified_imports_verified_at_idx
ON plugins.verified_imports (verified_at DESC);

CREATE INDEX verified_imports_image_digests_idx
ON plugins.verified_imports USING gin (image_digests);
