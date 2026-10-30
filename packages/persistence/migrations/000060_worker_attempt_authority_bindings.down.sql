ALTER TABLE compute.worker_instances
DROP COLUMN binding_revision,
DROP COLUMN attempt_bindings;

COMMENT ON COLUMN compute.worker_instances.attempt_id IS NULL;
