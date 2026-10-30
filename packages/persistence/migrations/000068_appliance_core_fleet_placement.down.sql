DROP INDEX compute.gang_lease_sets_placement_state_idx;
DROP INDEX compute.realtime_sessions_placement_state_idx;
DROP INDEX compute.lease_sets_placement_state_idx;

ALTER TABLE compute.gang_lease_sets
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_class;

ALTER TABLE compute.realtime_sessions
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_class;

ALTER TABLE compute.node_exclusive_intents
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_class;

ALTER TABLE compute.lease_sets
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_class;

DROP INDEX compute.worker_instances_placement_state_idx;
ALTER TABLE compute.worker_instances
    DROP CONSTRAINT worker_instances_recovery_reason_pair,
    DROP CONSTRAINT worker_instances_state_revision_order,
    DROP COLUMN recovery_reason_code,
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN observed_state_revision,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_class;

DROP INDEX compute.providers_placement_state_idx;
DROP TRIGGER providers_default_managed_placement ON compute.providers;
DROP FUNCTION compute.default_managed_provider_placement();
ALTER TABLE compute.providers
    DROP CONSTRAINT providers_recovery_reason_pair,
    DROP CONSTRAINT providers_state_revision_order,
    DROP CONSTRAINT providers_placement_kind_check,
    DROP COLUMN recovery_reason_code,
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN observed_state_revision,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_node_group_id,
    DROP COLUMN placement_class;

DROP INDEX compute.model_profiles_placement_state_idx;
DROP TRIGGER model_profile_placement_revisions_append_only
ON compute.model_profile_placement_revisions;
DROP TRIGGER model_profile_placement_revision_guard
ON compute.model_profile_placement_revisions;
DROP FUNCTION compute.reject_model_profile_placement_mutation();
DROP FUNCTION compute.enforce_model_profile_placement();
DROP TABLE compute.model_profile_placement_revisions;
ALTER TABLE compute.model_profiles
    DROP CONSTRAINT model_profiles_recovery_reason_pair,
    DROP CONSTRAINT model_profiles_state_revision_order,
    DROP COLUMN recovery_reason_code,
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN observed_state_revision,
    DROP COLUMN desired_state_revision,
    DROP COLUMN placement_node_group_id,
    DROP COLUMN placement_class;

DROP INDEX compute.nodes_group_role_state_idx;
ALTER TABLE compute.nodes
    DROP CONSTRAINT nodes_recovery_reason_pair,
    DROP CONSTRAINT nodes_state_revision_order,
    DROP COLUMN recovery_reason_code,
    DROP COLUMN recovery_state,
    DROP COLUMN maintenance_generation,
    DROP COLUMN observed_state_revision,
    DROP COLUMN desired_state_revision,
    DROP COLUMN desired_state,
    DROP COLUMN node_group_id,
    DROP COLUMN appliance_role;

DROP TABLE compute.node_group_memberships;
DROP TABLE compute.node_groups;
DROP FUNCTION compute.enforce_node_group_membership();
DROP FUNCTION compute.enforce_node_group_limit();
