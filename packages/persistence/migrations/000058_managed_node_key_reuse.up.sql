ALTER TABLE compute.nodes
DROP CONSTRAINT nodes_node_key_key;

CREATE UNIQUE INDEX nodes_active_node_key_idx
ON compute.nodes (node_key)
WHERE lifecycle_state <> 'removed';
