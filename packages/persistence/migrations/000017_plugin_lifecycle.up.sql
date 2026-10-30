ALTER TABLE plugins.plugins
ADD COLUMN generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
ADD COLUMN active_slot text CHECK (active_slot IN ('blue', 'green')),
ADD COLUMN data_namespace text,
ADD COLUMN data_retention_state text NOT NULL DEFAULT 'retained' CHECK (
    data_retention_state = 'retained'
);

UPDATE plugins.plugins
SET data_namespace = 'plugin.' || plugin_key
WHERE data_namespace IS NULL;

ALTER TABLE plugins.plugins
ALTER COLUMN data_namespace SET NOT NULL,
ALTER COLUMN data_namespace SET DEFAULT ('plugin.' || uuidv7()::text),
ADD CONSTRAINT plugins_data_namespace_key UNIQUE (data_namespace),
ADD CONSTRAINT plugins_active_slot_state_check CHECK (
    (lifecycle_state IN ('enabled', 'disabled') AND current_version_id IS NOT NULL AND active_slot IS NOT NULL)
    OR (lifecycle_state IN ('discovered', 'uninstalled') AND current_version_id IS NULL AND active_slot IS NULL)
    OR lifecycle_state IN ('staged', 'failed')
);

ALTER TABLE plugins.plugin_versions
ADD COLUMN verified_import_id uuid UNIQUE REFERENCES plugins.verified_imports(id) ON DELETE RESTRICT,
ADD COLUMN slot text CHECK (slot IN ('blue', 'green')),
ADD COLUMN health jsonb CHECK (health IS NULL OR jsonb_typeof(health) = 'object'),
ADD COLUMN staged_at timestamptz,
ADD COLUMN activated_at timestamptz,
ADD COLUMN retired_at timestamptz,
ADD COLUMN failed_at timestamptz;

CREATE TABLE plugins.lifecycle_operations (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE RESTRICT,
    operation_key text NOT NULL CHECK (
        operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    operation_kind text NOT NULL CHECK (
        operation_kind IN ('install', 'upgrade', 'enable', 'disable', 'uninstall')
    ),
    status text NOT NULL DEFAULT 'running' CHECK (
        status IN ('running', 'succeeded', 'failed')
    ),
    stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9-]{1,63}$'),
    from_version text,
    to_version text,
    error_code text CHECK (
        error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,127}$'
    ),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (plugin_id, operation_key),
    CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
);

CREATE TRIGGER lifecycle_operations_touch_updated_at
BEFORE UPDATE ON plugins.lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE plugins.runtime_slots (
    plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE RESTRICT,
    slot text NOT NULL CHECK (slot IN ('blue', 'green')),
    plugin_version_id uuid NOT NULL REFERENCES plugins.plugin_versions(id) ON DELETE RESTRICT,
    slot_state text NOT NULL CHECK (
        slot_state IN ('staging', 'healthy', 'active', 'retired', 'failed')
    ),
    health jsonb CHECK (health IS NULL OR jsonb_typeof(health) = 'object'),
    generation bigint NOT NULL CHECK (generation > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (plugin_id, slot),
    UNIQUE (plugin_version_id)
);

CREATE TRIGGER runtime_slots_touch_updated_at
BEFORE UPDATE ON plugins.runtime_slots
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE plugins.migration_runs (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    plugin_id uuid NOT NULL REFERENCES plugins.plugins(id) ON DELETE RESTRICT,
    plugin_version_id uuid NOT NULL REFERENCES plugins.plugin_versions(id) ON DELETE RESTRICT,
    lifecycle_operation_id uuid NOT NULL REFERENCES plugins.lifecycle_operations(id) ON DELETE RESTRICT,
    migration_id text NOT NULL CHECK (
        migration_id ~ '^[0-9]{6}_[a-z][a-z0-9_]{2,63}$'
    ),
    sequence integer NOT NULL CHECK (sequence > 0),
    migration_state text NOT NULL CHECK (
        migration_state IN ('running', 'applied', 'committed', 'rolled_back', 'failed')
    ),
    transactional boolean NOT NULL,
    reversible boolean NOT NULL,
    error_code text CHECK (
        error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,127}$'
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (plugin_version_id, migration_id),
    UNIQUE (plugin_version_id, sequence)
);

CREATE TRIGGER migration_runs_touch_updated_at
BEFORE UPDATE ON plugins.migration_runs
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE INDEX lifecycle_operations_status_idx
ON plugins.lifecycle_operations (status, updated_at);

CREATE INDEX migration_runs_state_idx
ON plugins.migration_runs (migration_state, updated_at);
