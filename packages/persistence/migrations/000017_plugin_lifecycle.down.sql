DROP TABLE plugins.migration_runs;
DROP TABLE plugins.runtime_slots;
DROP TABLE plugins.lifecycle_operations;

ALTER TABLE plugins.plugin_versions
DROP COLUMN failed_at,
DROP COLUMN retired_at,
DROP COLUMN activated_at,
DROP COLUMN staged_at,
DROP COLUMN health,
DROP COLUMN slot,
DROP COLUMN verified_import_id;

ALTER TABLE plugins.plugins
DROP CONSTRAINT plugins_active_slot_state_check,
DROP CONSTRAINT plugins_data_namespace_key,
DROP COLUMN data_retention_state,
DROP COLUMN data_namespace,
DROP COLUMN active_slot,
DROP COLUMN generation;
