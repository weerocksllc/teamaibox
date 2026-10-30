-- Object size is bounded by the explicit transfer contract and storage,
-- not a second 64 MiB database ceiling. Range reads live for the attempt lease.
ALTER TABLE compute.external_object_grants
  DROP CONSTRAINT external_object_grants_maximum_bytes_check,
  DROP CONSTRAINT external_object_grants_maximum_uses_check,
  DROP CONSTRAINT external_object_grants_check;
ALTER TABLE compute.external_object_grants
  ALTER COLUMN maximum_uses TYPE bigint,
  ALTER COLUMN use_count TYPE bigint;
ALTER TABLE compute.external_object_grants
  ADD CONSTRAINT external_object_grants_maximum_bytes_check CHECK (maximum_bytes BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT external_object_grants_maximum_uses_check CHECK (maximum_uses BETWEEN 1 AND 9007199254740991),
  ADD CONSTRAINT external_object_grants_use_count_check CHECK (use_count BETWEEN 0 AND maximum_uses);
