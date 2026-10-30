DROP TABLE compute.node_exclusive_intents;

ALTER TABLE compute.lease_sets
DROP COLUMN node_exclusive;
