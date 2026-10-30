ALTER TABLE objects.multipart_parts DROP CONSTRAINT multipart_parts_part_number_check;
ALTER TABLE objects.multipart_parts ALTER COLUMN part_number TYPE bigint;
ALTER TABLE objects.multipart_parts ADD CONSTRAINT multipart_parts_part_number_check
  CHECK (part_number BETWEEN 1 AND 9007199254740991);
