DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.phone_feature_policy) THEN
    RAISE EXCEPTION 'Cannot discard an existing virtual phone feature policy';
  END IF;
END $$;
DROP TABLE platform.phone_feature_policy;
