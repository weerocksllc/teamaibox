DROP INDEX IF EXISTS platform.agent_sandbox_active_operations_idx;
DROP TABLE IF EXISTS platform.agent_sandbox_operations;
DROP INDEX IF EXISTS platform.agent_sandboxes_idle_idx;
DROP TRIGGER IF EXISTS agent_sandboxes_touch_updated_at ON platform.agent_sandboxes;
DROP TABLE IF EXISTS platform.agent_sandboxes;
