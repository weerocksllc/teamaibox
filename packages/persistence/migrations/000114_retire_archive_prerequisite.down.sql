-- Do not invent evidence or delete plans when rolling back.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM security.unlock_protection_transitions WHERE backup_evidence_digest IS NULL) THEN
    RAISE EXCEPTION 'Cannot restore archive prerequisite while post-retirement unlock plans exist';
  END IF;
END $$;
ALTER TABLE security.unlock_protection_transitions ALTER COLUMN backup_evidence_digest SET NOT NULL;
