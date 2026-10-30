ALTER TABLE audit.audit_references
    ADD COLUMN schema_version smallint NOT NULL DEFAULT 0,
    ADD COLUMN domain text NOT NULL DEFAULT 'legacy',
    ADD COLUMN outcome text NOT NULL DEFAULT 'unknown',
    ADD COLUMN correlation_key text,
    ADD COLUMN canonical_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN checkpoint_algorithm text,
    ADD COLUMN checkpoint_key_id text,
    ADD COLUMN checkpoint_signature bytea;

ALTER TABLE audit.audit_references
    ADD CONSTRAINT audit_schema_version_check CHECK (schema_version IN (0, 1)),
    ADD CONSTRAINT audit_domain_check CHECK (domain IN (
        'legacy', 'identity', 'data', 'plugin', 'model', 'provider', 'routing',
        'agent_confirmation', 'source', 'security', 'key', 'backup', 'update',
        'administrator'
    )),
    ADD CONSTRAINT audit_outcome_check CHECK (outcome IN ('unknown', 'succeeded', 'failed', 'denied')),
    ADD CONSTRAINT audit_correlation_key_check CHECK (correlation_key IS NULL OR length(correlation_key) BETWEEN 8 AND 384),
    ADD CONSTRAINT audit_canonical_payload_check CHECK (jsonb_typeof(canonical_payload) = 'object'),
    ADD CONSTRAINT audit_checkpoint_check CHECK (
        (schema_version = 0 AND checkpoint_algorithm IS NULL AND checkpoint_key_id IS NULL AND checkpoint_signature IS NULL)
        OR
        (schema_version = 1
          AND domain <> 'legacy' AND outcome <> 'unknown'
          AND correlation_key IS NOT NULL
          AND checkpoint_algorithm = 'hmac-sha256'
          AND checkpoint_key_id ~ '^[a-z][a-z0-9._-]{2,127}$'
          AND octet_length(checkpoint_signature) = 32)
    );

CREATE INDEX audit_domain_sequence_idx
ON audit.audit_references (domain, sequence_id DESC)
WHERE schema_version = 1;

CREATE INDEX audit_correlation_sequence_idx
ON audit.audit_references (correlation_key, sequence_id DESC)
WHERE schema_version = 1;

CREATE OR REPLACE FUNCTION audit.reject_v1_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $audit_immutable$
BEGIN
    IF OLD.schema_version = 1 THEN
        RAISE EXCEPTION 'tamper-evident audit events are append-only'
            USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
END
$audit_immutable$;

CREATE TRIGGER audit_references_v1_append_only
BEFORE UPDATE OR DELETE ON audit.audit_references
FOR EACH ROW EXECUTE FUNCTION audit.reject_v1_event_mutation();
