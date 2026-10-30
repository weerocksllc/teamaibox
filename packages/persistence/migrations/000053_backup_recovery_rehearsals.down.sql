ALTER TABLE platform.backup_rehearsal_policies DROP CONSTRAINT IF EXISTS backup_rehearsal_policies_last_run_fk;
DROP TABLE IF EXISTS platform.backup_recovery_runs;
DROP TABLE IF EXISTS platform.backup_rehearsal_policies;
