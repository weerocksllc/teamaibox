DROP INDEX compute.nodes_active_node_key_idx;

ALTER TABLE compute.nodes
ADD CONSTRAINT nodes_node_key_key UNIQUE (node_key);
