DROP TRIGGER IF EXISTS audit_references_v1_append_only ON audit.audit_references;
DROP FUNCTION IF EXISTS audit.reject_v1_event_mutation();
DROP INDEX IF EXISTS audit.audit_correlation_sequence_idx;
DROP INDEX IF EXISTS audit.audit_domain_sequence_idx;

ALTER TABLE audit.audit_references
    DROP CONSTRAINT IF EXISTS audit_checkpoint_check,
    DROP CONSTRAINT IF EXISTS audit_canonical_payload_check,
    DROP CONSTRAINT IF EXISTS audit_correlation_key_check,
    DROP CONSTRAINT IF EXISTS audit_outcome_check,
    DROP CONSTRAINT IF EXISTS audit_domain_check,
    DROP CONSTRAINT IF EXISTS audit_schema_version_check,
    DROP COLUMN IF EXISTS checkpoint_signature,
    DROP COLUMN IF EXISTS checkpoint_key_id,
    DROP COLUMN IF EXISTS checkpoint_algorithm,
    DROP COLUMN IF EXISTS canonical_payload,
    DROP COLUMN IF EXISTS correlation_key,
    DROP COLUMN IF EXISTS outcome,
    DROP COLUMN IF EXISTS domain,
    DROP COLUMN IF EXISTS schema_version;
