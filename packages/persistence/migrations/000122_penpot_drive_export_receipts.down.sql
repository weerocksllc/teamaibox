DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM design.drive_export_receipts)
        OR EXISTS (SELECT 1 FROM objects.artifact_provenance WHERE artifact_kind = 'design-export') THEN
        RAISE EXCEPTION 'Design transfer receipts exist; rollback would remove commit evidence';
    END IF;
END $$;
DROP TABLE design.drive_export_receipts;
ALTER TABLE objects.artifact_provenance DROP CONSTRAINT artifact_provenance_artifact_kind_check;
ALTER TABLE objects.artifact_provenance ADD CONSTRAINT artifact_provenance_artifact_kind_check
CHECK (artifact_kind IN ('chat-attachment', 'drive-file', 'agent-artifact', 'ai-input', 'ai-result',
    'fine-tuning-dataset', 'fine-tuning-checkpoint', 'model-artifact'));
