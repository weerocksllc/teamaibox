-- Keep explicit administrator/group values; remove product-wide numeric ceilings.
ALTER TABLE compute.node_groups ALTER COLUMN max_managed_nodes DROP NOT NULL;
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_max_managed_nodes_check;
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_max_managed_nodes_check CHECK (max_managed_nodes >= 0);
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_enrollment_concurrency_check;
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_enrollment_concurrency_check CHECK (enrollment_concurrency >= 1);
ALTER TABLE compute.node_groups DROP CONSTRAINT node_groups_rollout_concurrency_check;
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_rollout_concurrency_check CHECK (rollout_concurrency >= 1);
-- SQL comparisons with NULL intentionally impose no count limit; keep the
-- existing serialized membership triggers and explicit administrator limits.
ALTER TABLE compute.node_groups ADD CONSTRAINT node_groups_core_count_required
    CHECK (role <> 'appliance-core' OR max_managed_nodes IS NOT NULL);
ALTER TABLE compute.distributed_profile_certifications DROP CONSTRAINT distributed_profile_certifications_minimum_nodes_check;
ALTER TABLE compute.distributed_profile_certifications ADD CONSTRAINT distributed_profile_certifications_minimum_nodes_check CHECK (minimum_nodes >= 2);
ALTER TABLE compute.distributed_profile_certifications DROP CONSTRAINT distributed_profile_certifications_maximum_nodes_check;
ALTER TABLE compute.distributed_profile_certifications ADD CONSTRAINT distributed_profile_certifications_maximum_nodes_check CHECK (maximum_nodes >= 2);
ALTER TABLE compute.gang_lease_sets DROP CONSTRAINT gang_lease_sets_member_count_check;
ALTER TABLE compute.gang_lease_sets ADD CONSTRAINT gang_lease_sets_member_count_check CHECK (member_count >= 2);
