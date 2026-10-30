DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM objects.multipart_parts WHERE part_number > 10000) THEN
    RAISE EXCEPTION 'Multipart uploads above the old capacity must finish before downgrade';
  END IF;
END $$;
ALTER TABLE objects.multipart_parts DROP CONSTRAINT multipart_parts_part_number_check;
ALTER TABLE objects.multipart_parts ALTER COLUMN part_number TYPE integer;
ALTER TABLE objects.multipart_parts ADD CONSTRAINT multipart_parts_part_number_check
  CHECK (part_number BETWEEN 1 AND 10000);
