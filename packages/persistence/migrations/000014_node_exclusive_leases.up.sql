ALTER TABLE compute.lease_sets
ADD COLUMN node_exclusive boolean NOT NULL DEFAULT false;

CREATE TABLE compute.node_exclusive_intents (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES compute.nodes(id) ON DELETE CASCADE,
    job_id uuid NOT NULL REFERENCES compute.jobs(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'acquired', 'cancelled', 'completed', 'expired')
    ),
    lease_set_id uuid UNIQUE REFERENCES compute.lease_sets(id) ON DELETE SET NULL,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deadline_at timestamptz NOT NULL,
    finished_at timestamptz,
    finish_reason text CHECK (
        finish_reason IS NULL OR finish_reason ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (deadline_at > requested_at),
    CHECK (
        (state IN ('pending', 'acquired') AND finished_at IS NULL AND finish_reason IS NULL)
        OR (state IN ('cancelled', 'completed', 'expired') AND finished_at IS NOT NULL AND finish_reason IS NOT NULL)
    ),
    CHECK (
        (state = 'acquired' AND lease_set_id IS NOT NULL)
        OR state <> 'acquired'
    )
);

CREATE UNIQUE INDEX node_exclusive_intents_one_active_node_idx
ON compute.node_exclusive_intents (node_id)
WHERE state IN ('pending', 'acquired');

CREATE UNIQUE INDEX node_exclusive_intents_one_active_job_idx
ON compute.node_exclusive_intents (job_id)
WHERE state IN ('pending', 'acquired');

CREATE INDEX node_exclusive_intents_expiry_idx
ON compute.node_exclusive_intents (deadline_at)
WHERE state = 'pending';

CREATE TRIGGER node_exclusive_intents_touch_updated_at
BEFORE UPDATE ON compute.node_exclusive_intents
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
