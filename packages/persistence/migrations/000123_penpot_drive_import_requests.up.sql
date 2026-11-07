CREATE TABLE design.drive_import_requests (
    operation_id uuid PRIMARY KEY,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    profile_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source_file_id uuid NOT NULL,
    source_version integer NOT NULL CHECK (source_version > 0),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    source_digest text CHECK (source_digest ~ '^[a-f0-9]{64}$'),
    failed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
