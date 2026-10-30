-- UI rollback can leave this additive marker in place; this explicit schema
-- downgrade removes only the marker, never a saved language or account.
ALTER TABLE iam.identities DROP COLUMN preferred_locale_explicit;
