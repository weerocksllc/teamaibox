DROP TRIGGER node_heartbeat_events_append_only ON compute.node_heartbeat_events;
DROP FUNCTION compute.reject_node_heartbeat_mutation();
DROP TABLE compute.node_heartbeat_events;
ALTER TABLE compute.nodes DROP CONSTRAINT nodes_enrollment_fk;
DROP TABLE compute.node_enrollments;
UPDATE compute.nodes SET lifecycle_state='disabled' WHERE lifecycle_state='removed';
ALTER TABLE compute.nodes
    DROP CONSTRAINT node_certificate_revocation_state,
    DROP CONSTRAINT node_inventory_digest_pair,
    DROP COLUMN revision,
    DROP COLUMN inventory_digest,
    DROP COLUMN inventory,
    DROP COLUMN health,
    DROP COLUMN certificate_revoked_at,
    DROP COLUMN certificate_not_after,
    DROP COLUMN certificate_fingerprint,
    DROP COLUMN enrollment_id;
ALTER TABLE compute.nodes DROP CONSTRAINT nodes_lifecycle_state_check;
ALTER TABLE compute.nodes ADD CONSTRAINT nodes_lifecycle_state_check CHECK (
    lifecycle_state IN ('joining','ready','draining','offline','disabled')
);
