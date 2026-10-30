-- Never truncate grants or delete data to fit the older schema.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM compute.external_object_grants WHERE maximum_bytes>67108864 OR maximum_uses>4096) THEN
    RAISE EXCEPTION 'Existing transfer grants do not fit the old capacity schema';
  END IF;
END $$;
ALTER TABLE compute.external_object_grants
  DROP CONSTRAINT external_object_grants_maximum_bytes_check,
  DROP CONSTRAINT external_object_grants_maximum_uses_check,
  DROP CONSTRAINT external_object_grants_use_count_check;
ALTER TABLE compute.external_object_grants
  ALTER COLUMN maximum_uses TYPE integer,
  ALTER COLUMN use_count TYPE integer;
ALTER TABLE compute.external_object_grants
  ADD CONSTRAINT external_object_grants_maximum_bytes_check CHECK (maximum_bytes BETWEEN 1 AND 67108864),
  ADD CONSTRAINT external_object_grants_maximum_uses_check CHECK (maximum_uses BETWEEN 1 AND 4096),
  ADD CONSTRAINT external_object_grants_check CHECK (use_count BETWEEN 0 AND maximum_uses);
