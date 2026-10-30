CREATE TABLE source_center.pip_artifacts (
    id uuid PRIMARY KEY,
    project text NOT NULL CHECK (project ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    package_version text NOT NULL CHECK (package_version ~ '^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,127}$'),
    filename text NOT NULL CHECK (filename ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$'),
    sha256 bytea NOT NULL CHECK (octet_length(sha256)=32),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    source_id uuid NOT NULL REFERENCES source_center.sources(id) ON DELETE RESTRICT,
    source_kind text NOT NULL CHECK (source_kind IN ('hosted','proxy-cache','upstream','mirror','offline-media')),
    location_key text NOT NULL CHECK (length(location_key) BETWEEN 1 AND 512),
    upstream_url text CHECK (upstream_url IS NULL OR upstream_url ~ '^https://'),
    requires_python text,
    dependencies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dependencies)='array'),
    architectures text[] NOT NULL CHECK (cardinality(architectures) BETWEEN 1 AND 8),
    yanked_reason text,
    core_metadata_sha256 bytea CHECK (core_metadata_sha256 IS NULL OR octet_length(core_metadata_sha256)=32),
    signature_status text NOT NULL CHECK (signature_status IN ('verified','unsigned','invalid','not-available')),
    scan_status text NOT NULL CHECK (scan_status IN ('pending','passed','failed')),
    license text,
    cached_at timestamptz,
    imported_at timestamptz NOT NULL,
    UNIQUE (source_id,project,filename),
    UNIQUE (location_key),
    CHECK ((source_kind IN ('upstream','mirror','proxy-cache')) = (upstream_url IS NOT NULL))
);

CREATE INDEX pip_artifacts_project_route_idx
ON source_center.pip_artifacts (project,package_version,source_id,filename);

CREATE INDEX pip_artifacts_offline_idx
ON source_center.pip_artifacts (project,source_kind,package_version)
WHERE cached_at IS NOT NULL AND scan_status='passed' AND signature_status<>'invalid';
