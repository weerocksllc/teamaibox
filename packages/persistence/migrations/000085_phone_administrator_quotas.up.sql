-- Keep existing administrator choices and phones. Remove development ceilings;
-- per-node runtime and storage admission still apply when a phone is started.
ALTER TABLE platform.phone_quotas DROP CONSTRAINT phone_quotas_stored_limit_check;
ALTER TABLE platform.phone_quotas DROP CONSTRAINT phone_quotas_check;
ALTER TABLE platform.phone_quotas ADD CONSTRAINT phone_quotas_stored_limit_check CHECK (stored_limit >= 0);
ALTER TABLE platform.phone_quotas ADD CONSTRAINT phone_quotas_check CHECK (running_limit >= 0 AND running_limit <= stored_limit);
