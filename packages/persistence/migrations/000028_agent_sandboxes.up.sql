CREATE TABLE platform.agent_sandboxes (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    owner_identity_id uuid NOT NULL UNIQUE REFERENCES iam.identities(id) ON DELETE RESTRICT,
    worker_id uuid NOT NULL UNIQUE,
    sandbox_key text NOT NULL UNIQUE CHECK (sandbox_key ~ '^sandbox\.[a-f0-9]{32}$'),
    workspace_key text NOT NULL UNIQUE CHECK (workspace_key ~ '^workspace\.[a-f0-9]{32}$'),
    workspace_volume text NOT NULL UNIQUE CHECK (workspace_volume ~ '^teamaibox-agent-[a-f0-9]{32}-workspace$'),
    workspace_quota_bytes bigint NOT NULL CHECK (workspace_quota_bytes > 0),
    image_reference text NOT NULL CHECK (image_reference ~ '^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$'),
    runtime_fingerprint bytea NOT NULL CHECK (octet_length(runtime_fingerprint) = 32),
    state text NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped', 'starting', 'running', 'stopping', 'error')),
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    active_operations bigint NOT NULL DEFAULT 0 CHECK (active_operations >= 0),
    node_id uuid REFERENCES compute.nodes(id) ON DELETE SET NULL,
    container_id text,
    last_error_code text,
    last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    idle_deadline_at timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state = 'running' AND container_id IS NOT NULL AND node_id IS NOT NULL)
        OR (state <> 'running')),
    CHECK (active_operations = 0 OR state = 'running')
);

CREATE TRIGGER agent_sandboxes_touch_updated_at
BEFORE UPDATE ON platform.agent_sandboxes
FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE INDEX agent_sandboxes_idle_idx
ON platform.agent_sandboxes (idle_deadline_at, id)
WHERE state = 'running' AND active_operations = 0;

CREATE TABLE platform.agent_sandbox_operations (
    id uuid PRIMARY KEY,
    sandbox_id uuid NOT NULL REFERENCES platform.agent_sandboxes(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    released_at timestamptz,
    CHECK ((state = 'active' AND released_at IS NULL) OR (state = 'released' AND released_at IS NOT NULL))
);

CREATE INDEX agent_sandbox_active_operations_idx
ON platform.agent_sandbox_operations (sandbox_id, created_at)
WHERE state = 'active';
