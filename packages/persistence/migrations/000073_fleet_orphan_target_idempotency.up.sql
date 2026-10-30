CREATE UNIQUE INDEX fleet_operation_orphans_target_idx
ON compute.fleet_operation_orphans (operation_id, node_id);
