CREATE TABLE source_center.apt_packages (
    id uuid PRIMARY KEY,
    package_name text NOT NULL CHECK (package_name ~ '^[a-z0-9][a-z0-9+.-]{0,127}$'),
    package_version text NOT NULL,
    architecture text NOT NULL CHECK (architecture IN ('arm64','all','amd64')),
    sha256 bytea NOT NULL CHECK (octet_length(sha256)=32),
    byte_size bigint NOT NULL CHECK (byte_size>0),
    source_id uuid NOT NULL REFERENCES source_center.sources(id) ON DELETE RESTRICT,
    source_kind text NOT NULL CHECK (source_kind IN ('hosted','proxy-cache','upstream','mirror','offline-media')),
    location_key text NOT NULL UNIQUE,
    upstream_url text CHECK (upstream_url IS NULL OR upstream_url ~ '^https://'),
    filename text NOT NULL,
    depends jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(depends)='array'),
    pre_depends jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pre_depends)='array'),
    provides text[] NOT NULL DEFAULT '{}',
    description text,
    section text NOT NULL,
    priority text NOT NULL,
    installed_size bigint NOT NULL CHECK (installed_size>=0),
    signature_status text NOT NULL CHECK (signature_status IN ('verified','unsigned','invalid','not-available')),
    scan_status text NOT NULL CHECK (scan_status IN ('pending','passed','failed')),
    license text,
    cached_at timestamptz,
    imported_at timestamptz NOT NULL,
    UNIQUE (source_id,package_name,package_version,architecture),
    CHECK ((source_kind IN ('upstream','mirror','proxy-cache')) = (upstream_url IS NOT NULL))
);

CREATE INDEX apt_packages_route_idx ON source_center.apt_packages (package_name,architecture,package_version,source_id);
CREATE INDEX apt_packages_offline_idx ON source_center.apt_packages (package_name,package_version) WHERE architecture IN ('arm64','all') AND cached_at IS NOT NULL AND scan_status='passed' AND signature_status<>'invalid';

CREATE TABLE source_center.apt_snapshots (
    id uuid PRIMARY KEY,
    suite text NOT NULL,
    component text NOT NULL CHECK (component='main'),
    architecture text NOT NULL CHECK (architecture='arm64'),
    policy_key text NOT NULL,
    package_ids jsonb NOT NULL CHECK (jsonb_typeof(package_ids)='array'),
    packages_index bytea NOT NULL,
    packages_sha256 bytea NOT NULL CHECK (octet_length(packages_sha256)=32),
    release_document bytea NOT NULL,
    in_release bytea NOT NULL,
    signer_fingerprint text NOT NULL CHECK (signer_fingerprint ~ '^[A-F0-9]{40}([A-F0-9]{24})?$'),
    created_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    valid_until timestamptz NOT NULL CHECK (valid_until>created_at),
    UNIQUE (suite,created_at)
);

CREATE INDEX apt_snapshots_current_idx ON source_center.apt_snapshots (suite,created_at DESC,id DESC);

CREATE FUNCTION source_center.reject_apt_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'APT snapshots are immutable' USING ERRCODE='23514'; END
$$;
CREATE TRIGGER apt_snapshots_append_only BEFORE UPDATE OR DELETE ON source_center.apt_snapshots
FOR EACH ROW EXECUTE FUNCTION source_center.reject_apt_snapshot_mutation();
