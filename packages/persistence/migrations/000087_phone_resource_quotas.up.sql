-- NULL means no administrator-imposed count limit. Actual storage and startup
-- resource admission remains mandatory. Preserve explicit administrator choices.
ALTER TABLE platform.phone_quotas ALTER COLUMN stored_limit DROP NOT NULL;
ALTER TABLE platform.phone_quotas ALTER COLUMN running_limit DROP NOT NULL;
UPDATE platform.phone_quotas SET stored_limit=NULL, running_limit=NULL,
  revision=revision+1, updated_at=clock_timestamp()
  WHERE revision=1 AND stored_limit=2 AND running_limit=2;
