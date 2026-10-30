-- Fail rather than silently lowering a configured value or removing members.
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_max_managed_nodes_check;
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_max_managed_nodes_check CHECK (max_managed_nodes BETWEEN 0 AND 256);
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_enrollment_concurrency_check;
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_enrollment_concurrency_check CHECK (enrollment_concurrency BETWEEN 1 AND 16);
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_rollout_concurrency_check;
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_rollout_concurrency_check CHECK (rollout_concurrency BETWEEN 1 AND 16);
-- Refuse rollback if a group has no explicit limit; never invent one.
ALTER TABLE compute.node_groups ALTER COLUMN max_managed_nodes SET NOT NULL;
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_core_count_required;
ALTER TABLE compute.distributed_profile_certifications DROP CONSTRAINT distributed_profile_certifications_minimum_nodes_check;
ALTER TABLE compute.distributed_profile_certifications ADD CONSTRAINT distributed_profile_certifications_minimum_nodes_check CHECK (minimum_nodes BETWEEN 2 AND 16);
ALTER TABLE compute.distributed_profile_certifications DROP CONSTRAINT distributed_profile_certifications_maximum_nodes_check;
ALTER TABLE compute.distributed_profile_certifications ADD CONSTRAINT distributed_profile_certifications_maximum_nodes_check CHECK (maximum_nodes BETWEEN 2 AND 16);
ALTER TABLE compute.gang_lease_sets DROP CONSTRAINT gang_lease_sets_member_count_check;
ALTER TABLE compute.gang_lease_sets ADD CONSTRAINT gang_lease_sets_member_count_check CHECK (member_count BETWEEN 2 AND 16);
