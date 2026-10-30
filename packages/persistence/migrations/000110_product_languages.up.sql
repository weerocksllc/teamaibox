-- Expand presentation preferences only. No identities or application data change.
ALTER TABLE iam.identities DROP CONSTRAINT identities_preferred_locale_check;
ALTER TABLE iam.identities ADD CONSTRAINT identities_preferred_locale_check
  CHECK (preferred_locale IN ('zh-CN','zh-TW','en','ja','ko','fr','de','es','pt-BR','ru','ar','hi','id','it','tr','vi','th'));
