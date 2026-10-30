-- Fleet services share the same node-row admission lock as guests and jobs.
-- An expired control request does not imply that its container stopped.
CREATE TABLE compute.fleet_service_allocations (
    operation_id text NOT NULL,
    node_id uuid NOT NULL,
    node_generation bigint NOT NULL CHECK (node_generation > 0),
    desired_digest text NOT NULL CHECK (desired_digest ~ '^sha256:[a-f0-9]{64}$'),
    reservation jsonb NOT NULL CHECK (jsonb_typeof(reservation) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    released_at timestamptz,
    PRIMARY KEY (operation_id,node_id),
    FOREIGN KEY (operation_id,node_id) REFERENCES compute.fleet_operation_targets(operation_id,node_id) ON DELETE RESTRICT
);
CREATE VIEW compute.fleet_service_reservations AS
SELECT operation_id,node_id,node_generation,reservation
FROM compute.fleet_service_allocations WHERE released_at IS NULL;
