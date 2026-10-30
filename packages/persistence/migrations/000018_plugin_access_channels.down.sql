DROP TABLE plugins.compute_capability_registrations;
DROP TABLE plugins.delegated_user_tokens;

ALTER TABLE compute.model_profiles
DROP CONSTRAINT model_profiles_capability_id_id_key;

ALTER TABLE compute.worker_instances
DROP CONSTRAINT worker_instances_node_id_id_key,
DROP CONSTRAINT worker_instances_plugin_id_id_key;

ALTER TABLE iam.sessions
DROP CONSTRAINT sessions_identity_id_id_key;

ALTER TABLE plugins.plugin_versions
DROP CONSTRAINT plugin_versions_plugin_id_id_key;
