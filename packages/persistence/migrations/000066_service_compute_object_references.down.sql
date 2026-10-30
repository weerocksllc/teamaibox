CREATE OR REPLACE FUNCTION objects.enforce_access_grant_boundary()
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
