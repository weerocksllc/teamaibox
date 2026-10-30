CREATE SCHEMA files;

CREATE TABLE files.roots (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    scope_kind text NOT NULL CHECK (scope_kind IN ('user', 'team')),
    scope_key text NOT NULL CHECK (
        (scope_kind = 'user' AND scope_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR (scope_kind = 'team' AND scope_key ~ '^[a-z][a-z0-9_.-]{2,127}$')
    ),
    quota_bytes bigint NOT NULL CHECK (quota_bytes >= 1),
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (scope_kind, scope_key),
    CHECK (used_bytes <= quota_bytes),
    CHECK (updated_at >= created_at)
);

CREATE TABLE files.entries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    root_id uuid NOT NULL REFERENCES files.roots(id) ON DELETE CASCADE,
    parent_id uuid,
    entry_kind text NOT NULL CHECK (entry_kind IN ('folder', 'file')),
    entry_name text NOT NULL CHECK (
        length(entry_name) BETWEEN 1 AND 255
        AND entry_name !~ E'[\\x00/\\\\]'
        AND entry_name NOT IN ('.', '..')
    ),
    owner_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    trashed_at timestamptz,
    retention_until timestamptz,
    UNIQUE (id, root_id),
    FOREIGN KEY (parent_id, root_id) REFERENCES files.entries(id, root_id) ON DELETE CASCADE,
    CHECK ((entry_kind = 'folder' AND current_version = 0) OR entry_kind = 'file'),
    CHECK (
        (trashed_at IS NULL AND retention_until IS NULL)
        OR (trashed_at IS NOT NULL AND retention_until IS NOT NULL AND retention_until >= trashed_at)
    ),
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX files_entries_active_sibling_unique_idx
ON files.entries (root_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(entry_name))
WHERE trashed_at IS NULL;

CREATE INDEX files_entries_children_idx
ON files.entries (root_id, parent_id, entry_kind, entry_name, id)
WHERE trashed_at IS NULL;

CREATE INDEX files_entries_recycle_idx
ON files.entries (root_id, retention_until, id)
WHERE trashed_at IS NOT NULL;

CREATE INDEX files_entries_search_idx
ON files.entries (root_id, lower(entry_name), id)
WHERE trashed_at IS NULL;

CREATE TABLE files.versions (
    file_id uuid NOT NULL REFERENCES files.entries(id) ON DELETE CASCADE,
    root_id uuid NOT NULL REFERENCES files.roots(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    object_id uuid NOT NULL,
    object_version integer NOT NULL CHECK (object_version >= 1),
    byte_size bigint NOT NULL CHECK (byte_size >= 1),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (file_id, version),
    FOREIGN KEY (object_id, object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT
);

CREATE INDEX files_versions_object_idx
ON files.versions (object_id, object_version, file_id, version);

CREATE TABLE files.acl (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    root_id uuid NOT NULL REFERENCES files.roots(id) ON DELETE CASCADE,
    entry_id uuid REFERENCES files.entries(id) ON DELETE CASCADE,
    principal_kind text NOT NULL CHECK (principal_kind IN ('identity', 'team')),
    principal_key text NOT NULL CHECK (
        (principal_kind = 'identity' AND principal_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR (principal_kind = 'team' AND principal_key ~ '^[a-z][a-z0-9_.-]{2,127}$')
    ),
    access_role text NOT NULL CHECK (access_role IN ('viewer', 'editor', 'manager')),
    inherited boolean NOT NULL DEFAULT true,
    expires_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX files_acl_principal_target_unique_idx
ON files.acl (root_id, COALESCE(entry_id, '00000000-0000-0000-0000-000000000000'::uuid), principal_kind, principal_key);

CREATE INDEX files_acl_identity_lookup_idx
ON files.acl (principal_kind, principal_key, root_id, entry_id)
WHERE expires_at IS NULL;

CREATE TABLE files.shares (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    root_id uuid NOT NULL REFERENCES files.roots(id) ON DELETE CASCADE,
    entry_id uuid NOT NULL REFERENCES files.entries(id) ON DELETE CASCADE,
    principal_kind text NOT NULL CHECK (principal_kind IN ('identity', 'team')),
    principal_key text NOT NULL CHECK (
        (principal_kind = 'identity' AND principal_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR (principal_kind = 'team' AND principal_key ~ '^[a-z][a-z0-9_.-]{2,127}$')
    ),
    access_role text NOT NULL CHECK (access_role IN ('viewer', 'editor')),
    expires_at timestamptz,
    revoked_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at IS NULL OR expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX files_shares_principal_active_idx
ON files.shares (principal_kind, principal_key, created_at DESC, id)
WHERE revoked_at IS NULL;

CREATE INDEX files_shares_entry_idx
ON files.shares (entry_id, created_at DESC, id);

CREATE FUNCTION files.validate_entry_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_kind text;
    cycle_found boolean;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION 'file entry cannot parent itself' USING ERRCODE = 'check_violation';
    END IF;
    SELECT entry_kind INTO parent_kind
    FROM files.entries
    WHERE id = NEW.parent_id AND root_id = NEW.root_id AND trashed_at IS NULL;
    IF parent_kind IS DISTINCT FROM 'folder' THEN
        RAISE EXCEPTION 'file parent must be an active folder in the same root' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM files.entries WHERE id = NEW.parent_id
            UNION ALL
            SELECT entry.id, entry.parent_id
            FROM files.entries entry JOIN ancestors ON entry.id = ancestors.parent_id
        ) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cycle_found;
        IF cycle_found THEN
            RAISE EXCEPTION 'file hierarchy cycle is forbidden' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER files_entries_parent_boundary
BEFORE INSERT OR UPDATE OF parent_id, root_id ON files.entries
FOR EACH ROW EXECUTE FUNCTION files.validate_entry_parent();

CREATE FUNCTION files.commit_version_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    entry_record files.entries%ROWTYPE;
    root_record files.roots%ROWTYPE;
    object_record objects.object_versions%ROWTYPE;
BEGIN
    SELECT * INTO entry_record FROM files.entries WHERE id = NEW.file_id FOR UPDATE;
    IF entry_record.id IS NULL OR entry_record.root_id <> NEW.root_id
       OR entry_record.entry_kind <> 'file' OR entry_record.trashed_at IS NOT NULL
       OR NEW.version <> entry_record.current_version + 1 THEN
        RAISE EXCEPTION 'file version requires the next active file revision' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO root_record FROM files.roots WHERE id = entry_record.root_id FOR UPDATE;
    IF root_record.id IS NULL OR root_record.used_bytes + NEW.byte_size > root_record.quota_bytes THEN
        RAISE EXCEPTION 'file root quota exceeded' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO object_record
    FROM objects.object_versions
    WHERE object_id = NEW.object_id AND version = NEW.object_version;
    IF object_record.object_id IS NULL OR object_record.size <> NEW.byte_size
       OR object_record.content_type <> NEW.media_type OR object_record.sha256 <> NEW.sha256 THEN
        RAISE EXCEPTION 'file version facts must match one verified immutable object version' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION files.advance_version_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    selected_root_id uuid;
BEGIN
    UPDATE files.entries
    SET current_version = NEW.version,
        revision = CASE WHEN current_version = 0 THEN revision ELSE revision + 1 END,
        updated_at = NEW.created_at
    WHERE id = NEW.file_id
    RETURNING root_id INTO selected_root_id;
    UPDATE files.roots
    SET used_bytes = used_bytes + NEW.byte_size, revision = revision + 1, updated_at = NEW.created_at
    WHERE id = selected_root_id;
    RETURN NULL;
END;
$$;

CREATE FUNCTION files.release_version_quota()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    selected_root_id uuid;
BEGIN
    selected_root_id := OLD.root_id;
    UPDATE files.roots
    SET used_bytes = used_bytes - OLD.byte_size, revision = revision + 1, updated_at = clock_timestamp()
    WHERE id = selected_root_id;
    RETURN NULL;
END;
$$;

CREATE FUNCTION files.reject_version_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'file version facts are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER files_versions_commit_boundary
BEFORE INSERT ON files.versions
FOR EACH ROW EXECUTE FUNCTION files.commit_version_boundary();

CREATE TRIGGER files_versions_advance_boundary
AFTER INSERT ON files.versions
FOR EACH ROW EXECUTE FUNCTION files.advance_version_boundary();

CREATE TRIGGER files_versions_release_quota
AFTER DELETE ON files.versions
FOR EACH ROW EXECUTE FUNCTION files.release_version_quota();

CREATE TRIGGER files_versions_immutable
BEFORE UPDATE ON files.versions
FOR EACH ROW EXECUTE FUNCTION files.reject_version_update();

CREATE FUNCTION files.validate_acl_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.entry_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM files.entries WHERE id = NEW.entry_id AND root_id = NEW.root_id
    ) THEN
        RAISE EXCEPTION 'file ACL target must belong to its root' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER files_acl_target_boundary
BEFORE INSERT OR UPDATE OF root_id, entry_id ON files.acl
FOR EACH ROW EXECUTE FUNCTION files.validate_acl_target();
