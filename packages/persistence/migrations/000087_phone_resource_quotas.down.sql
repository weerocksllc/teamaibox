-- Do not silently reinstate a test quota or stop/delete existing phones.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.phone_quotas WHERE stored_limit IS NULL OR running_limit IS NULL) THEN
    RAISE EXCEPTION 'Set explicit administrator quotas before reverting nullable quota support';
  END IF;
END $$;
ALTER TABLE platform.phone_quotas ALTER COLUMN stored_limit SET NOT NULL;
ALTER TABLE platform.phone_quotas ALTER COLUMN running_limit SET NOT NULL;
