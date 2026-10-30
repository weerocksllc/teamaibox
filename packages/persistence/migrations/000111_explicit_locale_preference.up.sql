-- Retain existing values. Older automatic sign-in writes are indistinguishable
-- from manual ones; do not infer user intent from a default or a locale value.
-- Existing browser manual preferences remain authoritative and are promoted
-- through the normal preference endpoint on the next interactive sign-in.
ALTER TABLE iam.identities
  ADD COLUMN preferred_locale_explicit boolean NOT NULL DEFAULT false;
