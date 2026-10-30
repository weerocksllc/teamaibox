-- Do not silently overwrite a user's selected language during rollback.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM iam.identities WHERE preferred_locale NOT IN ('zh-CN','en')) THEN
    RAISE EXCEPTION 'Cannot narrow languages while expanded locale preferences exist';
  END IF;
END $$;
ALTER TABLE iam.identities DROP CONSTRAINT identities_preferred_locale_check;
ALTER TABLE iam.identities ADD CONSTRAINT identities_preferred_locale_check
  CHECK (preferred_locale IN ('zh-CN','en'));
