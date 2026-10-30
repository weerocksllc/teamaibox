CREATE TABLE platform.backup_sets (
    id uuid PRIMARY KEY,
    operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    target_key text NOT NULL CHECK (target_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    target_display_name text NOT NULL CHECK (length(target_display_name) BETWEEN 1 AND 128),
    target_kind text NOT NULL CHECK (target_kind IN ('filesystem','s3_compatible','remote_archive')),
    target_failure_domain text NOT NULL CHECK (target_failure_domain ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    target_storage_pool_id text REFERENCES objects.storage_pools(pool_id) ON DELETE RESTRICT,
    target_device_identity_digest bytea NOT NULL CHECK (octet_length(target_device_identity_digest)=32),
    target_independent boolean NOT NULL DEFAULT false,
    requested_by uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    backup_state text NOT NULL CHECK (backup_state IN ('preparing','writing','completed','failed')),
    checkpoint_id text CHECK (checkpoint_id IS NULL OR checkpoint_id ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    checkpoint jsonb CHECK (checkpoint IS NULL OR (jsonb_typeof(checkpoint)='object' AND octet_length(checkpoint::text)<=32768)),
    recovery_point_at timestamptz,
    manifest_digest bytea CHECK (manifest_digest IS NULL OR octet_length(manifest_digest)=32),
    manifest_algorithm text CHECK (manifest_algorithm IS NULL OR manifest_algorithm='hmac-sha256'),
    manifest_key_id text CHECK (manifest_key_id IS NULL OR manifest_key_id ~ '^[a-z][a-z0-9._-]{2,127}$'),
    manifest_signature bytea CHECK (manifest_signature IS NULL OR octet_length(manifest_signature)=32),
    receipt_key text CHECK (receipt_key IS NULL OR receipt_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'),
    total_ciphertext_bytes bigint NOT NULL DEFAULT 0 CHECK (total_ciphertext_bytes BETWEEN 0 AND 9007199254740991),
    failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_.-]{1,127}$'),
    started_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    completed_at timestamptz,
    CHECK (updated_at>=started_at AND (completed_at IS NULL OR completed_at>=started_at)),
    CHECK (
        (backup_state='preparing' AND checkpoint_id IS NULL AND checkpoint IS NULL AND recovery_point_at IS NULL
          AND NOT target_independent AND manifest_digest IS NULL AND manifest_algorithm IS NULL AND manifest_key_id IS NULL
          AND manifest_signature IS NULL AND receipt_key IS NULL AND failure_code IS NULL AND completed_at IS NULL)
        OR
        (backup_state='writing' AND checkpoint_id IS NOT NULL AND checkpoint IS NOT NULL AND recovery_point_at IS NOT NULL
          AND target_independent AND manifest_digest IS NULL AND manifest_algorithm IS NULL AND manifest_key_id IS NULL
          AND manifest_signature IS NULL AND receipt_key IS NULL AND failure_code IS NULL AND completed_at IS NULL)
        OR
        (backup_state='completed' AND checkpoint_id IS NOT NULL AND checkpoint IS NOT NULL AND recovery_point_at IS NOT NULL
          AND target_independent AND manifest_digest IS NOT NULL AND manifest_algorithm='hmac-sha256' AND manifest_key_id IS NOT NULL
          AND manifest_signature IS NOT NULL AND receipt_key IS NOT NULL AND failure_code IS NULL AND completed_at IS NOT NULL)
        OR
        (backup_state='failed' AND manifest_digest IS NULL AND manifest_algorithm IS NULL AND manifest_key_id IS NULL
          AND manifest_signature IS NULL AND receipt_key IS NULL AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE INDEX backup_sets_state_time_idx ON platform.backup_sets (backup_state, started_at DESC);
CREATE INDEX backup_sets_target_time_idx ON platform.backup_sets (target_key, started_at DESC);
CREATE INDEX backup_sets_recovery_point_idx ON platform.backup_sets (recovery_point_at DESC) WHERE backup_state='completed';

CREATE TABLE platform.backup_set_components (
    backup_set_id uuid NOT NULL REFERENCES platform.backup_sets(id) ON DELETE RESTRICT,
    component_kind text NOT NULL CHECK (component_kind IN (
        'configuration','postgresql','encrypted_objects','plugin_metadata','model_metadata','audit_evidence','protected_keys'
    )),
    media_type text NOT NULL CHECK (media_type ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$'),
    item_count bigint NOT NULL CHECK (item_count BETWEEN 0 AND 9007199254740991),
    storage_key text NOT NULL CHECK (storage_key ~ '^components/[a-z][a-z0-9_]{2,63}[.]bin$'),
    encryption_algorithm text NOT NULL CHECK (encryption_algorithm='aes-256-gcm'),
    encryption_key_id text NOT NULL CHECK (encryption_key_id ~ '^[a-z][a-z0-9._-]{2,127}$'),
    encryption_nonce bytea NOT NULL CHECK (octet_length(encryption_nonce)=12),
    encryption_auth_tag bytea NOT NULL CHECK (octet_length(encryption_auth_tag)=16),
    plaintext_digest bytea NOT NULL CHECK (octet_length(plaintext_digest)=32),
    ciphertext_digest bytea NOT NULL CHECK (octet_length(ciphertext_digest)=32),
    plaintext_bytes bigint NOT NULL CHECK (plaintext_bytes BETWEEN 0 AND 9007199254740991),
    ciphertext_bytes bigint NOT NULL CHECK (ciphertext_bytes BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (backup_set_id, component_kind),
    UNIQUE (backup_set_id, storage_key)
);

CREATE INDEX backup_set_components_kind_idx ON platform.backup_set_components (component_kind, backup_set_id);
