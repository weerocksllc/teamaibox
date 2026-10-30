-- Preserve historical evidence; new unlock plans no longer depend on an archive service.
ALTER TABLE security.unlock_protection_transitions ALTER COLUMN backup_evidence_digest DROP NOT NULL;
