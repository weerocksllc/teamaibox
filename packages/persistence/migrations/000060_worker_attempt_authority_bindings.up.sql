ALTER TABLE compute.worker_instances
ADD COLUMN attempt_bindings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(attempt_bindings) = 'object'
),
ADD COLUMN binding_revision bigint NOT NULL DEFAULT 0 CHECK (
    binding_revision >= 0
);

COMMENT ON COLUMN compute.worker_instances.attempt_id IS
'Immutable bootstrap attempt recorded on the container; current execution authority is held in attempt_bindings.';

COMMENT ON COLUMN compute.worker_instances.attempt_bindings IS
'Ephemeral attempt lease/fence bindings. Entries must be removed as soon as the attempt reaches a terminal state.';

