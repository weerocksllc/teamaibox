DROP INDEX compute.worker_instances_attempt_idx;

ALTER TABLE compute.worker_instances
DROP COLUMN attempt_id;
