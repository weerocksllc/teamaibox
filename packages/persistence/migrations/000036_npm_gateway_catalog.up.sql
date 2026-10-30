CREATE TABLE source_center.npm_artifacts (
    id uuid PRIMARY KEY,
    package_name text NOT NULL CHECK (package_name ~ '^(?:@[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}|[a-z0-9][a-z0-9._-]{0,199})$'),
    package_version text NOT NULL,
    integrity text NOT NULL CHECK (integrity ~ '^sha512-[A-Za-z0-9+/]{86}==$'),
    sha256 bytea CHECK (sha256 IS NULL OR octet_length(sha256)=32),
    shasum text NOT NULL CHECK (shasum ~ '^[0-9a-f]{40}$'),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    source_id uuid NOT NULL REFERENCES source_center.sources(id) ON DELETE RESTRICT,
    source_kind text NOT NULL CHECK (source_kind IN ('hosted','proxy-cache','upstream','mirror','offline-media')),
    location_key text NOT NULL CHECK (length(location_key) BETWEEN 1 AND 512),
    upstream_url text CHECK (upstream_url IS NULL OR upstream_url ~ '^https://'),
    dependencies jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(dependencies)='object'),
    optional_dependencies jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(optional_dependencies)='object'),
    peer_dependencies jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(peer_dependencies)='object'),
    engines jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(engines)='object'),
    cpu text[] NOT NULL DEFAULT '{}',
    os text[] NOT NULL DEFAULT '{}',
    has_install_script boolean NOT NULL DEFAULT false,
    deprecated text,
    signature_status text NOT NULL CHECK (signature_status IN ('verified','unsigned','invalid','not-available')),
    scan_status text NOT NULL CHECK (scan_status IN ('pending','passed','failed')),
    license text,
    cached_at timestamptz,
    imported_at timestamptz NOT NULL,
    UNIQUE (source_id,package_name,package_version),
    UNIQUE (location_key),
    CHECK ((source_kind IN ('upstream','mirror','proxy-cache')) = (upstream_url IS NOT NULL)),
    CHECK (source_kind IN ('upstream','mirror','proxy-cache') OR sha256 IS NOT NULL)
);

CREATE INDEX npm_artifacts_package_route_idx ON source_center.npm_artifacts (package_name,package_version,source_id);
CREATE INDEX npm_artifacts_offline_idx ON source_center.npm_artifacts (package_name,package_version) WHERE cached_at IS NOT NULL AND scan_status='passed' AND signature_status<>'invalid';
