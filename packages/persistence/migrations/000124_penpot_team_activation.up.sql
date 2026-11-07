-- A mapping is allocated before the native transaction. Only an acknowledged
-- native activation may be presented as openable in the platform picker.
ALTER TABLE design.team_mappings ADD COLUMN activated_at timestamptz;
