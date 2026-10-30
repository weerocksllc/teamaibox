INSERT INTO iam.permissions (permission_key, description_key) VALUES
    ('object_reference:revoke:any', 'permissions.object_reference_revoke_any');

INSERT INTO iam.role_permissions (role_id, permission_key)
SELECT role.id, 'object_reference:revoke:any'
FROM iam.roles role
WHERE role.role_key IN ('owner', 'system_admin', 'team_admin');

ALTER TABLE objects.namespaces
ADD COLUMN namespace_kind text GENERATED ALWAYS AS (split_part(namespace_key, ':', 1)) STORED;

ALTER TABLE objects.namespaces
ADD CONSTRAINT namespaces_supported_kind CHECK (namespace_kind IN ('tenant', 'user', 'team'));

CREATE FUNCTION objects.valid_namespace_operations(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND jsonb_array_length(value) BETWEEN 1 AND 7
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(value) operation(item)
           WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' NOT IN (
                  'read', 'write', 'list', 'delete',
                  'reference:create', 'reference:revoke', 'manage'
              )
       )
       AND (SELECT count(*) = count(DISTINCT item)
            FROM jsonb_array_elements(value) operation(item));
$$;

CREATE FUNCTION objects.valid_reference_operations(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT jsonb_typeof(value) = 'array'
       AND jsonb_array_length(value) BETWEEN 1 AND 3
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(value) operation(item)
           WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' NOT IN ('head', 'read', 'range')
       )
       AND (SELECT count(*) = count(DISTINCT item)
            FROM jsonb_array_elements(value) operation(item));
$$;

CREATE TABLE objects.namespace_bindings (
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE CASCADE,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE CASCADE,
    operations jsonb NOT NULL CHECK (objects.valid_namespace_operations(operations)),
    granted_by_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 128),
    PRIMARY KEY (namespace_key, identity_id),
    CHECK (expires_at IS NULL OR expires_at > created_at),
    CHECK ((revoked_at IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE INDEX namespace_bindings_identity_active_idx
ON objects.namespace_bindings (identity_id, namespace_key, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE objects.access_grants (
    reference_id uuid PRIMARY KEY DEFAULT uuidv7(),
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE RESTRICT,
    object_id uuid NOT NULL,
    object_version integer NOT NULL,
    audience text NOT NULL CHECK (audience ~ '^[a-z][a-z0-9:._-]{2,190}$'),
    operations jsonb NOT NULL CHECK (objects.valid_reference_operations(operations)),
    integrity_sha256 bytea NOT NULL CHECK (octet_length(integrity_sha256) = 32),
    issued_by_identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_by_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 128),
    last_used_at timestamptz,
    use_count bigint NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    FOREIGN KEY (object_id, object_version)
        REFERENCES objects.object_versions(object_id, version) ON DELETE RESTRICT,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
    CHECK ((revoked_at IS NULL AND revoked_by_identity_id IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
    CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);

CREATE INDEX access_grants_active_idx
ON objects.access_grants (audience, expires_at, reference_id)
WHERE revoked_at IS NULL;

CREATE FUNCTION objects.enforce_access_grant_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    object_namespace text;
    object_sha256 bytea;
    issuer_kind text;
    issuer_status text;
BEGIN
    SELECT entry.namespace_key, version.sha256 INTO object_namespace, object_sha256
    FROM objects.object_versions version
    JOIN objects.object_entries entry ON entry.id = version.object_id
    WHERE version.object_id = NEW.object_id AND version.version = NEW.object_version;
    SELECT identity_kind, status INTO issuer_kind, issuer_status
    FROM iam.identities WHERE id = NEW.issued_by_identity_id;
    IF object_namespace IS NULL
       OR object_namespace <> NEW.namespace_key
       OR object_sha256 <> NEW.integrity_sha256
       OR issuer_kind <> 'local_user'
       OR issuer_status <> 'active'
       OR NOT EXISTS (
           SELECT 1
           FROM objects.namespace_bindings binding
           WHERE binding.namespace_key = NEW.namespace_key
             AND binding.identity_id = NEW.issued_by_identity_id
             AND binding.revoked_at IS NULL
             AND (binding.expires_at IS NULL OR binding.expires_at > NEW.created_at)
             AND (binding.operations ? 'reference:create' OR binding.operations ? 'manage')
       ) THEN
        RAISE EXCEPTION 'object access grant is outside the issuer namespace authority'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION objects.enforce_access_grant_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.reference_id <> OLD.reference_id
       OR NEW.namespace_key <> OLD.namespace_key
       OR NEW.object_id <> OLD.object_id
       OR NEW.object_version <> OLD.object_version
       OR NEW.audience <> OLD.audience
       OR NEW.operations <> OLD.operations
       OR NEW.integrity_sha256 <> OLD.integrity_sha256
       OR NEW.issued_by_identity_id <> OLD.issued_by_identity_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.use_count < OLD.use_count
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'immutable object access grant fields cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER access_grant_create_boundary
BEFORE INSERT ON objects.access_grants
FOR EACH ROW EXECUTE FUNCTION objects.enforce_access_grant_boundary();

CREATE TRIGGER access_grant_update_boundary
BEFORE UPDATE ON objects.access_grants
FOR EACH ROW EXECUTE FUNCTION objects.enforce_access_grant_update();

CREATE TABLE objects.access_events (
    sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reference_id uuid REFERENCES objects.access_grants(reference_id) ON DELETE SET NULL,
    actor_identity_id uuid REFERENCES iam.identities(id) ON DELETE SET NULL,
    audience text CHECK (audience IS NULL OR length(audience) BETWEEN 3 AND 191),
    namespace_key text NOT NULL REFERENCES objects.namespaces(namespace_key) ON DELETE RESTRICT,
    object_id uuid,
    object_version integer,
    operation text NOT NULL CHECK (
        operation IN ('head', 'read', 'range', 'list', 'write', 'delete', 'grant', 'revoke')
    ),
    success boolean NOT NULL,
    denial_reason text CHECK (denial_reason IS NULL OR length(denial_reason) BETWEEN 1 AND 128),
    correlation_id uuid,
    CHECK ((success AND denial_reason IS NULL) OR (NOT success AND denial_reason IS NOT NULL)),
    CHECK ((object_id IS NULL) = (object_version IS NULL))
);

CREATE INDEX access_events_object_idx
ON objects.access_events (namespace_key, object_id, occurred_at DESC);

CREATE INDEX access_events_reference_idx
ON objects.access_events (reference_id, occurred_at DESC)
WHERE reference_id IS NOT NULL;

CREATE FUNCTION objects.reject_access_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'object access events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER access_events_append_only
BEFORE UPDATE OR DELETE ON objects.access_events
FOR EACH ROW EXECUTE FUNCTION objects.reject_access_event_mutation();
