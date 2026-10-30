-- Refuse a rollback that would lose user names. Never truncate them.
ALTER TABLE platform.phones DROP CONSTRAINT phones_name_check;
ALTER TABLE platform.phones ADD CONSTRAINT phones_name_check
  CHECK (length(name) BETWEEN 1 AND 64 AND name=btrim(name) AND name !~ '[[:cntrl:]]');
