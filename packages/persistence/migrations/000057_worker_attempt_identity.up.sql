ALTER TABLE compute.worker_instances
ADD COLUMN attempt_id uuid REFERENCES compute.attempts(id) ON DELETE RESTRICT;

UPDATE compute.worker_instances worker
SET attempt_id = lease.attempt_id
FROM compute.lease_sets lease
WHERE lease.lease_token = worker.control_lease_id
  AND worker.attempt_id IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM compute.worker_instances WHERE attempt_id IS NULL) THEN
        RAISE EXCEPTION 'worker attempt identity backfill is incomplete';
    END IF;
END
$$;

ALTER TABLE compute.worker_instances
ALTER COLUMN attempt_id SET NOT NULL;

CREATE UNIQUE INDEX worker_instances_attempt_idx
ON compute.worker_instances (attempt_id);
