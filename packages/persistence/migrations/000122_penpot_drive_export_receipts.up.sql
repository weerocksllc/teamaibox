CREATE TABLE design.drive_export_receipts (
    operation_id uuid PRIMARY KEY,
    identity_id uuid NOT NULL REFERENCES iam.identities(id) ON DELETE RESTRICT,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'failed')),
    file_id uuid,
    file_version integer CHECK (file_version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state = 'complete') = (file_id IS NOT NULL AND file_version IS NOT NULL)),
    CHECK ((file_id IS NULL) = (file_version IS NULL))
);

ALTER TABLE objects.artifact_provenance DROP CONSTRAINT artifact_provenance_artifact_kind_check;
ALTER TABLE objects.artifact_provenance ADD CONSTRAINT artifact_provenance_artifact_kind_check
CHECK (artifact_kind IN ('chat-attachment', 'drive-file', 'agent-artifact', 'ai-input', 'ai-result',
    'fine-tuning-dataset', 'fine-tuning-checkpoint', 'model-artifact', 'design-export'));
