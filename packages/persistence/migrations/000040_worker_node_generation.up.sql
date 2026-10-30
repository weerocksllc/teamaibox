ALTER TABLE compute.worker_instances
ADD COLUMN node_generation bigint;

UPDATE compute.worker_instances worker
SET node_generation = node.generation
FROM compute.nodes node
WHERE node.id = worker.node_id;

ALTER TABLE compute.worker_instances
ALTER COLUMN node_generation SET NOT NULL,
ADD CONSTRAINT worker_instances_node_generation_positive CHECK (node_generation > 0);

CREATE INDEX worker_instances_node_generation_idx
ON compute.worker_instances (node_id, node_generation, lifecycle_state);
