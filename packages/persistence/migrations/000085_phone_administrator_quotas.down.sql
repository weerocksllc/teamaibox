-- Refuse rollback when newer administrator choices cannot be represented;
-- never silently reduce quotas or stop/delete phones to satisfy old limits.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.phone_quotas WHERE stored_limit > 100 OR running_limit > 2) THEN
    RAISE EXCEPTION 'Administrator quotas exceed the old schema; rollback requires an explicit quota decision';
  END IF;
END $$;
ALTER TABLE platform.phone_quotas DROP CONSTRAINT phone_quotas_stored_limit_check;
ALTER TABLE platform.phone_quotas DROP CONSTRAINT phone_quotas_check;
ALTER TABLE platform.phone_quotas ADD CONSTRAINT phone_quotas_stored_limit_check CHECK (stored_limit BETWEEN 0 AND 100);
ALTER TABLE platform.phone_quotas ADD CONSTRAINT phone_quotas_check CHECK (running_limit BETWEEN 0 AND 2 AND running_limit <= stored_limit);
