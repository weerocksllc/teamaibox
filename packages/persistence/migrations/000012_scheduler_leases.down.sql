DROP INDEX compute.leases_set_resource_idx;
DROP INDEX compute.leases_active_node_resource_idx;
DROP INDEX compute.leases_one_active_exclusive_resource_idx;

ALTER TABLE compute.leases
    DROP COLUMN amount,
    DROP COLUMN node_id,
    DROP COLUMN lease_set_id;

ALTER TABLE compute.leases
DROP CONSTRAINT leases_resource_kind_check;

ALTER TABLE compute.leases
ADD CONSTRAINT leases_resource_kind_check CHECK (
    resource_kind IN (
        'node', 'cpu', 'unified_memory', 'accelerator', 'codec',
        'worker', 'realtime', 'exclusive'
    )
);

CREATE UNIQUE INDEX leases_one_active_resource_idx
ON compute.leases (resource_kind, resource_key)
WHERE state = 'active';

ALTER TABLE compute.jobs
DROP COLUMN current_attempt_id;

DROP INDEX compute.lease_sets_reconciliation_idx;
DROP INDEX compute.lease_sets_node_capacity_idx;
DROP INDEX compute.lease_sets_one_active_job_idx;
DROP TABLE compute.lease_sets;
DROP TABLE compute.node_lease_fences;

